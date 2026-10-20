# Contributing to isobike

Thanks for having a look. Issues, ideas and pull requests are all welcome,
whether you ride, code, or know your way around map data.

## Ways to help

- **Ride and report.** A road that is coloured wrong, a climb that is far too
  steep or too flat, a route that takes a strange detour: open an issue with the
  start point, the settings and a screenshot. Wrong slopes usually trace back to
  OSM tags (bridges, tunnels) or the elevation data, and every report helps.
- **Fix OpenStreetMap.** Missing `bridge=*`, `tunnel=*`, `surface=*` or
  `bicycle=*` tags show up directly here after the next rebuild.
- **Code.** Open issues are a good start. Larger ideas from [specs.md](specs.md)
  that are not built yet: a physics-based speed model, POIs along the route,
  regions beyond Switzerland.
- **Design.** The map styles and panels are young. Proposals with a sketch or
  screenshot are very welcome.

Please open an issue before a large change, so we can agree on the approach first.

## Running it locally

You need Node 22, and Python 3.11+ only if you rebuild the data.

```powershell
# 1. data: download the four files from the Google Drive folder
#    (see deploy/README.md) into build/out/switzerland/,
#    or build them yourself (build/README.md, ~1 h nationwide)

# 2. routing API (Cloudflare Worker locally; reads the data from local R2)
cd worker
npm install
npx wrangler r2 object put velorouter-graph-dev/graph.bin    --file ../build/out/switzerland/graph.bin    --local
npx wrangler r2 object put velorouter-graph-dev/geometry.bin --file ../build/out/switzerland/geometry.bin --local
npx wrangler dev --port 8787

# 3. map tiles (second terminal, repo root)
npx -y http-server build/out/switzerland -p 8788 --cors

# 4. frontend (third terminal)
cd frontend
npm install
npm run dev            # http://localhost:5173
```

Or run the production API instead of the Worker:
`cd server && npm install && npm run build && DATA_DIR=../build/out/switzerland PORT=8787 npm start`.

## Repository

| directory | what |
|---|---|
| [build/](build/) | Python pipeline: OSM + swissALTI3D → `graph.bin`, `geometry.bin`, `network.pmtiles` |
| [worker/](worker/) | routing core in TypeScript (Dijkstra/A*, effort field, route geometry) |
| [server/](server/) | the routing API on Node, as deployed |
| [frontend/](frontend/) | React + MapLibre app |
| [deploy/](deploy/) | data files, server setup, releases, secrets |
| [testdata/](testdata/) | Ridge World fixture: golden files shared by the Python and TypeScript tests |

## Before a pull request

```powershell
python -m pytest              # repo root: pipeline + golden files
cd worker;   npx tsc --noEmit; npx vitest run
cd frontend; npx tsc --noEmit; npx vitest run
```

The same suites run on every release. A few conventions:

- `build/binformat.py` and `worker/src/binformat.ts` implement the same binary
  format. Change both together and regenerate the golden files
  (`testdata/README.md`).
- Steepness is a filter, never a cost. The cost model stays
  `dist / v_flat + ascent / vam`.
- Keep the code style of the file you are in, including its comments.
