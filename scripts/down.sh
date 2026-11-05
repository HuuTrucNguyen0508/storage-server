#!/usr/bin/env bash
# down.sh: uninstalls k3s from this machine (k3s-uninstall.sh), which deletes the cluster with
# every volume k3s provisioned, PostgreSQL's included (the dumps in DATA_DIR are for this).
# Keeps ${DATA_DIR} and .local/ apart from the kubeconfig and the cluster-ready marker.
# Refuses unless CONFIRM=1.
. "$(dirname "$0")/lib.sh"
if [ "${CONFIRM:-}" != 1 ]; then
  die "this uninstalls k3s and deletes cluster $CLUSTER_NAME with its PostgreSQL volumes (data in $DATA_DIR and .local/ stay; make backup first). Rerun with CONFIRM=1"
fi
uninstall=/usr/local/bin/k3s-uninstall.sh
if [ -x "$uninstall" ]; then
  log "uninstalling k3s (sudo may ask for your password)"
  sudo "$uninstall" >&2
else
  log "k3s is not installed ($uninstall does not exist)"
fi
# Drop the context scripts/k3s.sh merged into ~/.kube/config.
user_cfg="$HOME/.kube/config"
if [ -f "$user_cfg" ]; then
  if [ "$(kubectl --kubeconfig "$user_cfg" config current-context 2>/dev/null || true)" = "$KCTX" ]; then
    kubectl --kubeconfig "$user_cfg" config unset current-context >/dev/null 2>&1 || true
  fi
  kubectl --kubeconfig "$user_cfg" config delete-context "$KCTX" >/dev/null 2>&1 || true
  kubectl --kubeconfig "$user_cfg" config delete-cluster "$KCTX" >/dev/null 2>&1 || true
  kubectl --kubeconfig "$user_cfg" config delete-user "$KCTX" >/dev/null 2>&1 || true
fi
# A kubeconfig that holds only the old kind cluster's context stays: its migration needs it.
if kubectl --kubeconfig "$KUBECONFIG" config get-contexts "$KCTX" >/dev/null 2>&1; then rm -f "$KUBECONFIG"; fi
rm -f "$LOCAL_DIR/cluster-ready"
log "done; kept $DATA_DIR and $LOCAL_DIR"
