# worker — VeloRouter routing API

Cloudflare Worker. Loads `graph.bin` from R2 once per isolate, holds it in typed
arrays, and answers routing queries. All compute lives in dependency-free,
fully-tested modules; this deployable is a thin shell over them.

## Layout

| file | role |
|---|---|
| `src/binformat.ts` | zero-copy `graph.bin` reader (mirrors `build/binformat.py`) |
| `src/geo.ts`, `src/heap.ts` | geodesy + array binary heap |
| `src/router.ts` | Dijkstra / A* / effort-field / snap, over flat typed arrays |
| `src/protocol.ts` | request parsing, cost-model resolution, binary response |
| `src/handlers.ts` | one function per endpoint + the dispatcher |
| `src/graphStore.ts` | isolate-scoped load-and-cache |
| `src/index.ts` | Worker entry: R2 binding + cache + dispatch |

## Cost model (spec v1.1)

`cost = dist/v_flat + ascent/vam` seconds. The request carries `v_flat` and `vam`
in **m/s** (the frontend converts km/h and Hm/h). Steepness is a hard filter
only, never a cost term. `metric` defaults to `"time"`; the field exists so a
future bottleneck `minimax` can be added without an API break.

## Endpoints

### `POST /effort-field`
```json
{ "lat": 46.9, "lon": 7.45, "v_flat": 7.5, "vam": 0.194,
  "max_slope": 10, "max_cost": 28800, "metric": "time" }
```
`max_cost` in seconds (default 8 h). Response is **binary**, little-endian: a
32-byte header (`magic "VEFF"`, version, count, snapped node + its lat/lon, max
time, max cum_ascent) then three parallel arrays — `edge_id u32[]`, `time f32[]`,
`cum_ascent f32[]`. Struct-of-arrays so the client makes zero-copy typed views.

### `POST /route`
```json
{ "from": {"lat":46.9,"lon":7.45}, "to": {"lat":46.95,"lon":7.5},
  "v_flat": 7.5, "vam": 0.194, "max_slope": 10 }
```
JSON: `{found, from_snapped, to_snapped, cost_s, dist_m, ascent_m, descent_m,
max_slope_pct, edge_ids, nodes}`. Unreachable ends → `{found:false}` with the
snapped endpoints still echoed.

### `GET /snap?lat=&lon=`
JSON `{node, lat, lon}` — the nearest graph node and its coordinates.

### `GET /health`
JSON `{ok, region, nodes, edges}`.

Fallback: if a request omits `v_flat`/`vam` but sends `alpha`, the internal
`cf = 8·α/(1−α)` (cap 200) distance-equivalent model is used.

## Local run

All application logic is covered by `npm test` with the Ridge-World graph and no
Cloudflare mock. `wrangler dev` additionally exercises the real runtime + R2
wiring. Because `wrangler`/R2 commands touch Cloudflare, run them yourself:

```bash
# one-time: create the bucket (deployed use)
wrangler r2 bucket create velorouter-graph

# seed the LOCAL R2 simulation with the Ridge-World fixture
npm run seed:local

# start the local dev server
npm run dev

# then, in another shell:
curl 'http://localhost:8787/health'
curl 'http://localhost:8787/snap?lat=46.5&lon=8.03'
curl -X POST http://localhost:8787/route \
  -H 'content-type: application/json' \
  -d '{"from":[46.5,8.0],"to":[46.52,8.06],"v_flat":7.5,"vam":0.194}'
curl -X POST http://localhost:8787/effort-field \
  -H 'content-type: application/json' \
  -d '{"lat":46.5,"lon":8.03,"v_flat":7.5,"vam":0.194}' --output field.bin
```

Deploy (after uploading the real `graph.bin` to R2):
```bash
npm run deploy
```
