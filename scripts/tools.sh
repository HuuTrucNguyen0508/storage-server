#!/usr/bin/env bash
# Downloads the pinned kubectl into .local/bin, and the pinned k3s binary and its install
# script into .local/k3s (not on PATH: scripts/k3s.sh installs them system-wide), and
# verifies every SHA-256. Idempotent: a file already present with the right checksum is kept.
. "$(dirname "$0")/lib.sh"

case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
[ "$(uname -s)" = Linux ] || die "only Linux hosts are supported by scripts/tools.sh"
ARCH_UPPER=$(echo "$arch" | tr a-z A-Z)

# k3s runs as a systemd service, and installing it needs root. scripts/k3s.sh checks the
# node ports with ss.
for t in helm docker envsubst jq curl openssl sudo systemctl ss; do
  command -v "$t" >/dev/null || die "$t is required on PATH"
done

fetch() { # DEST URL SHA256
  local dest="$1" url="$2" sum="$3" tmp
  if [ -x "$dest" ] && echo "$sum  $dest" | sha256sum -c --status; then return 0; fi
  log "downloading $(basename "$dest") from $url"
  tmp=$(mktemp "$(dirname "$dest")/.$(basename "$dest").XXXXXX")
  curl -fsSL --retry 3 -o "$tmp" "$url"
  if ! echo "$sum  $tmp" | sha256sum -c --status; then
    rm -f "$tmp"; die "checksum mismatch for $(basename "$dest") ($url)"
  fi
  chmod 0755 "$tmp"; mv "$tmp" "$dest"
}

mkdir -p "$LOCAL_DIR/bin" "$LOCAL_DIR/k3s"; chmod 700 "$LOCAL_DIR"
kubectl_sum_var="KUBECTL_SHA256_LINUX_${ARCH_UPPER}"; k3s_sum_var="K3S_SHA256_LINUX_${ARCH_UPPER}"
fetch "$LOCAL_DIR/bin/kubectl" "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" "${!kubectl_sum_var}"
# The amd64 asset is plain "k3s"; the release tag's "+" is %2B in the download URL.
k3s_asset=k3s; [ "$arch" = amd64 ] || k3s_asset="k3s-$arch"
fetch "$K3S_DOWNLOAD" "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION//+/%2B}/${k3s_asset}" "${!k3s_sum_var}"
fetch "$K3S_INSTALLER" "https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION}/install.sh" "$K3S_INSTALL_SH_SHA256"
