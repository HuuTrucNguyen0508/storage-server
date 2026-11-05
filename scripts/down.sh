#!/usr/bin/env bash
# down.sh: deletes the kind cluster. Never touches ${DATA_DIR} or .local/.
# Refuses unless CONFIRM=1.
. "$(dirname "$0")/lib.sh"
if [ "${CONFIRM:-}" != 1 ]; then
  die "this deletes cluster $CLUSTER_NAME (data in $DATA_DIR and .local/ stay). Rerun with CONFIRM=1"
fi
if cluster_exists; then
  kind delete cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG"
  env -u KUBECONFIG kubectl config delete-context "$KCTX" >/dev/null 2>&1 || true
else
  log "cluster $CLUSTER_NAME does not exist"
fi
rm -f "$LOCAL_DIR/cluster-ready"
log "cluster deleted; kept $DATA_DIR and $LOCAL_DIR"
