#!/usr/bin/env bash
# Proves an alert travels Alertmanager -> webhook sink -> Loki. Posts a synthetic alert to
# the Alertmanager API (it resolves itself after 5 minutes), then waits for the sink's
# JSON log line in Loki.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../../scripts/lib.sh"
require_cluster

ID="delivery-test-$(date +%s)"
kubectl --context "$KCTX" -n monitoring port-forward svc/alertmanager 29093:9093 >/dev/null 2>&1 & PF1=$!
kubectl --context "$KCTX" -n monitoring port-forward svc/loki 29100:3100 >/dev/null 2>&1 & PF2=$!
trap 'kill $PF1 $PF2 2>/dev/null || true' EXIT
wait_for "port-forwards" 30 sh -c "curl -sf localhost:29093/-/ready && curl -sf localhost:29100/ready"

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ends=$(date -u -d "+5 min" +%Y-%m-%dT%H:%M:%SZ)
curl -sf -XPOST localhost:29093/api/v2/alerts -H 'Content-Type: application/json' -d "[{
  \"labels\": {\"alertname\": \"LabDeliveryTest\", \"severity\": \"info\", \"test_id\": \"$ID\", \"namespace\": \"monitoring\"},
  \"annotations\": {\"summary\": \"Synthetic alert from platform/observability/tests/alert-delivery.sh\"},
  \"startsAt\": \"$now\", \"endsAt\": \"$ends\"}]"
log "posted alert $ID; Alertmanager waits group_wait (30s) before notifying"

since=$(( $(date +%s) - 60 ))000000000
found() {
  curl -s -G localhost:29100/loki/api/v1/query_range --data-urlencode "start=$since" \
    --data-urlencode "query={namespace=\"monitoring\", app=\"alert-sink\"} |= \"$ID\" | json | msg=\"alert\"" \
    | jq -e '.data.result | length > 0'
}
wait_for "the sink's log line in Loki" 180 found
curl -s -G localhost:29100/loki/api/v1/query_range --data-urlencode "start=$since" \
  --data-urlencode "query={namespace=\"monitoring\", app=\"alert-sink\"} |= \"$ID\" | json | msg=\"alert\"" \
  | jq -r '.data.result[].values[][1]'
log "PASS: alert $ID reached the webhook sink and Loki"
