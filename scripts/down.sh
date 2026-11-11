#!/usr/bin/env bash
# down.sh: uninstalls k3s from this machine (k3s-uninstall.sh), which deletes the cluster with
# every volume k3s provisioned, PostgreSQL's included (the dumps in DATA_DIR are for this).
# Keeps ${DATA_DIR} and .local/ apart from the kubeconfig and the cluster-ready marker.
# Refuses unless CONFIRM=1. Before uninstalling, dumps every database (scripts/backup.sh) and
# refuses when that fails or the cluster is not running, unless SKIP_BACKUP=1.
. "$(dirname "$0")/lib.sh"
. "$ROOT/scripts/db-lib.sh"
if [ "${CONFIRM:-}" != 1 ]; then
  die "this uninstalls k3s and deletes cluster $CLUSTER_NAME with its PostgreSQL volumes (it dumps every database into $DATA_DIR first; data in $DATA_DIR and .local/ stay). Rerun with CONFIRM=1"
fi
uninstall=/usr/local/bin/k3s-uninstall.sh
# refuse_without_dumps REASON: stops before the uninstall, which would lose every database change since the newest dumps.
refuse_without_dumps() {
  warn "$1"
  warn_newest_dumps
  die "not uninstalling: the PostgreSQL volumes would go with every change since the dumps above. Get make backup working and rerun (if k3s is stopped: sudo systemctl start k3s), or rerun with SKIP_BACKUP=1 to uninstall anyway and lose those changes"
}
if [ -x "$uninstall" ]; then
  if [ "${SKIP_BACKUP:-}" = 1 ]; then
    warn "SKIP_BACKUP=1: not dumping the databases; changes since these dumps are lost:"
    warn_newest_dumps
  elif ! cluster_exists; then
    refuse_without_dumps "cannot dump the databases: cluster $CLUSTER_NAME is not running (k3s stopped or $KUBECONFIG missing)"
  elif ! uncovered=$(databases_without_backup); then
    refuse_without_dumps "cannot list the databases to check that each one has a backup CronJob"
  elif [ -n "$uncovered" ]; then
    refuse_without_dumps "no <app>-db-backup CronJob dumps these databases: $(echo "$uncovered" | tr '\n' ' ')"
  elif ! "$ROOT/scripts/backup.sh"; then
    refuse_without_dumps "the database dumps failed (see above)"
  fi
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
