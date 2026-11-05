#!/usr/bin/env bash
# Local smoke test: a throwaway PostgreSQL in Docker, two API processes on the
# same database (alice on :18090, bob on :18091, AUTH_MODE=dev), the built UI
# served by the API, and headless Playwright. Everything is removed afterwards.
#   e2e/run-local.sh            build the UI, run the suite
#   KEEP=1 e2e/run-local.sh     leave the servers running (prints their URLs)
#   STOP=1 e2e/run-local.sh     stop servers left by KEEP=1
set -euo pipefail
web="$(cd "$(dirname "$0")/.." && pwd)"
api="$web/../api"
name="todo-web-e2e-$$"
logs="$web/.local-e2e"
mkdir -p "$logs"
if [[ -f "$logs/state" ]]; then
  # shellcheck disable=SC1091
  source "$logs/state"
  kill $old_pids 2>/dev/null || true
  docker rm -f "$old_name" >/dev/null 2>&1 || true
  rm -f "$logs/state"
fi
[[ -n "${STOP:-}" ]] && exit 0

cleanup() {
  [[ -n "${KEEP:-}" ]] && return
  kill ${pids:-} 2>/dev/null || true
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

(cd "$api" && pnpm build)
(cd "$web" && pnpm build >/dev/null)

docker run -d --rm --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=todo postgres:18.6-alpine3.24 >/dev/null
port="$(docker port "$name" 5432 | head -1 | sed 's/.*://')"
db="postgres://postgres:pw@127.0.0.1:$port/todo"
for i in $(seq 1 60); do docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 0.5; done

pids=""
start() { # user port metrics
  (cd "$api" && DATABASE_URL="$db" APP_ENV=development AUTH_MODE=dev DEV_USER="$1" PORT="$2" METRICS_PORT="$3" \
    EXPECTED_ORIGIN="http://127.0.0.1:$2" WEB_ROOT="$web/dist" exec node dist/src/main.js) >"$logs/api-$1.log" 2>&1 </dev/null &
  pids="$pids $!"
}
start alice 18090 19490
for i in $(seq 1 60); do curl -fs http://127.0.0.1:18090/readyz >/dev/null 2>&1 && break; sleep 0.5; done
start bob 18091 19491
for i in $(seq 1 60); do curl -fs http://127.0.0.1:18091/readyz >/dev/null 2>&1 && break; sleep 0.5; done

if [[ -n "${KEEP:-}" ]]; then
  printf 'old_pids="%s"\nold_name="%s"\n' "$pids" "$name" >"$logs/state"
  echo "alice: http://127.0.0.1:18090  bob: http://127.0.0.1:18091  db: $db  container: $name"
  exit 0
fi
cd "$web"
BASE_URL=http://127.0.0.1:18090 BOB_URL=http://127.0.0.1:18091 pnpm exec playwright test e2e/smoke.spec.ts "$@"
