# deploy — data and the Hetzner server

How the live site is put together: where the data files live, how the server is
set up once, and how a GitHub release deploys the app.

```
browser ── Caddy :80/:443 ──┬─ /            frontend (static, current release)
                            ├─ /data/*      network.pmtiles, meta.json (range requests)
                            └─ /api/*  ──── Node routing API on 127.0.0.1:8080
                                             (one thread per core, graph in memory,
                                              geometry.bin read by range)
```

| file here | what |
|---|---|
| [setup-server.sh](setup-server.sh) | one-time setup of a fresh Ubuntu 24.04 server |
| [fetch-data.sh](fetch-data.sh) | downloads the data files from Google Drive |
| [activate.sh](activate.sh) | switches to an uploaded release; rolls back if the health check fails |
| [Caddyfile](Caddyfile) | web server: frontend, public data, `/api` → Node, TLS once there is a domain |
| [isobike.service](isobike.service) | systemd unit for the routing API |
| [../.github/workflows/release.yml](../.github/workflows/release.yml) | test, build and deploy on a published release |

## Data

The data files are too big for git (~350 MB). They live in this Google Drive
folder, shared read-only with anyone who has the link:

**https://drive.google.com/drive/folders/1L97boYC-ZaGXpImwEYwdY6MKjwFfNcEx**

Upload exactly these four files from `build/out/switzerland/` after each
national build, replacing the old ones (same names; directly in the folder or in
one subfolder such as `switzerland/`, but each file name only once, since the
download script takes the first match):

| file | size | used by | public on the site |
|---|---|---|---|
| `graph.bin` | ~110 MB | routing API: the routing graph (nodes, directed edges, slopes, surfaces) | no |
| `geometry.bin` | ~195 MB | routing API: full route lines with elevation (map line, GPX, elevation profile) | no |
| `network.pmtiles` | ~45 MB | browser: the road network as vector tiles | yes, `/data/network.pmtiles` |
| `meta.json` | <1 KB | build date, counts, bounding box | yes, `/data/meta.json` |

Do **not** upload `network.geojson` (~430 MB; only an input for tippecanoe) or
anything from `build/cache/` (OSM extract, ~35 GB of DEM tiles, stage caches:
all re-downloadable or rebuildable).

All four files must come from **the same build**: edge ids are shared between
`graph.bin`, `geometry.bin` and the tiles, and mixing builds paints colours on
the wrong roads. `meta.json` carries the build date to check.

The server pulls them with `sudo bash /opt/isobike/bin/fetch-data.sh` and then
needs `sudo systemctl restart isobike`. The folder sharing must stay on
"Anyone with the link: Viewer" for that download to work.

**Licences.** The network is derived from © OpenStreetMap contributors and is
available under the [ODbL](https://opendatacommons.org/licenses/odbl/); the
derived files above are offered under the same licence. Elevation: swissALTI3D ©
swisstopo (open government data), Copernicus GLO-30 (© DLR/Airbus, ESA) outside
Switzerland. The basemap is swisstopo's grey national map.

## Releases deploy the app

**Publishing a GitHub release whose tag is on the default branch** (`master`;
renaming it to `main` later works unchanged) runs all tests, builds the frontend
and the API server, copies them to the server over SSH and switches to them. A
failed health check rolls back to the previous release. Prereleases and tags not
on the default branch are never deployed.

### One-time server setup

1. Create a Hetzner Cloud server: Ubuntu 24.04, at least 4 GB RAM (e.g. CX22),
   with your own SSH key.
2. On your PC, create a key **only for deployments**:
   ```bash
   ssh-keygen -t ed25519 -f isobike_deploy -C github-deploy -N ""
   ```
3. On the server, as root:
   ```bash
   git clone https://github.com/PascalFewi/isobike.git && cd isobike
   # the argument is the content of isobike_deploy.pub from your PC (one line)
   sudo bash deploy/setup-server.sh "ssh-ed25519 AAAA... github-deploy"
   ```
   This installs Node 22, Caddy and gdown, creates the users `isobike` (runs the
   API) and `deploy` (GitHub logs in as this user and may only restart the API),
   opens ports 22/80/443 and downloads the data from Google Drive.
4. In GitHub: **Settings → Environments → New environment `production`**, and add
   these secrets there:

   | secret | value |
   |---|---|
   | `DEPLOY_HOST` | the server's IP (later: the domain) |
   | `DEPLOY_USER` | `deploy` |
   | `DEPLOY_SSH_KEY` | the full content of the private key `isobike_deploy` |
   | `DEPLOY_KNOWN_HOSTS` | *optional*: output of `ssh-keyscan -t ed25519 <IP>`. Pins the server's host key; without it the workflow accepts whatever key the server shows on each deploy. |

   Under *Deployment branches and tags*, allow only tags matching `v*`.
   Then delete `isobike_deploy` from your PC, or keep it in a password manager.

### Releasing

GitHub → Releases → *Draft a new release* → new tag (e.g. `v1.0.0`) on `master` →
*Publish*. Follow it under Actions → *Release*. To redeploy an existing tag:
Actions → *Release* → *Run workflow*.

New data does not need a release: upload the files to Drive, then on the server
run `sudo bash /opt/isobike/bin/fetch-data.sh && sudo systemctl restart isobike`.

### Switching to the domain

Point the domain's DNS A record at the server, replace `:80` in
`/etc/caddy/Caddyfile` with the domain (e.g. `isobike.ch, www.isobike.ch`), set
the `email` line, and run `sudo systemctl reload caddy`. Caddy obtains the
certificate itself. Update `DEPLOY_HOST` (and `DEPLOY_KNOWN_HOSTS`, if set) if
you deploy via the domain name. The frontend uses same-origin URLs, so it needs no rebuild.

## Secrets in a public repo

- **Nothing secret is in the repo, and nothing needs to be.** The app uses no
  API keys: swisstopo maps and search are keyless, the data is public under the
  ODbL. `frontend/.env.production` only holds same-origin paths.
- **Deploy credentials exist only as GitHub environment secrets.** GitHub masks
  them in logs. Workflows from forks and pull requests never receive them, and
  the deploy job only runs on a published release or a manual run, which only
  maintainers can start.
- **The deploy key can do one thing.** It logs in as `deploy`, which owns
  `/opt/isobike/releases` and may run exactly `systemctl restart isobike` via
  sudo, nothing else. It cannot read your personal account and it is not root.
  If it leaks: remove the line from `/home/deploy/.ssh/authorized_keys`, create a
  new key, update `DEPLOY_SSH_KEY`.
- **Host key pinning is optional.** With `DEPLOY_KNOWN_HOSTS` set, the workflow
  refuses a machine that only pretends to be the server. Without it, such a
  machine would receive the release package (public code anyway) and could fake
  a successful deploy, but it could not use the deploy key on the real server.
  Set it if you want deploys to fail loudly in that case.
- **Never commit** `.env.local`, private keys, or server passwords. `.gitignore`
  already excludes `.env.local`; check `git status` before committing.
- The server IP is not a secret as such, but it is kept in `DEPLOY_HOST` so the
  repo does not need changing when the server or the domain changes.
