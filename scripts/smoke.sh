#!/usr/bin/env bash
# smoke.sh: security and platform checks against the running cluster. Rerunnable.
# Deploys a temporary traefik/whoami behind sso-chain plus a public route behind only
# strip-identity (the storage route shape), runs every check, then removes the fixtures.
#   KEEP=1     keep the fixtures afterwards
#   ONLY=a,b   run only some groups: tls,sso,forgery,admin,paths,netpol,dns,logout,persistence,db
. "$(dirname "$0")/lib.sh"
require_cluster
load_creds

CA="$LOCAL_DIR/ca.crt"
WORK=$(mktemp -d "$LOCAL_DIR/.smoke.XXXXXX")
PASS=0; FAIL=0; FAILED=()
SMOKE_HOST="whoami.${DOMAIN}"

cleanup() {
  rm -rf "$WORK"
  if [ -z "${KEEP:-}" ]; then
    k delete namespace smoke smoke-other --ignore-not-found --wait=false >/dev/null 2>&1 || true
    k -n traefik delete pod -l lab/smoke=true --ignore-not-found --wait=false >/dev/null 2>&1 || true
    k delete ingressroute -A -l lab/smoke-placeholder=true --ignore-not-found >/dev/null 2>&1 || true
    k delete namespace smokedb --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

want() { [ -z "${ONLY:-}" ] || [[ ",$ONLY," == *",$1,"* ]]; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; return 0; }
check() { # DESCRIPTION TEST-ARGS... (one `[ ]` test; use check_all for several)
  local d="$1"; shift
  if "$@"; then ok "$d"; else bad "$d"; fi
}
check_all() { # DESCRIPTION 'shell condition'
  if eval "$2"; then ok "$1"; else bad "$1"; fi
}

# https GET through the real host listener. Prints "STATUS LOCATION" and keeps the body in $WORK/body.
req() { # [curl args...] URL
  curl -sS -o "$WORK/body" -w '%{http_code} %{redirect_url}' --cacert "$CA" \
    --connect-to "::${LISTEN_ADDRESS}:${HTTPS_PORT}" --max-time 20 "$@" || echo "000 curl-error"
}
body_has()     { grep -qiE "$1" "$WORK/body"; }
body_lacks()   { ! grep -qiE "$1" "$WORK/body"; }

login() { # USER PASSWORD JAR
  rm -f "$3"
  local out
  out=$(curl -sS --cacert "$CA" --connect-to "::${LISTEN_ADDRESS}:${HTTPS_PORT}" -c "$3" -b "$3" \
    -H 'Content-Type: application/json' -H "Origin: https://auth.${DOMAIN}" \
    --data "$(jq -nc --arg u "$1" --arg p "$2" --arg t "https://${SMOKE_HOST}/" '{username: $u, password: $p, keepMeLoggedIn: false, targetURL: $t}')" \
    "https://auth.${DOMAIN}/api/firstfactor")
  echo "$out" | jq -e '.status == "OK"' >/dev/null
}

# ---------------------------------------------------------------------------
step "fixtures"
# A previous run's namespaces may still be terminating.
for ns in smoke smoke-other smokedb; do
  if [ "$(k get namespace "$ns" -o jsonpath='{.status.phase}' 2>/dev/null)" = Terminating ]; then
    log "waiting for namespace $ns to finish terminating"
    k wait --for=delete "namespace/$ns" --timeout=180s >/dev/null
  fi
done
k apply -f <(render "$ROOT/platform/smoke/smoke.yaml") >/dev/null
for host in prometheus grafana alertmanager; do
  if ! k get ingressroute -A -o json | jq -e --arg h "Host(\`$host.$DOMAIN\`)" '[.items[].spec.routes[].match | select(contains($h))] | length > 0' >/dev/null; then
    log "no route for $host.$DOMAIN yet; adding a placeholder backend behind sso-chain"
    cat <<EOF | k apply -f - >/dev/null
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: placeholder-$host
  namespace: smoke
  labels: {lab/smoke-placeholder: "true"}
spec:
  entryPoints: [websecure]
  routes:
    - match: Host(\`$host.$DOMAIN\`)
      kind: Rule
      middlewares: [{name: sso-chain, namespace: auth}]
      services: [{name: whoami, port: 8080}]
  tls: {}
EOF
  fi
done
probe() { # NAMESPACE NAME APP_NAME_LABEL
  PROBE_NAMESPACE="$1" PROBE_NAME="$2" PROBE_APP_NAME="$3" RENDER_VARS="$RENDER_VARS PROBE_NAMESPACE PROBE_NAME PROBE_APP_NAME" \
    render "$ROOT/platform/smoke/probe.yaml" | k apply -f - >/dev/null
}
probe smoke-other probe probe
probe traefik smoke-probe smoke-probe
probe traefik smoke-probe-traefik-label traefik
wait_rollout smoke deployment/whoami 120s >/dev/null
k -n smoke-other wait --for=condition=Ready pod/probe --timeout=120s >/dev/null
k -n traefik wait --for=condition=Ready pod/smoke-probe pod/smoke-probe-traefik-label --timeout=120s >/dev/null
# Let Traefik pick up the routes.
wait_for "whoami route" 60 bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --cacert '$CA' --connect-to '::${LISTEN_ADDRESS}:${HTTPS_PORT}' https://${SMOKE_HOST}/s/ready)\" = 200 ]"

# ---------------------------------------------------------------------------
if want tls; then
  step "TLS and redirects"
  r=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --connect-to "::${LISTEN_ADDRESS}:${HTTP_PORT}" "http://home.${DOMAIN}/x?y=1")
  check "http://home.${DOMAIN} redirects to https ($r)" [ "${r%% *}" = 301 -o "${r%% *}" = 308 ]
  [[ "$r" == *"https://home.${DOMAIN}"* ]] && ok "redirect target is https://home.${DOMAIN}/..." || bad "redirect target ($r)"
  if openssl s_client -connect "${LISTEN_ADDRESS}:${HTTPS_PORT}" -servername "storage.${DOMAIN}" -CAfile "$CA" -verify_return_error </dev/null >/dev/null 2>&1; then
    ok "wildcard certificate verifies against .local/ca.crt (storage.${DOMAIN})"
  else bad "wildcard certificate does not verify against .local/ca.crt"; fi
  # *.localhost resolves to ::1 and 127.0.0.1; nothing listens on ::1, so clients fall back to IPv4.
  if [ "$LISTEN_ADDRESS" = 127.0.0.1 ]; then
    r=$(curl -sS -o /dev/null -w '%{http_code} %{remote_ip}' --cacert "$CA" "https://auth.${DOMAIN}/api/health" || true)
    check "plain curl (no address pinning) reaches https://auth.${DOMAIN} ($r)" [ "${r%% *}" = 200 ]
  fi
fi

# ---------------------------------------------------------------------------
if want sso || want forgery || want admin || want logout; then
  ALICE="$WORK/alice.jar"; ADMIN="$WORK/admin.jar"
  login alice "$ALICE_PASSWORD" "$ALICE" || bad "alice can log in through /api/firstfactor"
  login "$ADMIN_USER" "$ADMIN_PASSWORD" "$ADMIN" || bad "admin can log in through /api/firstfactor"
fi

if want sso; then
  step "SSO"
  r=$(req "https://${SMOKE_HOST}/hello")
  [[ "${r%% *}" == 302 && "${r#* }" == "https://auth.${DOMAIN}/"* ]] \
    && ok "anonymous request is redirected to auth.${DOMAIN} ($r)" || bad "anonymous redirect" "$r"
  r=$(req -X POST -H 'X-Requested-With: fetch' -H 'Content-Type: application/json' --data '{}' "https://${SMOKE_HOST}/api/x")
  check_all "anonymous POST never reaches the backend (${r%% *})" '[ "${r%% *}" = 401 ] || [ "${r%% *}" = 302 ] || [ "${r%% *}" = 303 ]'
  r=$(req -b "$ALICE" "https://${SMOKE_HOST}/hello")
  if [ "${r%% *}" = 200 ] && body_has '^Remote-User: alice\s*$' && body_has '^Remote-Groups: users\s*$'; then
    ok "alice reaches whoami with Remote-User: alice and Remote-Groups: users"
    grep -iE '^Remote-' "$WORK/body" | sed 's/^/       /'
  else bad "alice reaches whoami with identity headers" "$r $(grep -iE '^Remote-' "$WORK/body" | tr '\n' ' ')"; fi
fi

# ---------------------------------------------------------------------------
if want forgery; then
  step "forged identity headers"
  forged=(-H 'Remote-User: admin' -H 'Remote-Groups: admins' -H 'Remote-Email: admin@evil' -H 'Remote-Name: Evil')
  r=$(req "${forged[@]}" "https://${SMOKE_HOST}/hello")
  check "SSO route, no session, forged headers: redirected, never reaches backend (${r%% *})" [ "${r%% *}" = 302 ]
  r=$(req -b "$ALICE" "${forged[@]}" "https://${SMOKE_HOST}/hello")
  if [ "${r%% *}" = 200 ] && body_has '^Remote-User: alice\s*$' && body_lacks 'admin' && body_lacks 'evil'; then
    ok "SSO route, alice session, forged headers: backend sees only alice"
  else bad "SSO route forged with session" "$r $(grep -iE '^Remote-' "$WORK/body" | tr '\n' ' ')"; fi
  r=$(req "${forged[@]}" "https://${SMOKE_HOST}/s/token123")
  if [ "${r%% *}" = 200 ] && body_lacks '^Remote-'; then
    ok "public route, no session, forged headers: backend sees no Remote-* header"
  else bad "public route forged without session" "$r $(grep -iE '^Remote-' "$WORK/body" | tr '\n' ' ')"; fi
  r=$(req -b "$ALICE" "${forged[@]}" "https://${SMOKE_HOST}/s/token123")
  if [ "${r%% *}" = 200 ] && body_lacks '^Remote-'; then
    ok "public route, alice session, forged headers: backend sees no Remote-* header"
  else bad "public route forged with session" "$r $(grep -iE '^Remote-' "$WORK/body" | tr '\n' ' ')"; fi
  for route in "/s/token123" "/hello"; do
    r=$(req -b "$ALICE" -H 'Remote-User: admin' -H 'Remote-User: root' -H 'remote-user: x1' -H 'REMOTE-USER: x2' \
      -H 'Remote_User: admin' -H 'Remote.User: admin' -H 'X-Remote-User: admin' "https://${SMOKE_HOST}${route}")
    if [ "${r%% *}" = 200 ] && body_lacks '^Remote.User: (admin|root|x1|x2)' && body_lacks '^Remote_User'; then
      ok "duplicate, case and underscore variants of Remote-User never reach the backend ($route)"
    else bad "header variants on $route" "$r $(grep -iE 'remote' "$WORK/body" | tr '\n' ' ')"; fi
  done
fi

# ---------------------------------------------------------------------------
if want admin; then
  step "admin-only hosts"
  for host in prometheus grafana alertmanager traefik; do
    path=/; [ "$host" = traefik ] && path=/dashboard/
    r=$(req -b "$ALICE" "https://$host.${DOMAIN}$path")
    check "alice (users) is refused on $host.${DOMAIN} (${r%% *})" [ "${r%% *}" = 403 ]
    r=$(req -b "$ADMIN" "https://$host.${DOMAIN}$path")
    # The app itself may redirect (Prometheus sends / to /query); Authelia's redirect goes to auth.
    check_all "admin is let through on $host.${DOMAIN} ($r)" '[ "${r%% *}" = 200 ] || { [[ "${r%% *}" == 30* ]] && [[ "${r#* }" != "https://auth.${DOMAIN}/"* ]]; }'
  done
  r=$(req "https://traefik.${DOMAIN}/api/rawdata")
  check "anonymous Traefik API is redirected to sign-in (${r%% *})" [ "${r%% *}" = 302 ]
fi

# ---------------------------------------------------------------------------
if want paths; then
  step "path tricks against the public/private route pair (anonymous)"
  # expectation: sso = must not reach the backend (302/400/404);
  #              public = may reach the backend as a public path, without identity.
  while read -r path expect; do
    [ -z "$path" ] && continue
    r=$(req --path-as-is "https://${SMOKE_HOST}${path}")
    code=${r%% *}
    seen=$(grep -m1 -E '^(GET|HEAD) ' "$WORK/body" 2>/dev/null | tr -d '\r' || true)
    case "$expect" in
      sso)
        if [ "$code" = 302 ] || [ "$code" = 400 ] || [ "$code" = 404 ]; then ok "$path -> $code (does not reach the backend)"
        else bad "$path should not reach the backend" "$code; backend saw: $seen"; fi ;;
      public)
        if [ "$code" = 200 ] && body_lacks '^Remote-'; then ok "$path -> 200 public, no identity (backend saw: ${seen})"
        elif [ "$code" = 400 ] || [ "$code" = 404 ]; then ok "$path -> $code (rejected by Traefik)"
        else bad "$path public route" "$code; backend saw: $seen"; fi ;;
      public-or-reject)
        if [ "$code" = 400 ] || [ "$code" = 404 ] || [ "$code" = 302 ]; then ok "$path -> $code (rejected or sent to sign-in)"
        elif [ "$code" = 200 ] && body_lacks '^Remote-' && [[ "$seen" =~ ^GET\ /+(s|%73)/|^GET\ /+api/public/|^GET\ /+assets/ ]]; then
          ok "$path -> 200 public only, no identity; backend saw raw '${seen}' (public handlers must not normalise into private routes)"
        else bad "$path" "$code; backend saw: $seen"; fi ;;
    esac
  done <<'PATHS'
/s sso
/sx sso
/sx/token sso
/S/token sso
/s/token public
/s//token public
/s/..%2fapi/x public-or-reject
/s/..%2Fapi/x public-or-reject
/s/%2e%2e/api/x public-or-reject
/s/../api/x sso
/s/./../api/x sso
/%2e%2e/ sso
/%2e%2e/api/x sso
//api/x sso
///api/x sso
//s/token public-or-reject
/api/public/../files sso
/api/publicx sso
/assets/..%2f..%2fapi public-or-reject
/assets/..;/api/x public-or-reject
/favicon.svg public
/favicon.svgx sso
/favicon.svg/ sso
/s%2ftoken sso
/%73/token public-or-reject
PATHS
fi

# ---------------------------------------------------------------------------
if want netpol; then
  step "NetworkPolicy enforcement"
  reach() { # NAMESPACE POD URL -> 0 when an HTTP response arrives
    k -n "$1" exec "$2" -- curl -s -o /dev/null --connect-timeout 3 --max-time 5 "$3"
  }
  expect_blocked() { if reach "$1" "$2" "$3"; then bad "$4" "connection succeeded"; else ok "$4"; fi; }
  expect_open()    { if reach "$1" "$2" "$3"; then ok "$4"; else bad "$4" "connection failed"; fi; }
  W=http://whoami.smoke.svc.cluster.local:8080/
  A=http://authelia.auth.svc.cluster.local:9091/api/health
  expect_blocked smoke-other probe "$W" "pod in another namespace cannot reach the app pod (smoke/whoami:8080)"
  expect_blocked traefik smoke-probe "$W" "non-Traefik pod in namespace traefik cannot reach the app pod"
  expect_open    traefik smoke-probe-traefik-label "$W" "pod with Traefik's labels in namespace traefik can reach the app pod (positive control)"
  expect_blocked smoke-other probe "$A" "pod in another namespace cannot reach Authelia :9091"
  expect_blocked traefik smoke-probe "$A" "non-Traefik pod in namespace traefik cannot reach Authelia :9091"
  expect_open    traefik smoke-probe-traefik-label "$A" "Traefik-labelled pod reaches Authelia :9091 (positive control)"
  expect_blocked smoke-other probe http://authelia.auth.svc.cluster.local:9959/metrics "pod in another namespace cannot reach Authelia metrics :9959"
  if k -n pdf get svc stirling-pdf >/dev/null 2>&1; then
    expect_blocked smoke-other probe http://stirling-pdf.pdf.svc.cluster.local:8080/api/v1/info/status "pod in another namespace cannot reach Stirling PDF :8080"
  fi
  if k -n home get svc home >/dev/null 2>&1; then
    expect_blocked smoke-other probe http://home.home.svc.cluster.local:8080/healthz "pod in another namespace cannot reach Home :8080"
  fi
  expect_open smoke-other probe http://traefik.traefik.svc.cluster.local:80/ "egress stays open: probe reaches the Traefik Service"
fi

# ---------------------------------------------------------------------------
if want dns; then
  step "CoreDNS rewrite"
  traefik_ip=$(k -n traefik get svc traefik -o jsonpath='{.spec.clusterIP}')
  for name in "storage.${DOMAIN}" "${DOMAIN}" "a.b.${DOMAIN}" "STORAGE.${DOMAIN}"; do
    got=$(k -n smoke-other exec probe -- nslookup "$name" 2>/dev/null | awk '/^Address: / {print $2}' | grep -v ':' | head -n 1 || true)
    check "$name resolves to the Traefik Service ($got)" [ "$got" = "$traefik_ip" ]
  done
  got=$(k -n smoke-other exec probe -- nslookup "evil${DOMAIN}" 2>/dev/null | awk '/^Address: / {print $2}' | head -n 1 || true)
  check "evil${DOMAIN} is not rewritten (anchored match: '${got:-NXDOMAIN}')" [ "$got" != "$traefik_ip" ]
  # Full in-cluster HTTPS through the rewritten name (curl itself maps *.localhost to
  # loopback, so pin the resolved address explicitly).
  code=$(k -n smoke-other exec probe -- curl -s -o /dev/null -w '%{http_code}' -k --resolve "${SMOKE_HOST}:443:${traefik_ip}" "https://${SMOKE_HOST}/s/x" || true)
  check "pod reaches https://${SMOKE_HOST}/s/x through Traefik ($code)" [ "$code" = 200 ]
fi

# ---------------------------------------------------------------------------
if want logout; then
  step "logout"
  r=$(req -b "$ALICE" "https://${SMOKE_HOST}/hello"); before=${r%% *}
  curl -sS -o /dev/null --cacert "$CA" --connect-to "::${LISTEN_ADDRESS}:${HTTPS_PORT}" -b "$ALICE" -c "$ALICE" \
    -X POST -H 'Content-Type: application/json' -H "Origin: https://auth.${DOMAIN}" --data '{}' "https://auth.${DOMAIN}/api/logout"
  r=$(req -b "$ALICE" "https://${SMOKE_HOST}/hello")
  check_all "after POST /api/logout the session is gone (before $before, after ${r%% *})" '[ "$before" = 200 ] && [ "${r%% *}" = 302 ]'
fi

# ---------------------------------------------------------------------------
if want persistence; then
  step "host-backed volume persistence"
  mkdir -p "$DATA_DIR/smoke"; chmod 0777 "$DATA_DIR/smoke"
  if [ "$(k get pv smoke-data -o jsonpath='{.status.phase}' 2>/dev/null)" = Released ]; then
    k patch pv smoke-data --type json -p '[{"op":"remove","path":"/spec/claimRef/uid"},{"op":"remove","path":"/spec/claimRef/resourceVersion"}]' >/dev/null
  fi
  CLUSTER_ID=$(k get namespace kube-system -o jsonpath='{.metadata.uid}')
  export CLUSTER_ID
  k -n smoke delete pod persistence --ignore-not-found >/dev/null
  RENDER_VARS="$RENDER_VARS CLUSTER_ID" render "$ROOT/platform/smoke/persistence.yaml" | k apply -f - >/dev/null
  wait_for "persistence pod" 120 bash -c "[ \"\$(kubectl --context $KCTX -n smoke get pod persistence -o jsonpath='{.status.phase}')\" = Succeeded ]"
  k -n smoke logs persistence | sed 's/^/       /'
  clusters=$(cut -d' ' -f1 "$DATA_DIR/smoke/markers.txt" | sort -u | wc -l)
  if grep -q "cluster=$CLUSTER_ID" "$DATA_DIR/smoke/markers.txt"; then
    ok "pod wrote through PVC smoke/smoke-data to $DATA_DIR/smoke/markers.txt (markers from $clusters cluster(s))"
  else bad "marker not found on the host"; fi
  if [ "$clusters" -gt 1 ]; then ok "markers written by an earlier cluster survived the rebuild"; fi
fi

# ---------------------------------------------------------------------------
if want db; then
  step "make backup / make restore against a throwaway CloudNativePG cluster"
  render "$ROOT/platform/smoke/db.yaml" | k apply -f - >/dev/null
  wait_for "smokedb-db cluster" 300 k -n smokedb wait --for=condition=Ready cluster/smokedb-db --timeout=5s
  wait_rollout smokedb deployment/smokedb 120s >/dev/null
  server_image=$(k -n smokedb get cluster smokedb-db -o jsonpath='{.status.image}')
  server_major=$(echo "${server_image%@*}" | sed -E 's/.*:([0-9]+).*/\1/')
  client_major=$(echo "${POSTGRES_CLIENT_IMAGE%@*}" | sed -E 's/.*:([0-9]+).*/\1/')
  check "backup client image major ($client_major) matches the server ($server_major)" [ "$server_major" = "$client_major" ]
  sql() { k -n smokedb exec smokedb-db-1 -c postgres -- psql -X -q -t -A -d smokedb -c "$1"; }
  sql "SET ROLE smokedb; DROP TABLE IF EXISTS items; CREATE TABLE items (name text); INSERT INTO items VALUES ('before-backup');"
  if make -s -C "$ROOT" backup APPS=smokedb; then ok "make backup APPS=smokedb"; else bad "make backup APPS=smokedb"; fi
  sql "SET ROLE smokedb; INSERT INTO items VALUES ('after-backup'); DROP TABLE IF EXISTS junk; CREATE TABLE junk (x int);"
  if make -s -C "$ROOT" restore APPS=smokedb; then ok "make restore APPS=smokedb"; else bad "make restore APPS=smokedb"; fi
  rows=$(sql "SELECT string_agg(name, ',' ORDER BY name) FROM items;")
  check "restored rows are exactly the backed-up ones ('$rows')" [ "$rows" = before-backup ]
  junk=$(sql "SELECT count(*) FROM pg_tables WHERE tablename = 'junk';")
  # pg_restore --clean drops only objects that are in the dump; later additions stay.
  log "tables created after the backup and still present after restore: $junk (pg_restore --clean semantics)"
  ready=$(k -n smokedb get deployment smokedb -o jsonpath='{.status.readyReplicas}')
  check "the app Deployment is scaled back up (ready replicas: ${ready:-0})" [ "${ready:-0}" = 1 ]
fi

echo
printf 'smoke: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then printf '  failed: %s\n' "${FAILED[@]}"; exit 1; fi
