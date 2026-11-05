#!/usr/bin/env bash
# Proof in the live lab cluster, through Traefik and Authelia, with headless
# Chromium. Usage: services/storage/web/e2e/cluster-proof.sh [--big]
# --big also uploads a 2 GiB file through the ingress and verifies a streamed
# download's checksum. Screenshots go to services/storage/docs/shots/.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
web=$(cd "$here/.." && pwd)
set -a; . "$root/config/local.env"; [ -f "$root/config/override.env" ] && . "$root/config/override.env"; . "$root/.local/credentials.env"; set +a
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 -I "$here/fixtures.py" "$work/fixtures" >/dev/null
export CLUSTER=1 BASE_URL="https://storage.$DOMAIN" FIXTURES="$work/fixtures" SHOTS="$root/services/storage/docs/shots"
if [ "${1:-}" = "--big" ]; then
  head -c $((2 * 1024 * 1024 * 1024)) /dev/urandom > "$work/big-2GiB.bin"
  export BIG_FILE="$work/big-2GiB.bin"
fi
cd "$web"
pnpm exec playwright test e2e/cluster.spec.ts --reporter=list 2>&1 | tee "$work/run.log"
if [ -n "${BIG_FILE:-}" ]; then
  node=$(sed -n 's/.*BIG_NODE=\([0-9a-f-]*\).*/\1/p' "$work/run.log" | tail -1)
  session=$(sed -n 's/.*BIG_SESSION=\([^ ]*\).*/\1/p' "$work/run.log" | tail -1)
  want=$(sha256sum "$BIG_FILE" | cut -d' ' -f1)
  got=$(curl -sf --cacert "$root/.local/ca.crt" -b "authelia_session=$session" "$BASE_URL/api/nodes/$node/content" | sha256sum | cut -d' ' -f1)
  echo "2 GiB download sha256: local $want, downloaded $got"
  [ "$want" = "$got" ] && echo "CHECKSUM MATCH" || { echo "CHECKSUM MISMATCH"; exit 1; }
fi
