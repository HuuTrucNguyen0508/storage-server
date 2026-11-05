#!/usr/bin/env bash
# Installs the Prometheus Operator CRDs before anything creates a ServiceMonitor.
# Keep PROMETHEUS_OPERATOR_CRDS_VERSION matched to the operator version that
# kube-prometheus-stack ships (kube-prometheus-stack 92.20.0 -> operator v0.94.2 -> CRDs chart 32.0.2).
set -euo pipefail
PROMETHEUS_OPERATOR_CRDS_VERSION="${PROMETHEUS_OPERATOR_CRDS_VERSION:-32.0.2}"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
helm upgrade --install prometheus-operator-crds prometheus-community/prometheus-operator-crds \
  --version "$PROMETHEUS_OPERATOR_CRDS_VERSION" \
  --namespace monitoring --create-namespace \
  --wait
