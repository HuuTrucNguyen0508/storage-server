#!/usr/bin/env bash
# restore.sh [APP...]: for every app with an <app>-db-backup CronJob (or only the named
# apps): scale the app's Deployments to 0, restore the newest /backups/<app>-*.dump with
# `pg_restore --clean --if-exists --no-owner` in a one-off Job built from the CronJob's
# pod template (same image, labels, volumes and security context), then scale back.
#   DUMP=<file name>  restore that dump instead of the newest (single app only)
. "$(dirname "$0")/lib.sh"
. "$ROOT/scripts/db-lib.sh"
require_cluster
list=$(backup_cronjobs "$@")
[ -n "$list" ] || die "no <app>-db-backup CronJobs found${*:+ for: $*}"
if [ -n "${DUMP:-}" ] && [ "$(wc -l <<< "$list")" -ne 1 ]; then die "DUMP needs exactly one app"; fi

restore_app() {
  local ns="$1" app="$2" state="$LOCAL_DIR/restore-$1-$2.replicas" cj job script
  cj=$(k -n "$ns" get cronjob "${app}-db-backup" -o json)

  # Remember replica counts on disk so an interrupted restore can be rerun safely.
  if [ ! -s "$state" ]; then
    k -n "$ns" get deployment -o json | jq -r '.items[] | "\(.metadata.name) \(.spec.replicas // 1)"' > "$state"
  fi
  log "$app: scaling Deployments in $ns to 0"
  while read -r d _; do [ -n "$d" ] && k -n "$ns" scale deployment "$d" --replicas=0 >/dev/null; done < "$state"
  while read -r d _; do
    [ -n "$d" ] && wait_for "$ns/$d to stop" 300 bash -c "[ \"\$(kubectl --context $KCTX -n $ns get deployment $d -o jsonpath='{.status.replicas}')\" = '' ] || [ \"\$(kubectl --context $KCTX -n $ns get deployment $d -o jsonpath='{.status.replicas}')\" = 0 ]"
  done < "$state"

  script='set -eu
if [ -n "${DUMP:-}" ]; then f="/backups/$DUMP"; else
  f=$(ls -1 /backups/ | grep -E "^${APP}-[0-9]{8}T[0-9]{6}Z\.dump$" | sort | tail -n 1); f="/backups/$f"; fi
[ -f "$f" ] || { echo "no dump found for ${APP} in /backups" >&2; exit 1; }
echo "restoring $f"
# Extensions are created by the database bootstrap as the superuser, which the app user
# cannot drop, so the restore leaves them out of its table of contents.
pg_restore -l "$f" | grep -vE " (EXTENSION -|COMMENT - EXTENSION) " \
  | pg_restore -L /dev/stdin --clean --if-exists --no-owner --exit-on-error --single-transaction --dbname "$RESTORE_URI" "$f"
echo "restore complete: $f"'
  job="${app}-db-restore-$(date -u +%Y%m%d%H%M%S)"
  printf '%s' "$cj" | jq --arg job "$job" --arg app "$app" --arg script "$script" --arg dump "${DUMP:-}" '
    .spec.jobTemplate.spec.template as $t
    | ($t.spec.containers[0]) as $c
    | ($c.volumeMounts // [] | map(select(.mountPath == "/backups")) | first) as $m
    | if $m == null then error("CronJob has no volume mounted at /backups") else . end
    | {apiVersion: "batch/v1", kind: "Job",
       metadata: {name: $job, namespace: .metadata.namespace,
                  labels: ((.metadata.labels // {}) + {"app.kubernetes.io/component": "db-restore"})},
       spec: {backoffLimit: 0, ttlSecondsAfterFinished: 86400,
              template: {metadata: {labels: ($t.metadata.labels // {})},
                spec: ($t.spec + {restartPolicy: "Never",
                  volumes: ($t.spec.volumes // [] | map(select(.name == $m.name or .emptyDir != null))),
                  containers: [{name: "restore", image: $c.image, imagePullPolicy: ($c.imagePullPolicy // "IfNotPresent"),
                    securityContext: $c.securityContext, resources: $c.resources,
                    command: ["sh", "-c", $script],
                    env: [{name: "APP", value: $app}, {name: "DUMP", value: $dump},
                          {name: "RESTORE_URI", valueFrom: {secretKeyRef: {name: ($app + "-db-app"), key: "uri"}}}],
                    volumeMounts: ([{name: $m.name, mountPath: "/backups", readOnly: true}]
                      + ($c.volumeMounts // [] | map(select(.mountPath != "/backups"))
                         | map(select(.name as $n | $t.spec.volumes // [] | any(.name == $n and .emptyDir != null)))))}]})}}}' \
    | k apply -f - >/dev/null
  log "$app: restoring with job $ns/$job"
  local ok=0
  wait_job "$ns" "$job" "${RESTORE_TIMEOUT:-1800}" && ok=1
  k -n "$ns" logs "job/$job" --tail=5 2>/dev/null | sed 's/^/    /' || true

  log "$app: scaling Deployments back"
  while read -r d r; do [ -n "$d" ] && k -n "$ns" scale deployment "$d" --replicas="$r" >/dev/null; done < "$state"
  while read -r d r; do [ -n "$d" ] && [ "$r" -gt 0 ] && wait_rollout "$ns" "deployment/$d" 600s; done < "$state"
  rm -f "$state"
  [ "$ok" = 1 ] || { warn "$app restore FAILED (the app is running again on its current data)"; return 1; }
  log "$app restore OK"
}

rc=0
while read -r ns app; do restore_app "$ns" "$app" || rc=1; done <<< "$list"
exit "$rc"
