#!/usr/bin/env bash
# Brings the whole lab up, in the order docs/architecture.md lists. Every step is
# idempotent: rerun after a partial failure, or on a live cluster to converge it.
#   SKIP_APPS=1  skip step 10 (services/<app> deploys)
. "$(dirname "$0")/lib.sh"

T0=$(date +%s)
timed() { log "$1 done in $(( $(date +%s) - $2 ))s"; }

step "0. tools, secrets, host data directories"
"$ROOT/scripts/tools.sh"
"$ROOT/scripts/secrets.sh"
mkdir -p "$DATA_DIR"
for d in storage backups/storage backups/todo auth; do
  mkdir -p "$DATA_DIR/$d"
  # Pods run as their own non-root users and fsGroup does not apply to hostPath
  # volumes, so the leaf directories are world-writable. .local/ itself is 0700,
  # so no other host user can reach them.
  chmod 0777 "$DATA_DIR/$d"
done
[ "$(stat -c %a "$LOCAL_DIR")" = 700 ] || chmod 700 "$LOCAL_DIR"

# ---------------------------------------------------------------------------
step "1. k3s server ($PROFILE)"
t=$(date +%s)
"$ROOT/scripts/k3s.sh"
timed "k3s" "$t"

step "1b. namespaces"
k apply -f "$ROOT/platform/namespaces/namespaces.yaml" >/dev/null

# ---------------------------------------------------------------------------
step "2. CoreDNS: *.${DOMAIN} and ${DOMAIN} -> traefik.traefik.svc.cluster.local"
# k3s deploys CoreDNS from its own manifests shortly after the API server starts.
wait_for "k3s to deploy CoreDNS" 180 k -n kube-system get deployment/coredns || die "deployment kube-system/coredns does not exist"
# k3s's CoreDNS imports every *.override key of the optional ConfigMap
# kube-system/coredns-custom into its main server block. k3s rewrites its own coredns
# ConfigMap whenever it starts, so that one is never edited.
override=$(render "$ROOT/platform/dns/rewrite.corefile")
current=$(k -n kube-system get configmap coredns-custom -o json 2>/dev/null | jq -r '.data["lab-domain.override"] // ""' || true)
if [ "$override" != "$current" ]; then
  k -n kube-system create configmap coredns-custom --from-literal=lab-domain.override="$override" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  # Restart so the new rule applies now, not whenever the mounted ConfigMap refreshes.
  k -n kube-system rollout restart deployment/coredns >/dev/null
  log "CoreDNS override updated"
fi
wait_rollout kube-system deployment/coredns

# ---------------------------------------------------------------------------
step "3. Prometheus Operator CRDs"
PROMETHEUS_OPERATOR_CRDS_VERSION="$PROMETHEUS_OPERATOR_CRDS_VERSION" bash "$ROOT/platform/observability/install-crds.sh"
wait_crds servicemonitors.monitoring.coreos.com podmonitors.monitoring.coreos.com

# ---------------------------------------------------------------------------
step "4. cert-manager, lab-ca issuer, wildcard certificate"
t=$(date +%s)
helm_repo jetstack https://charts.jetstack.io
h upgrade --install cert-manager jetstack/cert-manager --version "$CERT_MANAGER_CHART_VERSION" \
  --namespace cert-manager --create-namespace -f "$ROOT/platform/cert-manager/values.yaml" --wait --timeout 10m >/dev/null
wait_crds certificates.cert-manager.io clusterissuers.cert-manager.io
k -n cert-manager create secret tls lab-root-ca --cert="$LOCAL_DIR/ca.crt" --key="$LOCAL_DIR/ca.key" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
# The webhook can take a few seconds to accept requests after the rollout.
render "$ROOT/platform/cert-manager/issuers.yaml" > "$LOCAL_DIR/issuers.yaml"
if [ "$CERT_ISSUER" = letsencrypt-dns01 ]; then
  # Remote profile (unverified): Let's Encrypt through DNS-01. See platform/README.md.
  [ -n "$ACME_EMAIL" ] || die "CERT_ISSUER=letsencrypt-dns01 needs ACME_EMAIL"
  [ -s "$LOCAL_DIR/dns01-api-token" ] || die "put the DNS provider API token in .local/dns01-api-token"
  k -n cert-manager create secret generic dns01-api-token --from-file=api-token="$LOCAL_DIR/dns01-api-token" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  render "$ROOT/platform/cert-manager/letsencrypt-dns01.yaml" >> "$LOCAL_DIR/issuers.yaml"
elif [ "$CERT_ISSUER" != lab-ca ]; then
  die "unknown CERT_ISSUER=$CERT_ISSUER (lab-ca or letsencrypt-dns01)"
fi
wait_for "cert-manager webhook" 120 k apply -f "$LOCAL_DIR/issuers.yaml"
k -n traefik wait --for=condition=Ready certificate/lab-wildcard --timeout="$([ "$CERT_ISSUER" = lab-ca ] && echo 180s || echo 900s)" >/dev/null
# CA bundle for in-cluster clients that call https://*.${DOMAIN} (for example k6).
for ns in home storage todo pdf auth loadgen traefik; do
  k -n "$ns" create configmap lab-ca --from-file=ca.crt="$LOCAL_DIR/ca.crt" --dry-run=client -o yaml | k apply -f - >/dev/null
done
timed "cert-manager" "$t"

