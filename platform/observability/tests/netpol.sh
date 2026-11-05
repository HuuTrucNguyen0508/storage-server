#!/usr/bin/env bash
# Checks the monitoring NetworkPolicies from a throwaway pod in namespace loadgen (and one
# in home): OTLP into Alloy and remote write into Prometheus are allowed; Grafana, Loki,
# Tempo, Alertmanager and the alert sink are not.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../../scripts/lib.sh"
require_cluster
M=monitoring.svc.cluster.local
probe() { # NAMESPACE "URL EXPECT ..."
  local ns="$1"; shift
  local script='fail=0; for pair in '"$*"'; do url=${pair%=*}; want=${pair##*=}; code=$(curl -s -o /dev/null -m 4 -w "%{http_code}" "$url"); case "$code" in 000) got=blocked ;; *) got=open ;; esac; [ "$got" = "$want" ] && r=PASS || { r=FAIL; fail=1; }; echo "$r $url -> $code ($got, want $want)"; done; exit $fail'
  k -n "$ns" run "netpol-$(date +%s%N | tail -c 6)" --image="$CURL_IMAGE" --restart=Never --rm -i --quiet \
    --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":100,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"c","image":"'"$CURL_IMAGE"'","command":["sh","-c",'"$(jq -Rn --arg s "$script" '$s')"'],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}'
}
log "from namespace loadgen"
probe loadgen "http://alloy.$M:4318/v1/traces=open http://prometheus.$M:9090/-/ready=open http://grafana.$M/api/health=blocked http://loki.$M:3100/ready=blocked http://tempo.$M:3200/ready=blocked http://alertmanager.$M:9093/-/ready=blocked http://alert-sink.$M:8080/healthz=blocked"
log "from namespace home"
probe home "http://alloy.$M:4318/v1/traces=open http://prometheus.$M:9090/-/ready=blocked http://grafana.$M/api/health=blocked"
