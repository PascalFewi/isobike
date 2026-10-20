#!/usr/bin/env bash
#
# Download the isobike data files from the shared Google Drive folder into
# /opt/isobike/data (or $1). Run on the server, once after setup and again after
# each data rebuild. The folder must be shared as "Anyone with the link: Viewer".
#
#   sudo bash /opt/isobike/bin/fetch-data.sh
#
# Files expected (see README "Data"): graph.bin, geometry.bin, network.pmtiles,
# meta.json. Downloaded into a temp dir first and moved into place only when all
# four are there, so a failed download never leaves a half-updated data set.

set -euo pipefail

DRIVE_FOLDER_URL="${DRIVE_FOLDER_URL:-https://drive.google.com/drive/folders/1L97boYC-ZaGXpImwEYwdY6MKjwFfNcEx}"
DATA_DIR="${1:-/opt/isobike/data}"
FILES=(graph.bin geometry.bin network.pmtiles meta.json)

command -v gdown >/dev/null || { echo "gdown missing: pipx install gdown" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "== downloading $DRIVE_FOLDER_URL"
gdown --folder --remaining-ok -O "$tmp" "$DRIVE_FOLDER_URL"

for f in "${FILES[@]}"; do
  found="$(find "$tmp" -type f -name "$f" | head -n1)"
  [ -n "$found" ] || { echo "missing in Drive folder: $f" >&2; exit 1; }
  mv "$found" "$tmp/$f.ready"
done

mkdir -p "$DATA_DIR"
for f in "${FILES[@]}"; do
  install -m 0644 "$tmp/$f.ready" "$DATA_DIR/$f"
done
chown -R root:root "$DATA_DIR"

echo "== data in $DATA_DIR:"
ls -lh "$DATA_DIR"
cat "$DATA_DIR/meta.json"
echo
echo "== restart the API to load it: sudo systemctl restart isobike"