# ---------------------------------------------------------------------------
step "5. Traefik"
t=$(date +%s)
helm_repo traefik https://traefik.github.io/charts
render "$ROOT/platform/traefik/values.yaml" > "$LOCAL_DIR/traefik-values.yaml"
h upgrade --install traefik traefik/traefik --version "$TRAEFIK_CHART_VERSION" \
  --namespace traefik -f "$LOCAL_DIR/traefik-values.yaml" --wait --timeout 10m >/dev/null
k apply -f "$ROOT/platform/traefik/networkpolicy.yaml" >/dev/null
timed "traefik" "$t"

# ---------------------------------------------------------------------------
step "6. host-backed volumes, Authelia, identity middlewares, users"
t=$(date +%s)
# hostPath can't change on an existing PV, so a PV made for another DATA_DIR (for example
# before the checkout moved) would fail the apply below with a less useful message.
stale=$(k get pv -l app.kubernetes.io/part-of=lab -o json | jq -r --arg d "$DATA_DIR/" \
  '.items[] | select(.spec.hostPath != null and (.spec.hostPath.path | startswith($d) | not)) | "\(.metadata.name) (\(.spec.hostPath.path))"')
[ -z "$stale" ] || die "these volumes point outside DATA_DIR=$DATA_DIR: ${stale//$'\n'/, }. Set DATA_DIR back, or move the data and recreate them (make backup, make down CONFIRM=1, make up, make restore)"
render "$ROOT/platform/storage/storage.yaml" | k apply -f - >/dev/null
# A PV whose claim was deleted is Released and never rebinds; clear the stale claim UID.
for pv in $(k get pv -l app.kubernetes.io/part-of=lab -o jsonpath='{range .items[?(@.status.phase=="Released")]}{.metadata.name}{" "}{end}'); do
  log "releasing stale claim on PV $pv"
  k patch pv "$pv" --type json -p '[{"op":"remove","path":"/spec/claimRef/uid"},{"op":"remove","path":"/spec/claimRef/resourceVersion"}]' >/dev/null
done
render "$ROOT/platform/auth/configuration.yml" > "$LOCAL_DIR/authelia-configuration.yml"
chmod 600 "$LOCAL_DIR/authelia-configuration.yml"
"$ROOT/scripts/authelia-validate.sh" "$LOCAL_DIR/authelia-configuration.yml"
k -n auth create configmap authelia-config --from-file=configuration.yml="$LOCAL_DIR/authelia-configuration.yml" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
k -n auth create secret generic authelia-secrets \
  --from-file=session_secret="$LOCAL_DIR/authelia/session_secret" \
  --from-file=storage_encryption_key="$LOCAL_DIR/authelia/storage_encryption_key" \
  --from-file=jwt_secret="$LOCAL_DIR/authelia/jwt_secret" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
. "$ROOT/scripts/users-lib.sh"
apply_users_secret
AUTHELIA_CONFIG_HASH=$(sha256sum "$LOCAL_DIR/authelia-configuration.yml" | cut -c1-16)
export AUTHELIA_CONFIG_HASH
RENDER_VARS="$RENDER_VARS AUTHELIA_CONFIG_HASH" render "$ROOT/platform/auth/authelia.yaml" | k apply -f - >/dev/null
wait_rollout auth deployment/authelia 300s
timed "authelia" "$t"

# ---------------------------------------------------------------------------
step "7. CloudNativePG operator"
t=$(date +%s)
helm_repo cnpg https://cloudnative-pg.github.io/charts
h upgrade --install cnpg cnpg/cloudnative-pg --version "$CNPG_CHART_VERSION" \
  --namespace cnpg-system -f "$ROOT/platform/cnpg/values.yaml" --wait --timeout 10m >/dev/null
wait_crds clusters.postgresql.cnpg.io
timed "cnpg" "$t"

date -u +%Y-%m-%dT%H:%M:%SZ > "$LOCAL_DIR/cluster-ready"
log "steps 1-7 complete: wrote .local/cluster-ready"

# ---------------------------------------------------------------------------
step "8. observability"
failed=""
if [ -f "$ROOT/platform/observability/install.sh" ]; then
  # A failure here is reported at the end; steps 9 and 10 still run.
  bash "$ROOT/platform/observability/install.sh" || { warn "observability install failed"; failed="$failed observability"; }
else
  warn "platform/observability/install.sh does not exist yet; skipping the observability stack"
fi

# ---------------------------------------------------------------------------
step "9. Stirling PDF and Home"
t=$(date +%s)
render "$ROOT/platform/stirling-pdf/stirling-pdf.yaml" | k apply -f - >/dev/null
"$ROOT/scripts/deploy-app.sh" home
wait_rollout pdf deployment/stirling-pdf 600s
timed "stirling-pdf and home" "$t"

# ---------------------------------------------------------------------------
step "10. apps"
if [ -n "${SKIP_APPS:-}" ]; then
  log "SKIP_APPS set; skipping app deploys"
else
  for dir in "$ROOT"/services/*/; do
    app=$(basename "$dir")
    [ "$app" = home ] && continue
    if [ -f "$dir/Dockerfile" ] && [ -f "$dir/deploy/kustomization.yaml" ]; then
      "$ROOT/scripts/deploy-app.sh" "$app" || failed="$failed $app"
    fi
  done
fi

log "make up finished in $(( $(date +%s) - T0 ))s"
"$ROOT/scripts/status.sh" --urls
[ -z "$failed" ] || die "these steps failed:$failed"
