#!/usr/bin/env bash
# Reads a finished (or running) k6 run back out of Prometheus: loadgen/report.sh <testid> [options]
# Options are passed to report.mjs (--app storage --steps 2,4,8 --hold 50 --ramp 10).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
require_cluster
PORT="${PROM_PORT:-19090}"
k -n monitoring port-forward svc/prometheus "$PORT:9090" >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
wait_for "Prometheus port-forward" 30 curl -fs "http://127.0.0.1:$PORT/-/ready"
PROM_URL="http://127.0.0.1:$PORT" node "$(dirname "${BASH_SOURCE[0]}")/report.mjs" "$@"
