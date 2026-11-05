# shellcheck shell=bash
# Helpers for backup.sh and restore.sh. Source after lib.sh.
# An app takes part when a CronJob named <app>-db-backup exists in any namespace.

# backup_cronjobs [APP...]: prints "NAMESPACE APP" for each matching CronJob.
backup_cronjobs() {
  local want=" $* "
  k get cronjob -A -o json | jq -r '.items[] | select(.metadata.name | endswith("-db-backup"))
      | "\(.metadata.namespace) \(.metadata.name | sub("-db-backup$"; ""))"' \
  | while read -r ns app; do
      if [ "$#" -eq 0 ] || [[ "$want" == *" $app "* ]]; then echo "$ns $app"; fi
    done
}

# wait_job NAMESPACE JOB TIMEOUT_SECONDS: 0 when the Job succeeds, 1 when it fails or times out.
wait_job() {
  local ns="$1" job="$2" timeout="$3" start s f
  start=$(date +%s)
  while :; do
    s=$(k -n "$ns" get job "$job" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
    f=$(k -n "$ns" get job "$job" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)
    [ "${s:-0}" -ge 1 ] && return 0
    [ "$f" = True ] && break
    [ $(( $(date +%s) - start )) -ge "$timeout" ] && { warn "job $ns/$job timed out"; break; }
    sleep 3
  done
  k -n "$ns" logs "job/$job" --all-containers --tail=50 >&2 || true
  return 1
}
