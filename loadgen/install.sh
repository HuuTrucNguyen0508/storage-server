#!/usr/bin/env bash
# Installs the load generator into namespace loadgen: the loadgen user's credentials as a
# Secret (made from .local/credentials.env), the k6 scripts and fixtures as ConfigMaps, the
# synthetic-check CronJob, its alert rules and a default-deny NetworkPolicy.
# Idempotent. loadgen/run.sh calls it first, so a run always uses the scripts on disk.
#
#   loadgen/install.sh            apply everything
#   loadgen/install.sh --delete   remove the CronJob, rules, scripts and Secret
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"

HERE="$ROOT/loadgen"
require_cluster
k get namespace loadgen >/dev/null 2>&1 || die "namespace loadgen does not exist; run make up"

if [ "${1:-}" = "--delete" ]; then
  kubectl kustomize --load-restrictor LoadRestrictionsNone "$HERE/deploy" | k delete --ignore-not-found -f -
  k -n loadgen delete secret loadgen-credentials --ignore-not-found
  exit 0
fi

[ -f "$HERE/fixtures/photo.png" ] || { log "generating fixtures"; node "$HERE/fixtures/generate.mjs" >/dev/null; }

# Every script must be listed in deploy/kustomization.yaml, or the pod cannot import it.
for f in "$HERE"/src/*/*.js "$HERE"/fixtures/*.{pdf,docx,png,md}; do
  grep -q "=../${f#"$HERE"/}\$" "$HERE/deploy/kustomization.yaml" || die "${f#"$ROOT"/} is not listed in loadgen/deploy/kustomization.yaml"
done

load_creds
: "${LOADGEN_USER:?LOADGEN_USER missing from $(creds_file)}"
: "${LOADGEN_PASSWORD:?LOADGEN_PASSWORD missing from $(creds_file)}"

# The Secret holds the password; it never appears in a manifest on disk.
k -n loadgen create secret generic loadgen-credentials \
  --from-literal=LOADGEN_USER="$LOADGEN_USER" \
  --from-literal=LOADGEN_PASSWORD="$LOADGEN_PASSWORD" \
  --dry-run=client -o yaml \
  | k label --local -f - -o yaml app.kubernetes.io/name=loadgen app.kubernetes.io/part-of=lab app.kubernetes.io/component=credentials \
  | k apply -f - >/dev/null

# Server-side apply: the script ConfigMaps are bigger than client-side apply's annotation allows.
# Only the CronJob goes through `render`: envsubst would also rewrite ${PROFILE} and ${DOMAIN}
# inside the JavaScript template literals of the script ConfigMaps.
built="$(kubectl kustomize --load-restrictor LoadRestrictionsNone "$HERE/deploy")"
apply() { k apply --server-side --force-conflicts --field-manager=loadgen-install -f - >/dev/null; }
yq 'select(.kind != "CronJob")' <<<"$built" | apply
yq 'select(.kind == "CronJob")' <<<"$built" | render | apply
log "loadgen installed: CronJob synthetic-checks (every 5 minutes), scripts, rules"
