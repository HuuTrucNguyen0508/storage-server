#!/usr/bin/env bash
# Proof in the live kind cluster, through Traefik and Authelia, with headless
# Chromium. Usage: services/todo/web/e2e/cluster-proof.sh
# Screenshots go to services/todo/web/docs/shots/.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
web=$(cd "$here/.." && pwd)
set -a; . "$root/config/local.env"; [ -f "$root/config/override.env" ] && . "$root/config/override.env"; . "$root/.local/credentials.env"; set +a
export CLUSTER=1 BASE_URL="https://todo.$DOMAIN" SHOTS="$web/docs/shots"
cd "$web"
pnpm exec playwright test e2e/cluster.spec.ts --reporter=list "$@"
