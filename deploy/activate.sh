#!/usr/bin/env bash
#
# Activate an uploaded release. Called over SSH by the GitHub release workflow
# as the `deploy` user:
#
#   bash /opt/isobike/bin/activate.sh <tag> /tmp/isobike-<tag>.tar.gz
#
# Unpacks into /opt/isobike/releases/<tag>, switches the `current` symlink
# atomically, restarts the API, and checks /healthz. If the health check fails,
# the previous release is switched back in. Keeps the five newest releases.

set -euo pipefail

TAG="$1"
TARBALL="$2"
ROOT=/opt/isobike
RELEASES="$ROOT/releases"
case "$TAG" in *[!A-Za-z0-9._-]*|"") echo "bad tag: $TAG" >&2; exit 1 ;; esac

dest="$RELEASES/$TAG"
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$TARBALL" -C "$dest"
rm -f "$TARBALL"

previous="$(readlink -f "$ROOT/current" || true)"
ln -sfn "$dest" "$ROOT/current.new"
mv -T "$ROOT/current.new" "$ROOT/current"

sudo /usr/bin/systemctl restart isobike

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "== $TAG is live"
    ls -1dt "$RELEASES"/*/ | tail -n +6 | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done

echo "== $TAG failed its health check" >&2
if [ -n "$previous" ] && [ -d "$previous" ]; then
  ln -sfn "$previous" "$ROOT/current.new"
  mv -T "$ROOT/current.new" "$ROOT/current"
  sudo /usr/bin/systemctl restart isobike
  echo "== rolled back to $(basename "$previous")" >&2
fi
exit 1
