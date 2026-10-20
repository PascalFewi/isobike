# build — the graph pipeline (runs anywhere, not deployed)

Turns OSM + a DEM into the R2 artefacts: `graph.bin` (v2), `network.pmtiles`,
`meta.json`. Both data adapters are implemented and **verified on real OSM + real
DEM** (a real routable `graph.bin` built from a live extract).

## Run anywhere — your laptop never needs the data

The heavy part is DEM tiles. The default is **swissALTI3D 2 m** (bare earth,
CH, ~35 k tiles / ~30-40 GB, downloaded in parallel and cached; ~1 h on a fast
connection). `DEM=glo30` (Copernicus, ~30 m, a few hundred MB) still fits a
Colab session, but it is a *surface* model -- trees and roofs show up as fake
climbs -- so use it only for quick experiments. One script does it all — deps,
OSM download, build, tippecanoe, and (optionally) the R2 upload:

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
python -m build.build_graph --region test-oberland --pbf switzerland-latest.osm.pbf
tippecanoe -o out/.../network.pmtiles -l network -zg --drop-densest-as-needed out/.../network.geojson
```

Points outside swissALTI3D coverage (border strips of the Geofabrik extract)
fall back to GLO-30.

A desktop with WSL, or a short-term Linux VPS, beats Colab for a full national
run: persistent disk (the resumable cache survives), no session cap, native
tippecanoe. Peak memory is ~20 GB for Switzerland.

## Stages

| module | step | pure core (unit-tested) | I/O shell (run-time) |
|---|---|---|---|
| `osm_load.py` | PBF → bike network | highway allowlist, one-way + `oneway:bicycle` rules, surface classification, access, bridge/tunnel | `pyrosm` PBF read |
| `collapse.py` | degree-2 merge | chain contraction, surface/highway/bridge-tunnel/one-way boundary rules, component pruning | — |
| `dem.py` | elevation | 10 m resample, profile integration (ascent = ∫, **not** endpoint Δh), 200 m rolling max-slope over the *merged* road, straight profiles on bridges/tunnels, f32-endpoint pinning; vectorised with numpy | swissALTI3D STAC download (GLO-30 fallback) + `rasterio` |
| `export.py` | → `graph.bin` v2 | contiguous ids, directed halves, CSR + grid + surface, Douglas-Peucker, hard validation | file writes |
| `build_graph.py` | orchestrate | region resolution, resumable stage cache | pyrosm/DEM/tippecanoe/wrangler |

The correctness-critical logic is pure and covered by the unit suite; only the
loader, DEM sampler, tippecanoe and the R2 upload touch real data. Two proofs:

- **Synthetic** — `tests/test_pipeline_e2e.py` runs a hand-built network through
  `collapse → measure → export` to a validated, routable `graph.bin`, no download.

Stage order matters: OSM segments are ~10 m, so collapsing *before* measuring is
what lets the 200 m slope window smooth anything (see `collapse.py`).
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

`build/cache/<region>/{raw-v2,measured-<dem>-v2}.pkl` hold the two slow stages; a
re-run reuses them unless `--force` (delete `measured-*.pkl` after changing the
measuring code). DEM tiles cache under `build/cache/dem/` (swissALTI3D in
`build/cache/dem/swissalti3d/`, with its STAC tile index). Both are
git-ignored.
