#!/usr/bin/env bash
# k3s.sh: installs or converges the native single-node k3s server (make up step 1) and
# writes .local/kubeconfig with context k3s-${CLUSTER_NAME}. Idempotent, and it uses sudo
# only when something must change: another k3s version, a changed
# /etc/rancher/k3s/config.yaml, a stopped service, or a kubeconfig that no longer works.
# Needs the verified downloads from scripts/tools.sh.
. "$(dirname "$0")/lib.sh"

K3S_CONFIG=/etc/rancher/k3s/config.yaml

# A kind cluster from before the move to k3s holds the host ports, and deleting it deletes
# its PostgreSQL volumes: the user has to back up first.
if docker ps -a -q --filter "label=io.x-k8s.kind.cluster=${CLUSTER_NAME}" \
     --filter "name=^${CLUSTER_NAME}-control-plane\$" 2>/dev/null | grep -q .; then
  die "the old kind cluster $CLUSTER_NAME still exists (container ${CLUSTER_NAME}-control-plane holds ports ${HTTP_PORT}/${HTTPS_PORT}).
Migrate as platform/README.md (\"Migration from kind\") describes:
  1. with the previous checkout: make backup
  2. .local/bin/kind delete cluster --name ${CLUSTER_NAME}   (PostgreSQL volumes go; DATA_DIR and .local/ stay)
  3. with this checkout: make up, then make restore"
fi

# kube-proxy serves the node ports with nat rules that match before the kernel looks for a
# socket, so a process already listening on them at LISTEN_ADDRESS (or on every address)
# would silently stop getting that traffic. kube-proxy opens no socket of its own, so the
# check also holds on reruns.
busy=$(ss -Hltn "( sport = :$HTTP_PORT or sport = :$HTTPS_PORT )" | awk -v want="$LISTEN_ADDRESS" '{
  a = $4; sub(/:[0-9]+$/, "", a); sub(/%.*/, "", a)
  if (a == want || a == "0.0.0.0" || a == "*" || a == "[::]" || (want == "0.0.0.0" && a !~ /^\[/)) print $4
}')
[ -z "$busy" ] || die "another process listens on ${busy//$'\n'/, } and kube-proxy would take that traffic over; stop it, or set LISTEN_ADDRESS, HTTP_PORT or HTTPS_PORT in config/override.env"

# The API server reads time zones from the host, and the backup CronJobs set timeZone.
[ -e /usr/share/zoneinfo/Etc/UTC ] || die "the host has no time zone data (/usr/share/zoneinfo); install the tzdata package"

[ -x "$K3S_DOWNLOAD" ] && [ -f "$K3S_INSTALLER" ] || die "$K3S_DOWNLOAD is missing; run scripts/tools.sh"
cfg="$LOCAL_DIR/k3s-config.yaml"
render "$ROOT/cluster/k3s.yaml" > "$cfg"

# What needs to change. The installed config is world-readable, so this needs no sudo.
changes=""
installed=$("$K3S_BIN" --version 2>/dev/null | awk 'NR == 1 {print $3}' || true)
[ "$installed" = "$K3S_VERSION" ] || changes="$changes; installed: ${installed:-none}"
cmp -s "$cfg" "$K3S_CONFIG" 2>/dev/null || changes="$changes; $K3S_CONFIG differs from cluster/k3s.yaml"
systemctl is-active --quiet k3s || changes="$changes; the k3s service is not running"
systemctl is-enabled --quiet k3s 2>/dev/null || changes="$changes; the k3s service does not start on boot"

if [ -n "$changes" ]; then
  log "installing k3s $K3S_VERSION (${changes#; }); sudo may ask for your password"
  # Explicit modes: with umask 077, install -D would make the directories 0700 and the
  # unprivileged cmp above would see a difference on every run.
  sudo install -d -m 0755 /etc/rancher "$(dirname "$K3S_CONFIG")"
  sudo install -m 0644 "$cfg" "$K3S_CONFIG"
  cmp -s "$K3S_DOWNLOAD" "$K3S_BIN" || sudo install -m 0755 "$K3S_DOWNLOAD" "$K3S_BIN"
  # install.sh only restarts the service when the binary or the unit changed; a changed
  # config or a stopped service needs the restart too. It skips the download (the binary
  # above is already verified) and the kubectl/crictl/ctr symlinks (kubectl is pinned in
  # .local/bin), and writes /usr/local/bin/k3s-uninstall.sh, which make down runs.
  sudo env INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_SYMLINK=skip INSTALL_K3S_VERSION="$K3S_VERSION" \
    INSTALL_K3S_FORCE_RESTART=true sh "$K3S_INSTALLER" >&2
else
  log "k3s $K3S_VERSION already running"
fi

api_ready() { kubectl --kubeconfig "$KUBECONFIG" --context "$KCTX" get --raw /readyz >/dev/null 2>&1; }

# k3s names its cluster, user and context "default"; rename them to $KCTX. The JSON that
# kubectl config view writes is a valid kubeconfig.
if [ ! -s "$KUBECONFIG" ] || ! api_ready; then
  log "writing $KUBECONFIG from /etc/rancher/k3s/k3s.yaml (sudo)"
  wait_for "k3s to write /etc/rancher/k3s/k3s.yaml" 120 sudo test -s /etc/rancher/k3s/k3s.yaml \
    || die "k3s did not write /etc/rancher/k3s/k3s.yaml; see: sudo journalctl -u k3s"
  tmp=$(mktemp "$LOCAL_DIR/.kubeconfig.XXXXXX")
  if sudo cat /etc/rancher/k3s/k3s.yaml | kubectl config view --kubeconfig /dev/stdin --raw -o json \
    | jq -e --arg n "$KCTX" '
        if [.clusters, .users, .contexts | length] == [1, 1, 1] then
          .clusters[0].name = $n | .users[0].name = $n
          | .contexts[0] |= (.name = $n | .context.cluster = $n | .context.user = $n)
          | .["current-context"] = $n
        else error("expected one cluster, user and context") end' > "$tmp"; then
    chmod 600 "$tmp"; mv "$tmp" "$KUBECONFIG"
  else
    rm -f "$tmp"; die "could not convert /etc/rancher/k3s/k3s.yaml into $KUBECONFIG"
  fi
fi
wait_for "the k3s API server" 180 api_ready || die "the k3s API server is not ready; see: sudo journalctl -u k3s"
node_registered() { k get nodes -o name | grep -q .; }
wait_for "the node to register" 120 node_registered || die "no node registered; see: sudo journalctl -u k3s"
k wait --for=condition=Ready nodes --all --timeout=180s >/dev/null

# Best effort: also add the context to ~/.kube/config so
# `kubectl --context $KCTX` works from anywhere. Entries in .local/kubeconfig win.
merge_user_kubeconfig() {
  local dir="$HOME/.kube" tmp
  mkdir -p "$dir" || return 1
  tmp=$(mktemp "$dir/.config.XXXXXX") || return 1
  if KUBECONFIG="$KUBECONFIG:$dir/config" kubectl config view --raw > "$tmp"; then
    chmod 600 "$tmp" && mv "$tmp" "$dir/config"
  else
    rm -f "$tmp"; return 1
  fi
}
merge_user_kubeconfig || warn "could not add context $KCTX to ~/.kube/config"
