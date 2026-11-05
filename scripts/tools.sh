#!/usr/bin/env bash
# Downloads the pinned kind and kubectl into .local/bin and verifies their SHA-256.
# Idempotent: a binary already present with the right checksum is kept.
. "$(dirname "$0")/lib.sh"

case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
[ "$(uname -s)" = Linux ] || die "only Linux hosts are supported by scripts/tools.sh"
ARCH_UPPER=$(echo "$arch" | tr a-z A-Z)

install_tool() { # NAME URL SHA256
  local name="$1" url="$2" sum="$3" dest="$LOCAL_DIR/bin/$1" tmp
  if [ -x "$dest" ] && echo "$sum  $dest" | sha256sum -c --status; then return 0; fi
  log "downloading $name from $url"
  tmp=$(mktemp "$LOCAL_DIR/bin/.$name.XXXXXX")
  curl -fsSL --retry 3 -o "$tmp" "$url"
  if ! echo "$sum  $tmp" | sha256sum -c --status; then
    rm -f "$tmp"; die "checksum mismatch for $name ($url)"
  fi
  chmod 0755 "$tmp"; mv "$tmp" "$dest"
}

mkdir -p "$LOCAL_DIR/bin"; chmod 700 "$LOCAL_DIR"
kind_sum_var="KIND_SHA256_LINUX_${ARCH_UPPER}"; kubectl_sum_var="KUBECTL_SHA256_LINUX_${ARCH_UPPER}"
install_tool kind "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${arch}" "${!kind_sum_var}"
install_tool kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" "${!kubectl_sum_var}"

for t in helm docker envsubst jq curl openssl; do
  command -v "$t" >/dev/null || die "$t is required on PATH"
done
