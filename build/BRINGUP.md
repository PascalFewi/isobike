# VeloRouter bring-up checklist

From "code is done + verified on real data" → a deployed app you can click.
Everything below is **yours to run** (Cloudflare, downloads, deploy); the code is
complete and unit-tested. Replace `<angle-bracket>` placeholders with your values.

Order matters: do a **test region end-to-end first** (Phases 0–2, ~30 min), see it
work locally, *then* do the national build + deploy (Phases 3–4).

---

## Phase 0 — Cloudflare setup (once, ~15 min)

> **wrangler** is already installed inside `worker/` as a dependency, so run every
> `wrangler …` command below from the `worker/` directory as `npx wrangler …`
> (as written). No global install, no PowerShell PATH fuss. (Prefer global?
> `npm i -g wrangler`, then open a **new** terminal and drop the `npx`.)

- [ ] **Workers Paid** ($5/mo). Free tier caps CPU at 10 ms; a nationwide Dijkstra
      needs a few hundred ms. Dashboard → Workers & Pages → Plans → Paid.
- [ ] **Authenticate first** (must precede any r2/deploy command):
      ```bash
      cd worker
      npx wrangler login          # opens a browser
      ```
- [ ] **Enable R2 on the account** (one-time, dashboard-only). Dashboard → **R2** →
      *Enable / Purchase R2* → accept terms + add a payment method. Free tier is
      10 GB storage with **no egress fees**; wrangler can't flip this for you, and
      `bucket create` fails with `code 10042` until it's on.
- [ ] **Create the R2 bucket** (from `worker/`, after R2 is enabled):
      ```bash
      npx wrangler r2 bucket create velorouter-graph
      ```
      Holds `graph.bin` (Worker reads it) and `network.pmtiles` (browser reads it).
- [ ] **R2 S3 credentials** (for headless upload from the build machine): Dashboard
      → R2 → *Manage R2 API Tokens* → create a token with **Object Read & Write**.
      Note: **Access Key ID**, **Secret Access Key**, and your account **endpoint**
      `https://<account-id>.r2.cloudflarestorage.com`.

✓ success: `npx wrangler r2 bucket list` (from `worker/`) shows `velorouter-graph`.

---

## Phase 1 — Build the TEST region (anywhere, ~minutes)

GLO-30 keeps this small, so a laptop, Colab, or a throwaway VPS all work. Needs
Linux for `run_build.sh` (or WSL on Windows for the tippecanoe step).

- [ ] On the build machine, from the repo root:
      ```bash
      REGION=test-oberland bash build/run_build.sh
      ```
      This installs deps, downloads `switzerland-latest.osm.pbf` (~400 MB, once,
      cached), bbox-filters to the Thun–Interlaken test area, builds, and runs
      tippecanoe.
- [ ] Check the outputs:
      ```bash
      ls -lh build/out/test-oberland/          # graph.bin, network.pmtiles, meta.json
      cat build/out/test-oberland/meta.json    # node_count / geom_edge_count non-zero?
      ```

✓ success: `meta.json` shows a few thousand+ nodes and edges, and all three files exist.

> On Windows without WSL: run `python -m build.build_graph --region test-oberland
> --pbf <path-to>.osm.pbf --dem glo30`, then run the `tippecanoe …` line it prints
> inside WSL.

---

## Phase 2 — Local bring-up + first visual test (test region)

See it work locally before deploying anything.

- [ ] **Seed the local Worker's R2** with the test graph:
      ```bash
      cd worker
      npx wrangler r2 object put velorouter-graph/graph.bin \
        --file ../build/out/test-oberland/graph.bin --local
      ```
- [ ] **Start the Worker:**
      ```bash
      npx wrangler dev            # http://localhost:8787
      # in another shell:
      curl http://localhost:8787/health
      ```
      ✓ success: JSON with `"region":"test-oberland"` and non-zero node/edge counts.
- [ ] **Serve the PMTiles** (browser needs range requests + CORS):
      ```bash
      npx -y http-server build/out/test-oberland -p 8788 --cors
      ```
- [ ] **Frontend:**
      ```bash
      cd frontend && npm install
      printf 'VITE_WORKER_URL=http://localhost:8787\nVITE_PMTILES_URL=http://localhost:8788/network.pmtiles\n' > .env.local
      npm run dev             # http://localhost:5173
      ```
