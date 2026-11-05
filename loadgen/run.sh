#!/usr/bin/env bash
# Runs a k6 profile inside the cluster as a Job in namespace loadgen, follows its log and
# exits with k6's exit code (0 passed, 99 a threshold failed, 108 interrupted, other: error).
#
#   loadgen/run.sh <profile> [app[,app...]]      profile: smoke load stress spike soak
#   make load-smoke      make load-load      make load-stress      ...
#
# Environment knobs (all optional, passed to k6 as it is):
#   VUS (20)  LOAD_MINUTES (10)  STRESS_STEPS ("2,4,8,12,16,24,32,48,64")  STEP_SECONDS (50)
#   SPIKE_FACTOR (2)  SOAK_VUS (4)  SOAK_DURATION (1h)  THINK (1)  OFFICE_SHARE (0.1)
#   MEDIUM_MIN_MIB (1)  MEDIUM_MAX_MIB (3)  TESTID (<profile>-<app>-<time>)
#   KEEP=1 keeps the Job (default: it is kept 24 h, then removed by the Job controller)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"

PROFILE="${1:-}"
APP="${2:-all}"
case "$PROFILE" in smoke|load|stress|spike|soak) ;; *) die "usage: loadgen/run.sh <smoke|load|stress|spike|soak> [app[,app...]]" ;; esac

require_cluster
"$ROOT/loadgen/install.sh"

STAMP="$(date -u +%Y%m%d%H%M%S)"
JOB="k6-${PROFILE}-${STAMP}"
APP_LABEL="$(printf '%s' "$APP" | tr ',' '-')"
TESTID="${TESTID:-${PROFILE}-${APP_LABEL}-${STAMP}}"
DEADLINE=14400; [ "$PROFILE" = smoke ] && DEADLINE=300

# Knobs that exist in the caller's environment are passed on as Job env.
EXTRA='[]'
for v in VUS LOAD_MINUTES STRESS_STEPS STEP_SECONDS RAMP_SECONDS SPIKE_FACTOR SOAK_VUS SOAK_DURATION THINK OFFICE_SHARE MEDIUM_MIN_MIB MEDIUM_MAX_MIB CHUNK_BYTES SMOKE_TIMEOUT MIN_ITERATION_SECONDS LOGIN_MODE LOGIN_TRIES LOGIN_STAGGER; do
  if [ -n "${!v+x}" ]; then EXTRA="$(jq -c --arg n "$v" --arg val "${!v}" '. + [{name:$n,value:$val}]' <<<"$EXTRA")"; fi
done

# Clone the CronJob (without its owner reference: the CronJob controller would otherwise
# count this Job in its history limit and delete it)'s pod template (one definition of image, security context, mounts and
# env), then set what differs for this run.
k -n loadgen create job "$JOB" --from=cronjob/synthetic-checks --dry-run=client -o json \
  | jq --arg profile "$PROFILE" --arg app "$APP" --arg testid "$TESTID" --argjson deadline "$DEADLINE" --argjson extra "$EXTRA" '
      del(.metadata.ownerReferences)
      | .metadata.labels["loadgen/profile"] = $profile
      | .metadata.labels["app.kubernetes.io/component"] = "run"
      | .metadata.annotations = ((.metadata.annotations // {}) | del(."cronjob.kubernetes.io/instantiate"))
      | .spec.activeDeadlineSeconds = $deadline
      | .spec.ttlSecondsAfterFinished = 86400
      | .spec.template.metadata.labels["app.kubernetes.io/component"] = "run"
      | .spec.template.spec.containers[0].env |= (
          map(select(.name as $n | (["PROFILE","APP","TESTID"] + ($extra | map(.name))) | index($n) | not))
          + [{name:"PROFILE",value:$profile},{name:"APP",value:$app},{name:"TESTID",value:$testid}] + $extra)' \
  | k create -f - >/dev/null
log "job $JOB: profile=$PROFILE app=$APP testid=$TESTID"
trap 'warn "interrupted; deleting job $JOB"; k -n loadgen delete job "$JOB" --wait=false >/dev/null 2>&1 || true; exit 130' INT TERM

finished() { # prints succeeded/failed when the Job is over, gone when it was deleted
  local s f
  k -n loadgen get job "$JOB" >/dev/null 2>&1 || { echo gone; return; }
  s="$(k -n loadgen get job "$JOB" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)"
  f="$(k -n loadgen get job "$JOB" -o jsonpath='{.status.failed}' 2>/dev/null || true)"
  if [ "${s:-0}" -ge 1 ] 2>/dev/null; then echo succeeded; elif [ "${f:-0}" -ge 1 ] 2>/dev/null; then echo failed; fi
}

# Wait for the pod to start (image pull on first use), then follow its log. If the log
# stream drops during a long run, reattach until the Job is over.
started() { # the container is running or already over
  k -n loadgen get pod -l "job-name=$JOB" -o jsonpath='{.items[0].status.containerStatuses[0].state}' 2>/dev/null | grep -qE '"(running|terminated)"'
}
wait_for "pod of $JOB to start" 300 started || true
tail_args=()
until [ -n "$(finished)" ]; do
  k -n loadgen logs -f "${tail_args[@]}" "job/$JOB" 2>&1 || true
  tail_args=(--tail=0)
  [ -n "$(finished)" ] || sleep 3
done

state="$(finished)"
if [ "$state" = gone ]; then warn "job $JOB was deleted before it reported; see its summary line above, or Prometheus (testid=$TESTID)"; exit 2; fi
code="$(k -n loadgen get pod -l "job-name=$JOB" -o jsonpath='{.items[0].status.containerStatuses[0].state.terminated.exitCode}' 2>/dev/null || true)"
code="${code:-1}"
if [ "$state" = succeeded ]; then log "job $JOB succeeded (exit 0)"; else warn "job $JOB failed (exit $code)"; [ "$code" != 0 ] || code=1; fi
exit "$code"
