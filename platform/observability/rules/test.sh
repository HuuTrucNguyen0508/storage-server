#!/usr/bin/env bash
# Unit tests for the lab alerting rules, with promtool from the Prometheus image that
# kube-prometheus-stack runs (keep PROMETHEUS_IMAGE in step with the chart's
# prometheus.prometheusSpec.image.tag).
set -euo pipefail
cd "$(dirname "$0")"
PROMETHEUS_IMAGE="${PROMETHEUS_IMAGE:-quay.io/prometheus/prometheus:v3.15.1}"
run() { docker run --rm --entrypoint promtool -v "$PWD:/rules:ro" -w /rules "$PROMETHEUS_IMAGE" "$@"; }
run check rules lab.rules.yaml
run test rules lab.rules.test.yaml
