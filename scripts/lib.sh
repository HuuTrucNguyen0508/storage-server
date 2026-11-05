# shellcheck shell=bash
# Shared helpers for every platform script. Source it: `. "$(dirname "$0")/lib.sh"`.
# Loads config/local.env, config/versions.env, then optional config/override.env.
# A variable already set in the caller's environment wins over the files
# (so `PROFILE=ci make up` works), except for the version pins.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="$ROOT/.local"

log()  { printf '\033[1;34m[lab]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[lab] warning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[lab] error:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*" >&2; }

load_env_file() {
  local file="$1" line key
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    [[ "$line" =~ [[:space:]]# ]] && die "inline comments are not supported in $file: $line"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "bad line in $file: $line"
    # Caller environment wins for settings, not for pins in versions.env.
    if [ "${2:-}" != pins ] && [ -n "${__LAB_ENV_KEYS:-}" ] && [[ " $__LAB_ENV_KEYS " == *" $key "* ]]; then
      continue
    fi
    export "$key=${line#*=}"
  done < "$file"
}

if [ -z "${__LAB_LOADED:-}" ]; then
  __LAB_ENV_KEYS=""
  for __k in PROFILE DOMAIN CLUSTER_NAME LISTEN_ADDRESS HTTP_PORT HTTPS_PORT AUTH_POLICY ENVIRONMENT DATA_DIR CERT_ISSUER ACME_EMAIL; do
    if [ -n "${!__k+x}" ]; then __LAB_ENV_KEYS="$__LAB_ENV_KEYS $__k"; fi
  done
  load_env_file "$ROOT/config/local.env"
  load_env_file "$ROOT/config/versions.env" pins
  load_env_file "$ROOT/config/override.env"
  export __LAB_LOADED=1
fi

# Derived values.
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$ROOT/$DATA_DIR" ;; esac
export DATA_DIR
export KCTX="kind-${CLUSTER_NAME}"
export KUBECONFIG="$LOCAL_DIR/kubeconfig"
export HELM_KUBECONTEXT="$KCTX"
export AUTH_PUBLIC_URL="https://auth.${DOMAIN}"
export HOME_URL="https://home.${DOMAIN}/"
export DOMAIN_REGEX="${DOMAIN//./\\.}"
export IMAGE_TAG="${IMAGE_TAG:-}"
export CERT_ISSUER="${CERT_ISSUER:-lab-ca}"
export ACME_EMAIL="${ACME_EMAIL:-}"
export PATH="$LOCAL_DIR/bin:$PATH"

# Variables `render` may substitute. Anything else with a `$` is left alone.
RENDER_VARS="PROFILE DOMAIN DOMAIN_REGEX CLUSTER_NAME LISTEN_ADDRESS HTTP_PORT HTTPS_PORT
AUTH_POLICY ENVIRONMENT DATA_DIR IMAGE_TAG AUTH_PUBLIC_URL HOME_URL CERT_ISSUER ACME_EMAIL KIND_NODE_IMAGE AUTHELIA_IMAGE
STIRLING_PDF_IMAGE NGINX_UNPRIVILEGED_IMAGE WHOAMI_IMAGE POSTGRES_CLIENT_IMAGE CURL_IMAGE"

# render FILE... (or stdin): envsubst limited to RENDER_VARS.
render() {
  local allow="" v
  for v in $RENDER_VARS; do allow="$allow\${$v} "; done
  if [ "$#" -eq 0 ]; then envsubst "$allow"; else cat "$@" | envsubst "$allow"; fi
}

k() { kubectl --context "$KCTX" "$@"; }
h() { helm --kube-context "$KCTX" "$@"; }

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; }
require_cluster() { cluster_exists || die "cluster $CLUSTER_NAME does not exist; run make up"; }

# wait_for DESCRIPTION TIMEOUT_SECONDS COMMAND...: retry COMMAND until it succeeds.
wait_for() {
  local what="$1" timeout="$2" start; shift 2
  start=$(date +%s)
  until "$@" >/dev/null 2>&1; do
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      warn "timed out after ${timeout}s waiting for $what"; "$@" || true; return 1
    fi
    sleep 2
  done
}

wait_rollout() { # NAMESPACE KIND/NAME [TIMEOUT]
  k -n "$1" rollout status "$2" --timeout="${3:-300s}"
}

wait_crds() { # CRD names...
  local c
  for c in "$@"; do k wait --for=condition=Established "crd/$c" --timeout=120s >/dev/null; done
}

helm_repo() { # NAME URL
  helm repo list -o json 2>/dev/null | jq -e --arg n "$1" --arg u "$2" '.[] | select(.name==$n and .url==$u)' >/dev/null \
    || helm repo add "$1" "$2" --force-update >/dev/null
}

# Credentials file helpers.
creds_file() { echo "$LOCAL_DIR/credentials.env"; }
load_creds() {
  [ -f "$(creds_file)" ] || die "$(creds_file) is missing; run scripts/secrets.sh"
  load_env_file "$(creds_file)" pins
}
