#!/usr/bin/env bash
# backup.sh [APP...]: runs `kubectl create job --from=cronjob/<app>-db-backup` for every
# app that has one (or only the named apps) and waits for each dump.
. "$(dirname "$0")/lib.sh"
. "$ROOT/scripts/db-lib.sh"
require_cluster
list=$(backup_cronjobs "$@")
[ -n "$list" ] || { warn "no <app>-db-backup CronJobs found${*:+ for: $*}"; exit 0; }
rc=0
while read -r ns app; do
  job="${app}-db-backup-manual-$(date -u +%Y%m%d%H%M%S)"
  log "backing up $app (namespace $ns) with job $job"
  k -n "$ns" create job "$job" --from="cronjob/${app}-db-backup" >/dev/null
  if wait_job "$ns" "$job" "${BACKUP_TIMEOUT:-1800}"; then
    k -n "$ns" logs "job/$job" --all-containers --tail=5 2>/dev/null | sed 's/^/    /' || true
    if [ -d "$DATA_DIR/backups/$app" ]; then
      newest=$(find "$DATA_DIR/backups/$app" -maxdepth 1 -type f -name "${app}-*T*Z.dump" -printf '%f\n' 2>/dev/null | sort | tail -n 1 || true)
      [ -n "$newest" ] && log "newest dump: $DATA_DIR/backups/$app/$newest"
    fi
    log "$app backup OK"
  else
    warn "$app backup FAILED"; rc=1
  fi
done <<< "$list"
exit "$rc"
