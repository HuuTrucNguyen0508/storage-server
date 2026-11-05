#!/usr/bin/env bash
# Installs the observability stack into namespace monitoring (bring-up step 8).
# Idempotent: every chart goes through `helm upgrade --install` with a pinned version and
# every manifest through `kubectl apply`. Safe to run on its own against the live cluster:
#   bash platform/observability/install.sh
# PROFILE=ci adds the overlays in values/ci/ (lower retention and requests).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../scripts/lib.sh"

# Chart pins. Keep KPS in step with install-crds.sh (operator v0.94.2 <-> CRDs chart 32.0.2)
# and rules/test.sh's Prometheus image (v3.15.1).
KPS_CHART_VERSION=92.20.0          # Prometheus v3.15.1, Alertmanager, Grafana 13.3.0, operator v0.94.2
LOKI_CHART_VERSION=7.5.0           # Loki 3.6.16
TEMPO_CHART_VERSION=1.24.4         # Tempo 2.9.0
ALLOY_CHART_VERSION=1.15.0         # Alloy v1.21.3
BLACKBOX_CHART_VERSION=11.20.2     # blackbox_exporter v0.29.1
METRICS_SERVER_CHART_VERSION=3.14.0 # metrics-server v0.9.0
NS=monitoring

require_cluster
load_creds
[ -n "${GRAFANA_ADMIN_PASSWORD:-}" ] || die "GRAFANA_ADMIN_PASSWORD is missing from $(creds_file)"

T0=$(date +%s)
WORK="$LOCAL_DIR/observability"
mkdir -p "$WORK"
chmod 700 "$WORK"

# values FILE...: -f flags for a chart's values plus its ci overlay when PROFILE=ci.
values() {
  local base="$1" name; name=$(basename "$base")
  render "$HERE/values/$name" > "$WORK/$name"
  printf -- '-f\n%s\n' "$WORK/$name"
  if [ "$PROFILE" = ci ] && [ -f "$HERE/values/ci/$name" ]; then
    render "$HERE/values/ci/$name" > "$WORK/ci-$name"
    printf -- '-f\n%s\n' "$WORK/ci-$name"
  fi
}

helm_install() { # RELEASE CHART VERSION VALUES_FILE [extra helm args...]
  local release="$1" chart="$2" version="$3" vfile="$4"; shift 4
  local t; t=$(date +%s)
  local -a vals; mapfile -t vals < <(values "$vfile")
  log "helm: $release ($chart $version)"
  h upgrade --install "$release" "$chart" --version "$version" --namespace "$NS" \
    "${vals[@]}" "$@" --wait --timeout 10m >/dev/null
  log "$release ready in $(( $(date +%s) - t ))s"
}

step "8a. namespace, secrets, config maps"
k apply -f "$HERE/manifests/namespace.yaml" >/dev/null
k -n "$NS" create secret generic grafana-admin \
  --from-literal=admin-user=admin --from-literal=admin-password="$GRAFANA_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
k -n "$NS" create configmap lab-ca --from-file=ca.crt="$LOCAL_DIR/ca.crt" --dry-run=client -o yaml | k apply -f - >/dev/null
k -n "$NS" create configmap alert-sink --from-file=alert-sink.py="$HERE/manifests/alert-sink.py" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
k -n "$NS" create configmap alloy-config --from-file=config.alloy="$HERE/alloy/config.alloy" \
  --dry-run=client -o yaml | k label --local -f - app.kubernetes.io/part-of=lab -o yaml | k apply -f - >/dev/null
# Network policies first: the stack comes up already fenced in.
k apply -f "$HERE/manifests/networkpolicies.yaml" >/dev/null

