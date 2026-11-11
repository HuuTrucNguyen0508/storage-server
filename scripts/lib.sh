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
  for __k in PROFILE DOMAIN CLUSTER_NAME LISTEN_ADDRESS HTTP_PORT HTTPS_PORT AUTH_POLICY ENVIRONMENT DATA_DIR DATA_GID CERT_ISSUER ACME_EMAIL RESTIC_REPOSITORY RESTIC_PASSWORD_FILE; do
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
# make down runs k3s-uninstall.sh, which deletes these directories; DATA_DIR must outlive it.
__data_real=$(realpath -m -- "$DATA_DIR" 2>/dev/null || printf '%s' "$DATA_DIR")
for __d in /etc/rancher /run/k3s /run/flannel /var/lib/rancher /var/lib/kubelet /var/lib/cni; do
  case "$__data_real/" in "$__d"/*) die "DATA_DIR=$DATA_DIR is inside $__d, which make down (k3s-uninstall.sh) deletes" ;; esac
done
# The storage pod's group (runAsGroup). It writes DATA_DIR/storage group-readable, so the
# host user in this group can read the uploaded files: make offsite runs restic as that user.
DATA_GID="${DATA_GID:-$(id -g)}"
[[ "$DATA_GID" =~ ^[0-9]{1,10}$ ]] && [ "$DATA_GID" -le 2147483647 ] \
  || die "DATA_GID=$DATA_GID: must be a numeric group ID"
[ "$DATA_GID" -ne 0 ] || die "DATA_GID is 0 (root's group): run the lab as your own user, not root, or set DATA_GID in config/override.env to a non-root group"
export DATA_GID
# Traefik's Service takes HTTP_PORT and HTTPS_PORT as node ports (cluster/k3s.yaml), and
# kube-proxy serves them on LISTEN_ADDRESS only.
for __p in HTTP_PORT HTTPS_PORT; do
  [[ "${!__p}" =~ ^[1-9][0-9]{0,4}$ ]] && [ "${!__p}" -le 32767 ] \
    || die "$__p=${!__p}: must be a port from 1 to 32767 (k3s serves it as a node port)"
done
[ "$HTTP_PORT" != "$HTTPS_PORT" ] || die "HTTP_PORT and HTTPS_PORT must differ"
[[ "$LISTEN_ADDRESS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "LISTEN_ADDRESS=$LISTEN_ADDRESS: must be an IPv4 address"
export NODE_PORT_RANGE="$(( HTTP_PORT < HTTPS_PORT ? HTTP_PORT : HTTPS_PORT ))-32767"
if [ "$LISTEN_ADDRESS" = 0.0.0.0 ]; then NODE_PORT_ADDRESSES=0.0.0.0/0; else NODE_PORT_ADDRESSES="$LISTEN_ADDRESS/32"; fi
export NODE_PORT_ADDRESSES
# k3s: the verified downloads (scripts/tools.sh) and the system-wide install (scripts/k3s.sh).
export K3S_DOWNLOAD="$LOCAL_DIR/k3s/k3s-${K3S_VERSION}"
export K3S_INSTALLER="$LOCAL_DIR/k3s/install-${K3S_VERSION}.sh"
export K3S_BIN=/usr/local/bin/k3s
export KCTX="k3s-${CLUSTER_NAME}"
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
AUTH_POLICY ENVIRONMENT DATA_DIR DATA_GID IMAGE_TAG AUTH_PUBLIC_URL HOME_URL CERT_ISSUER ACME_EMAIL NODE_PORT_RANGE
NODE_PORT_ADDRESSES AUTHELIA_IMAGE STIRLING_PDF_IMAGE NGINX_UNPRIVILEGED_IMAGE WHOAMI_IMAGE POSTGRES_CLIENT_IMAGE CURL_IMAGE"

# render FILE... (or stdin): envsubst limited to RENDER_VARS.
render() {
  local allow="" v
  for v in $RENDER_VARS; do allow="$allow\${$v} "; done
  if [ "$#" -eq 0 ]; then envsubst "$allow"; else cat "$@" | envsubst "$allow"; fi
}

k() { kubectl --context "$KCTX" "$@"; }
h() { helm --kube-context "$KCTX" "$@"; }

# The cluster exists when k3s is installed, its service is running and make up wrote the kubeconfig.
cluster_exists() { [ -x "$K3S_BIN" ] && [ -f "$KUBECONFIG" ] && systemctl is-active --quiet k3s 2>/dev/null; }
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
