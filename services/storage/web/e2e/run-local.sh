#!/usr/bin/env bash
# Local smoke test: a throwaway Postgres in Docker, the storage binary in
# AUTH_MODE=dev (signed in as alice), and the headless Playwright smoke test.
# Usage: services/storage/web/e2e/run-local.sh [screenshot dir]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
web=$(cd "$here/.." && pwd)
svc=$(cd "$web/.." && pwd)
work=$(mktemp -d)
pg=storage-smoke-pg-$$
port=$((20000 + RANDOM % 10000))
cleanup() {
  [ -n "${app:-}" ] && kill "$app" 2>/dev/null || true
  docker rm -f "$pg" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

(cd "$web" && pnpm build >/dev/null)
(cd "$svc" && go build -o "$work/storage" ./cmd/storage)
docker run -d --name "$pg" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=smoke -e POSTGRES_USER=storage -e POSTGRES_DB=storage postgres:18.6-alpine >/dev/null
pgport=""
for _ in $(seq 50); do pgport=$(docker port "$pg" 5432/tcp 2>/dev/null | head -1 | cut -d: -f2) && [ -n "$pgport" ] && break; sleep 0.2; done
python3 -I "$here/fixtures.py" "$work/fixtures" >/dev/null
mkdir -p "$work/data"
DATABASE_URL="postgres://storage:smoke@127.0.0.1:$pgport/storage?sslmode=disable" DATA_DIR="$work/data" \
  PUBLIC_URL="http://127.0.0.1:$port" DOMAIN=lab.localhost AUTH_MODE=dev APP_ENV=development DEV_USER=alice DEV_GROUPS=users,admins \
  LISTEN_ADDR="127.0.0.1:$port" METRICS_ADDR="127.0.0.1:$((port + 1))" MIN_FREE_PERCENT=1 \
  "$work/storage" > "$work/storage.log" 2>&1 &
app=$!
for _ in $(seq 150); do curl -sf "http://127.0.0.1:$port/readyz" >/dev/null && break; sleep 0.2; done
cd "$web"
BASE_URL="http://127.0.0.1:$port" FIXTURES="$work/fixtures" SHOTS="${1:-}" pnpm exec playwright test e2e/smoke.spec.ts
