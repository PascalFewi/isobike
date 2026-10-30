# frontend — VeloRouter map UI (React + Vite + MapLibre, CF Pages)

Click a start → the map shows how far you get in the time budget: isolines at the
time-band edges over a soft coloured area. Click again → a route with stats, its
surface (asphalt / gravel / natural path) and an elevation profile. On the map:
road types (cycle path, quiet road, main road, gravel, MTB path) and cycling POIs
(water, bike service, food, lodging), both switchable in the map menu.

The basemap is a vector style loaded from `VITE_BASEMAP_STYLE_URL` -- OpenFreeMap's
Positron by default (Europe-wide, free, no key); our layers are added on top, the
reach and road types below its labels.

## Run

```bash
npm install
# point at your Worker + POI tiles (defaults: API on :8787, tiles on :8788):
echo 'VITE_WORKER_URL=https://velorouter-worker.<you>.workers.dev' > .env.local
echo 'VITE_POIS_URL=https://<host>/pois.pmtiles' >> .env.local
npm run dev            # http://localhost:5173
npm run build          # tsc + vite build (CF Pages output in dist/)
npm test               # pure-logic unit tests
```

Needs a running Worker (`worker/`, or `wrangler dev`). Without it the map loads
but shows no reach; without `network.pmtiles` / `pois.pmtiles` (from `build/`) it
shows no road types / POIs.

## What is tested vs. what you verify

The **pure logic** is unit-tested (`npm test`): the VEFF binary parser (checked
against a fixture emitted by the Worker's own serializer), the Profil/Fitness
math, the time-band colour scale, the 200 m width maths, and the API request
building. The **map itself** (MapLibre/WebGL) is verified in the browser — tests
can't drive a real canvas.

## Two controls, and the network boundary

| control | effect | network? |
|---|---|---|
| **Profil** (Flachfahrer ↔ Bergfahrer) | sets v_flat : vam → route choice | **Worker call** |
| Max. Steigung | slope hard-filter | **Worker call** |
| Untergrund (Road/Gravel) | surface filter (`surfaces`) | **Worker call** |
| **Fitness** (0.7×–1.3×) | scales both speeds → rescales times only | client-side |
| Zeit-Budget | display cutoff | client-side |
| Flach-km toggle | relabels bands | client-side |

Fitness scaling both speeds equally leaves the optimal route unchanged (every cost
divides by the same factor), so it is a pure restyle — never a re-route. This is
enforced in `lib/profile.ts` and `MapView.tsx`, and asserted in the tests.

## How reach is drawn

`/effort-field` is asked for min-time grids only (`grid_km: [1, 0.25]`,
`edges: false`): the minimum reach time per cell, cropped to the reached area --
tens to a few hundred kB. `lib/isolines.ts` smooths each grid, traces the band
edges (marching squares) and paints the area; the 1 km level shows zoomed out,
the 250 m level from zoom 9 in. Speed and budget redraw client-side.

Earlier versions coloured every reached road through `setFeatureState` on the
network tiles. That shipped 12 bytes per reached road (6 MB for a 4 h budget)
and stamped every tile on every pan, which is what made the map slow.

## Not in v1 (spec)

Search/geocoding, turn-by-turn, via points, GPX, accounts, offline. A basemap is
left to config — v1 keeps the network the sole layer so the colouring reads clean.
