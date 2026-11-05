#!/usr/bin/env bash
# Proves Alloy strips share tokens before storage. A throwaway pod in namespace monitoring:
#   1. prints a JSON log line with /s/<token> and /api/public/<token>,
#   2. requests https://storage.<domain>/s/<token>/file.txt through Traefik with a known
#      traceparent (Traefik's span carries url.path),
#   3. posts an OTLP span straight to Alloy with url.full, url.path, http.target and
#      http.route all carrying a token.
# Then it asserts that neither token is in Loki or Tempo and that {token} is.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../../scripts/lib.sh"
require_cluster

TOKEN="faketok$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
TOKEN2="fakepub$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
T1=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
T2=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
POD="redaction-test-$(date +%s)"
TRAEFIK_IP=$(k -n traefik get svc traefik -o jsonpath='{.spec.clusterIP}')
NOW_NS=$(date +%s%N)

log "tokens: $TOKEN $TOKEN2; traces: $T1 (Traefik) $T2 (OTLP)"
OTLP=$(cat <<JSON
{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"redaction-test"}}]},
 "scopeSpans":[{"spans":[{"traceId":"$T2","spanId":"0102030405060708","name":"GET /api/public/$TOKEN2/info","kind":2,
  "startTimeUnixNano":"$NOW_NS","endTimeUnixNano":"$((NOW_NS + 5000000))",
  "attributes":[
   {"key":"url.full","value":{"stringValue":"https://storage.${DOMAIN}/s/$TOKEN/file.txt?download=1"}},
   {"key":"url.path","value":{"stringValue":"/s/$TOKEN/file.txt"}},
   {"key":"http.target","value":{"stringValue":"/api/public/$TOKEN2/info"}},
   {"key":"http.route","value":{"stringValue":"/api/public/$TOKEN2"}}]}]}]}]}
JSON
)
k -n monitoring run "$POD" --image="$CURL_IMAGE" --restart=Never --quiet \
  --labels=app.kubernetes.io/name=redaction-test,app.kubernetes.io/part-of=lab \
  --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":100,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"'"$POD"'","image":"'"$CURL_IMAGE"'","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"command":["sh","-c","echo \"{\\\"level\\\":\\\"info\\\",\\\"msg\\\":\\\"GET /s/'"$TOKEN"'/file.txt and /api/public/'"$TOKEN2"'/info\\\",\\\"path\\\":\\\"/s/'"$TOKEN"'\\\"}\"; curl -sk -o /dev/null -w \"traefik %{http_code}\\n\" --resolve storage.'"$DOMAIN"':443:'"$TRAEFIK_IP"' -H \"traceparent: 00-'"$T1"'-1111111111111111-01\" https://storage.'"$DOMAIN"'/s/'"$TOKEN"'/file.txt; curl -s -o /dev/null -w \"otlp %{http_code}\\n\" -H \"Content-Type: application/json\" --data-binary \"$OTLP\" http://alloy.monitoring.svc.cluster.local:4318/v1/traces; sleep 15"],"env":[{"name":"OTLP","value":'"$(jq -Rs . <<<"$OTLP")"'}]}]}}'
wait_for "test pod to finish" 120 sh -c "[ \"\$(kubectl --context $KCTX -n monitoring get pod $POD -o jsonpath='{.status.phase}')\" = Succeeded ]"
k -n monitoring logs "$POD"
k -n monitoring delete pod "$POD" --wait=false >/dev/null

# Query Loki and Tempo through port-forwards (the NetworkPolicies keep the API server's
# service proxy out of monitoring).
kubectl --context "$KCTX" -n monitoring port-forward svc/loki 23100:3100 >/dev/null 2>&1 & PF1=$!
kubectl --context "$KCTX" -n monitoring port-forward svc/tempo 23200:3200 >/dev/null 2>&1 & PF2=$!
trap 'kill $PF1 $PF2 2>/dev/null || true' EXIT
wait_for "port-forwards" 30 sh -c "curl -sf localhost:23100/ready && curl -sf localhost:23200/ready"
loki() { curl -s -G localhost:23100/loki/api/v1/query_range --data-urlencode "start=$since" --data-urlencode "query=$1"; }
tempo() { curl -sf "localhost:23200/api/v2/traces/$1" || true; }
since=$(( $(date +%s) - 600 ))000000000

fail=0
has_line() { loki "{pod=\"$POD\"}" | jq -e '.data.result | length > 0'; }
wait_for "Loki to ingest the test line" 180 has_line
line=$(loki "{pod=\"$POD\"}" | jq -r '.data.result[].values[][1]')
echo "Loki line: $line"
grep -q "$TOKEN\|$TOKEN2" <<<"$line" && { warn "token found in Loki"; fail=1; }
grep -q '/s/{token}/file.txt' <<<"$line" && grep -q '/api/public/{token}/info' <<<"$line" || { warn "redacted form missing in Loki"; fail=1; }
hits=$(loki "{namespace=~\".+\"} |~ \"$TOKEN|$TOKEN2\"" | jq '[.data.result[].values[]] | length')
echo "Loki lines anywhere containing a token: $hits"
[ "$hits" = 0 ] || fail=1

for t in "$T1" "$T2"; do
  wait_for "Tempo to have trace $t" 90 curl -sf "localhost:23200/api/v2/traces/$t"
  json=$(tempo "$t")
  echo "Tempo $t attributes:"
  jq -r '.trace.resourceSpans[].scopeSpans[].spans[] | "  span \(.name): " + ([.attributes[] | select(.key|test("url|http.target|http.route")) | "\(.key)=\(.value.stringValue)"] | join(" "))' <<<"$json"
  grep -q "$TOKEN\|$TOKEN2" <<<"$json" && { warn "token found in trace $t"; fail=1; }
  grep -q '/s/{token}/file.txt' <<<"$json" || { warn "/s/{token}/file.txt missing in trace $t"; fail=1; }
  grep -q 'ReverseProxy\|/api/public/{token}' <<<"$json" || { warn "/api/public/{token} missing in trace $t"; fail=1; }
done
[ "$fail" = 0 ] && log "PASS: share tokens are redacted in logs and traces" || die "FAIL: redaction"
