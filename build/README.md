# build — the graph pipeline (runs anywhere, not deployed)

Turns OSM + a DEM into the R2 artefacts: `graph.bin` (v2), `network.pmtiles`,
`meta.json`. Both data adapters are implemented and **verified on real OSM + real
DEM** (a real routable `graph.bin` built from a live extract).

## Run anywhere — your laptop never needs the data

The heavy part is DEM tiles. By defaulting to **Copernicus GLO-30** (~30 m,
global, a few hundred MB) instead of swissALTI3D 2 m (~40 GB), the whole build
fits a laptop, a Colab session, or a throwaway VPS. One script does it all —
deps, OSM download, build, tippecanoe, and (optionally) the R2 upload:

```bash
# VPS / Colab (`!bash build/run_build.sh`):
REGION=test-oberland bash build/run_build.sh                    # small, minutes
REGION=switzerland   bash build/run_build.sh                    # national
# national + push to R2:
REGION=switzerland R2_BUCKET=velorouter-graph R2_ENDPOINT=https://<acct>.r2.cloudflarestorage.com \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... bash build/run_build.sh
```

Or drive the stages directly:

```bash
pip install -r build/requirements-build.txt
python -m build.build_graph --region test-oberland --pbf switzerland-latest.osm.pbf --dem glo30
tippecanoe -o out/.../network.pmtiles -l network -zg --drop-densest-as-needed out/.../network.geojson
```

`--dem swissalti3d` opts into the 2 m CH DEM later if 30 m slopes prove too coarse
(that adapter is a documented shell; GLO-30 is the default and is implemented).

A short-term Linux VPS beats Colab for a full national run: persistent disk (the
resumable cache survives), no session cap, native tippecanoe. Colab is fine for
the test region or a GLO-30 national run.

## Stages

| module | step | pure core (unit-tested) | I/O shell (run-time) |
|---|---|---|---|
| `osm_load.py` | PBF → bike network | highway allowlist, one-way + `oneway:bicycle` rules, surface classification, access | `pyrosm` PBF read |
| `dem.py` | elevation | 10 m resample, profile integration (ascent = ∫, **not** endpoint Δh), rolling max-slope, f32-endpoint pinning | swissALTI3D STAC download + `rasterio` |
| `collapse.py` | degree-2 merge | chain contraction, ascent/descent summed, surface/one-way/boundary rules | — |
| `export.py` | → `graph.bin` v2 | contiguous ids, directed halves, CSR + grid + surface, Douglas-Peucker, hard validation | file writes |
| `build_graph.py` | orchestrate | region resolution, resumable stage cache | pyrosm/DEM/tippecanoe/wrangler |

The correctness-critical logic is pure and covered by the unit suite; only the
loader, DEM sampler, tippecanoe and the R2 upload touch real data. Two proofs:

- **Synthetic** — `tests/test_pipeline_e2e.py` runs a hand-built network through
  `measure → collapse → export` to a validated, routable `graph.bin`, no download.
- **Real** — the pyrosm loader and the GLO-30 sampler were verified against a live
  OSM extract + a real Copernicus tile, producing a real routable `graph.bin`.
  (This isn't in the unit suite — it needs network + GDAL — but it's why the two
  adapters are implemented, not stubbed.)

## Resolved design decisions (see specs.md)

- **One-ways respected, with bicycle exceptions** — `oneway=yes` blocks the reverse
  unless `oneway:bicycle=no`; contraflow cycleways re-open it. `FLAG_ONEWAYS_RESPECTED` set.
- **Gravel-inclusive network + per-edge surface (format v2)** — surface classified
  into `unknown/paved/gravel/unpaved`, stored in `graph.bin` and on the PMTiles
  features, so the frontend/worker can filter road vs gravel.

## Resumable cache

`build/cache/<region>/{raw,measured}.pkl` hold the two slow stages; a re-run reuses
them unless `--force`. DEM tiles cache under `build/cache/<region>/dem/`. Both are
git-ignored.