step "8b. charts"
helm_repo prometheus-community https://prometheus-community.github.io/helm-charts
helm_repo grafana https://grafana.github.io/helm-charts
helm_repo metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm_install kube-prometheus-stack prometheus-community/kube-prometheus-stack "$KPS_CHART_VERSION" kube-prometheus-stack.yaml
helm_install loki grafana/loki "$LOKI_CHART_VERSION" loki.yaml
helm_install tempo grafana/tempo "$TEMPO_CHART_VERSION" tempo.yaml
helm_install alloy grafana/alloy "$ALLOY_CHART_VERSION" alloy.yaml
helm_install blackbox-exporter prometheus-community/prometheus-blackbox-exporter "$BLACKBOX_CHART_VERSION" blackbox.yaml
helm_install metrics-server metrics-server/metrics-server "$METRICS_SERVER_CHART_VERSION" metrics-server.yaml

step "8c. services, routes, probes, monitors, alert sink, rules"
k apply -f "$HERE/manifests/services.yaml" >/dev/null
render "$HERE/manifests/ingressroutes.yaml" | k apply -f - >/dev/null
render "$HERE/manifests/probes.yaml" | k apply -f - >/dev/null
k apply -f "$HERE/manifests/monitors.yaml" >/dev/null
ALERT_SINK_HASH=$(sha256sum "$HERE/manifests/alert-sink.py" | cut -c1-16)
export ALERT_SINK_HASH
RENDER_VARS="$RENDER_VARS ALERT_SINK_HASH" render "$HERE/manifests/alert-sink.yaml" | k apply -f - >/dev/null
{
  cat <<YAML
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: lab-rules
  namespace: $NS
  labels: {app.kubernetes.io/name: lab-rules, app.kubernetes.io/part-of: lab, app.kubernetes.io/component: alerting}
spec:
YAML
  sed -e '/^#/d' -e 's/^/  /' "$HERE/rules/lab.rules.yaml"
} | render | k apply -f - >/dev/null

step "8d. dashboards"
# One ConfigMap per dashboard; the folder comes from the directory name (dashboards/<folder>/).
# Server-side apply: big dashboards exceed the client-side last-applied annotation limit.
keep=" "
while IFS= read -r -d '' file; do
  dir=$(basename "$(dirname "$file")")
  case "$dir" in
    lab) folder="Lab" ;;
    apps) folder="Apps" ;;
    platform) folder="Platform" ;;
    load-tests) folder="Load tests" ;;
    *) folder="$dir" ;;
  esac
  name="dashboard-$(basename "$file" .json)"
  keep="$keep$name "
  k -n "$NS" create configmap "$name" --from-file="$(basename "$file")=$file" --dry-run=client -o yaml \
    | k label --local -f - grafana_dashboard=1 lab/dashboard=true app.kubernetes.io/part-of=lab -o yaml \
    | k annotate --local -f - grafana_folder="$folder" -o yaml \
    | k apply --server-side --force-conflicts --field-manager=lab-observability -f - >/dev/null
done < <(find "$HERE/dashboards" -mindepth 2 -name '*.json' -print0 | sort -z)
# Dashboards whose JSON file was removed.
for cm in $(k -n "$NS" get configmap -l lab/dashboard=true -o jsonpath='{.items[*].metadata.name}'); do
  [[ "$keep" == *" $cm "* ]] || { log "removing dashboard $cm"; k -n "$NS" delete configmap "$cm" >/dev/null; }
done

step "8e. waiting for rollouts"
for d in grafana kube-prometheus-stack-kube-state-metrics kps-operator alloy blackbox-exporter alert-sink metrics-server; do
  wait_rollout "$NS" "deployment/$d" 300s >/dev/null
done
for s in loki tempo; do wait_rollout "$NS" "statefulset/$s" 300s >/dev/null; done
wait_for "Prometheus StatefulSet" 300 k -n "$NS" get statefulset prometheus-kps-prometheus
wait_rollout "$NS" statefulset/prometheus-kps-prometheus 300s >/dev/null
wait_for "Alertmanager StatefulSet" 300 k -n "$NS" get statefulset alertmanager-kps-alertmanager
wait_rollout "$NS" statefulset/alertmanager-kps-alertmanager 300s >/dev/null
log "observability ready in $(( $(date +%s) - T0 ))s: https://grafana.${DOMAIN}/ (admins)"
