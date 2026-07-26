# build — the graph pipeline (runs locally, not deployed)

Turns OSM + swissALTI3D into the R2 artefacts: `graph.bin` (v2), `network.pmtiles`,
`meta.json`. Develop against a small `--region`; the Switzerland run is overnight.

```bash
pip install -r build/requirements-build.txt        # pyrosm, rasterio, ...
python build/build_graph.py --region test-oberland --pbf switzerland-latest.osm.pbf
# then, in WSL: tippecanoe -o out/.../network.pmtiles -l network -zg \
#                          --drop-densest-as-needed out/.../network.geojson
```

## Stages

| module | step | pure core (unit-tested) | I/O shell (run-time) |
|---|---|---|---|
| `osm_load.py` | PBF → bike network | highway allowlist, one-way + `oneway:bicycle` rules, surface classification, access | `pyrosm` PBF read |
| `dem.py` | elevation | 10 m resample, profile integration (ascent = ∫, **not** endpoint Δh), rolling max-slope, f32-endpoint pinning | swissALTI3D STAC download + `rasterio` |
| `collapse.py` | degree-2 merge | chain contraction, ascent/descent summed, surface/one-way/boundary rules | — |
| `export.py` | → `graph.bin` v2 | contiguous ids, directed halves, CSR + grid + surface, Douglas-Peucker, hard validation | file writes |
| `build_graph.py` | orchestrate | region resolution, resumable stage cache | pyrosm/DEM/tippecanoe/wrangler |

The correctness-critical logic is pure and covered by the unit suite; only the
loader, DEM sampler, tippecanoe and the R2 upload touch real data. A synthetic
end-to-end test (`tests/test_pipeline_e2e.py`) runs a hand-built network through
`measure → collapse → export` to a validated, routable `graph.bin` — proving the
stages compose without any download.

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
