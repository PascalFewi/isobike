# frontend — VeloRouter map UI (React + Vite + MapLibre, CF Pages)

Click a start → the map colours every road by **time to reach** (viridis bands,
colour-blind-safe), with a second darker channel for **cumulative ascent**. Click
again → a route with stats. Two speed sliders replace the old α.

## Run

```bash
npm install
# point at your Worker + tiles (defaults assume wrangler dev on :8787):
echo 'VITE_WORKER_URL=https://velorouter-worker.<you>.workers.dev' > .env.local
echo 'VITE_PMTILES_URL=https://<r2-public>/network.pmtiles' >> .env.local
npm run dev            # http://localhost:5173
npm run build          # tsc + vite build (CF Pages output in dist/)
npm test               # pure-logic unit tests
```

Needs a running Worker (`worker/`, or `wrangler dev`) and a `network.pmtiles`
(from the `build/` pipeline). Until both exist, `npm run dev` loads but shows an
empty map.

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
enforced in `lib/profile.ts` and `MapView.tsx`, and asserted in the tests; the
panel is colour-coded (blue = Worker call, green = client-side) so the boundary
stays visible.

## How the effort colouring joins

The Worker returns `(edge_id → time, cum_ascent)`; `MapView` pushes it onto the
PMTiles line features via `setFeatureState` (the source uses `promoteId` so
`edge_id` is the feature id). Paint expressions read `feature-state`. The route
reuses the same tiles — `/route` returns `edge_id`s, highlighted via a second
feature-state, so no geometry is shipped back.

## Not in v1 (spec)

Search/geocoding, turn-by-turn, via points, GPX, accounts, offline. A basemap is
left to config — v1 keeps the network the sole layer so the colouring reads clean.