- [ ] Open http://localhost:5173, **pan to Thun/Interlaken**, and **click the map**.

✓ success: first click → the roads colour by reach time; second click → a red
route + stats panel; Profil/slope/surface sliders re-fetch, Fitness/budget restyle
instantly.

---

## Phase 3 — National build (on a VPS or Colab; hours, resumable)

GLO-30 makes this hours, not an overnight 40 GB job. A short-term Linux VPS is
ideal (persistent disk = the cache survives; no session cap; native tippecanoe).

- [ ] Run with the R2 upload env vars set, so it pushes straight to R2:
      ```bash
      REGION=switzerland \
      R2_BUCKET=velorouter-graph \
      R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
      AWS_ACCESS_KEY_ID=<r2-access-key> \
      AWS_SECRET_ACCESS_KEY=<r2-secret> \
      bash build/run_build.sh
      ```
      (Interrupted? Re-run the same line — the OSM/DEM stages resume from
      `build/cache/`.)

✓ success: `graph.bin`, `meta.json`, `network.pmtiles` are in the `velorouter-graph`
bucket; `network.pmtiles` is ~15–25 MB, `graph.bin` ~50–80 MB.

---

## Phase 4 — Deploy

- [ ] **Make the PMTiles publicly readable + CORS-enabled** (the browser fetches it
      cross-origin with range requests):
      - Dashboard → R2 → `velorouter-graph` → Settings → **enable public access**
        (gives an `r2.dev` URL) *or* connect a custom domain. Note the public URL:
        `<pmtiles-public-url>/network.pmtiles`.
      - Same Settings page → **CORS policy** → allow your Pages origin (or `*` for
        v1) with `GET` and the `Range` header. **Without this the map stays blank.**
      - `graph.bin` may stay private — the Worker reads it via its binding.
- [ ] **Deploy the Worker:**
      ```bash
      cd worker && npx wrangler deploy
      curl https://velorouter-worker.<your-subdomain>.workers.dev/health
      ```
      ✓ success: the deployed `/health` returns the CH region + counts. Watch
      `npx wrangler tail` on the first real request to confirm it doesn't OOM (the graph
      loads once per isolate; ~50–80 MB fits the 128 MB limit).
- [ ] **Deploy the frontend to Pages:**
      ```bash
      cd frontend
      printf 'VITE_WORKER_URL=https://velorouter-worker.<your-subdomain>.workers.dev\nVITE_PMTILES_URL=<pmtiles-public-url>/network.pmtiles\n' > .env.production
      npm run build
      npx wrangler pages deploy dist --project-name velorouter
      ```
- [ ] Open the Pages URL and click the map.

✓ success: the live map colours by effort and routes across Switzerland.

---

## Gotchas (the ones that actually bite)

- **Blank map after deploy → almost always R2 CORS.** The browser's range request
  for `network.pmtiles` needs a CORS policy allowing your Pages origin + `Range`.
- **No colouring, tiles visible → layer/id mismatch.** tippecanoe must run with
  `-l network` (it does in `run_build.sh`), and the effort join keys on the
  `edge_id` property → feature id via `promoteId` (already set in `mapStyle.ts`).
- **Worker 503 `graph unavailable`** → `graph.bin` isn't in the bucket, or the
  `bucket_name` in `worker/wrangler.toml` doesn't match. Locally, re-seed with
  `--local`.
- **Worker OOM on the national graph** → unlikely (~50–80 MB), but if it happens
  the format has a versioned header for a v2 slim layout (drop `edge_descent`, or
  u16 fixed-point) — tell me and I'll ship it.
- **CPU limit** → `wrangler.toml` sets `cpu_ms = 30000`; an 8 h effort field is
  ~250 ms, so there's huge headroom.

## Where I can still help

Fixing anything that breaks on a real run (pyrosm quirks on the full CH extract,
tile edge cases, a slim v2 layout if memory is tight), adjusting the initial map
view/basemap, or the R2 CORS/Pages config. The pipeline is verified on real data,
but the *first full national run* is the real shakedown — ping me with any output.
