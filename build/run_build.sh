#!/usr/bin/env bash
#
# End-to-end VeloRouter build, runnable on any Linux box -- a throwaway VPS
# (Hetzner et al.) or a Colab cell (`!bash build/run_build.sh`). Does everything
# your laptop shouldn't: installs deps, fetches OSM, builds graph.bin + PMTiles,
# and (optionally) pushes straight to R2. Nothing is left on your machine.
#
# Configure via environment variables:
#   REGION        build target: test-oberland (default) | switzerland
#   PBF_URL       OSM extract to download (default: Geofabrik Switzerland)
#   PBF_PATH      use a local .pbf instead of downloading
#   DEM           glo30 (default, ~30 m, small) | swissalti3d (2 m, CH, ~40 GB)
#   R2_BUCKET     if set with the AWS_* vars below, uploads the artefacts
#   R2_ENDPOINT   https://<accountid>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   an R2 API token
#
# Example (small test region, no upload):
#   REGION=test-oberland bash build/run_build.sh
# Example (national + upload):
#   REGION=switzerland R2_BUCKET=velorouter-graph R2_ENDPOINT=https://... \
#     AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... bash build/run_build.sh

set -euo pipefail

REGION="${REGION:-test-oberland}"
DEM="${DEM:-glo30}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/europe/switzerland-latest.osm.pbf}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK:-$REPO/build}"
OUT="$WORK/out/$REGION"

log() { echo "== $*" >&2; }

# --- 1. system deps: tippecanoe (built from source; not in apt) --------------- #
if ! command -v tippecanoe >/dev/null 2>&1; then
  log "installing tippecanoe from source"
  sudo apt-get update -qq && sudo apt-get install -y -qq build-essential libsqlite3-dev zlib1g-dev git
  tmp="$(mktemp -d)"
  git clone --depth 1 https://github.com/felt/tippecanoe.git "$tmp/tippecanoe"
  make -C "$tmp/tippecanoe" -j"$(nproc)" >/dev/null
  sudo make -C "$tmp/tippecanoe" install >/dev/null
fi

# --- 2. python deps (in a venv: fresh Ubuntu has no bare pip/python, and modern
#        Ubuntu blocks installing into the system Python -- PEP 668) ------------ #
log "setting up python venv + build deps"
# python3-dev + build-essential: some pyrosm deps (e.g. cykhash) have no wheel for
# newer Python and compile from source, which needs Python.h and a C toolchain.
sudo apt-get update -qq && sudo apt-get install -y -qq python3 python3-venv python3-dev build-essential
python3 -m venv "$WORK/venv"
# shellcheck disable=SC1091
source "$WORK/venv/bin/activate"          # from here on, `python`/`pip` = the venv
python -m pip install -q --upgrade pip
python -m pip install -q -r "$REPO/build/requirements-build.txt"

# --- 3. OSM extract ----------------------------------------------------------- #
if [ -n "${PBF_PATH:-}" ]; then
  PBF="$PBF_PATH"
else
  PBF="$WORK/cache/$(basename "$PBF_URL")"
  if [ ! -f "$PBF" ]; then
    log "downloading OSM extract: $PBF_URL"
    mkdir -p "$(dirname "$PBF")"
    curl -fSL --retry 3 -o "$PBF.part" "$PBF_URL" && mv "$PBF.part" "$PBF"
  fi
fi
log "OSM extract: $PBF"

# --- 4. build graph.bin + GeoJSON + meta.json --------------------------------- #
log "building graph ($REGION, DEM=$DEM)"
( cd "$REPO" && python -m build.build_graph --region "$REGION" --pbf "$PBF" --dem "$DEM" )

# --- 5. GeoJSON -> PMTiles ---------------------------------------------------- #
log "tippecanoe -> network.pmtiles"
tippecanoe -o "$OUT/network.pmtiles" -l network -zg \
  --drop-densest-as-needed --extend-zooms-if-still-dropping --force "$OUT/network.geojson"

ls -lh "$OUT"

# --- 6. upload to R2 (optional) ----------------------------------------------- #
if [ -n "${R2_BUCKET:-}" ] && [ -n "${R2_ENDPOINT:-}" ]; then
  log "uploading to R2 bucket $R2_BUCKET"
  python -m pip install -q awscli
  for f in graph.bin meta.json network.pmtiles; do
    aws s3 cp "$OUT/$f" "s3://$R2_BUCKET/$f" --endpoint-url "$R2_ENDPOINT"
  done
  log "uploaded. Enable public access on the bucket (or a custom domain) so the"
  log "frontend can range-request network.pmtiles; graph.bin stays private (Worker reads it)."
else
  log "R2_BUCKET/R2_ENDPOINT not set -- skipping upload. Artefacts are in $OUT"
fi

log "done."
