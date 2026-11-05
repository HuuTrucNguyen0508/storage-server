#!/usr/bin/env bash
# Unit-tests the synthetic-check alert rules with promtool (from the Prometheus image the
# observability stack runs; see platform/observability/rules/test.sh).
set -euo pipefail
cd "$(dirname "$0")/deploy"
IMAGE="${PROMETHEUS_IMAGE:-quay.io/prometheus/prometheus:v3.15.1}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
yq '.spec' prometheusrule.yaml > "$tmp/synthetic.rules.yaml"
cp tests/synthetic.rules.test.yaml "$tmp/"
chmod -R a+rX "$tmp"
run() { docker run --rm --entrypoint promtool -v "$tmp:/rules:ro" -w /rules "$IMAGE" "$@"; }
run check rules synthetic.rules.yaml
run test rules synthetic.rules.test.yaml
