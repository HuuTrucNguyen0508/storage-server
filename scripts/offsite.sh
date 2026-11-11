#!/usr/bin/env bash
# offsite.sh: copies DATA_DIR, the secrets in .local/ and config/override.env into a restic
# repository on another disk or machine, then thins out old snapshots. Takes fresh database
# dumps first (scripts/backup.sh) when the cluster is running. make offsite-timer runs it nightly.
#   RESTIC_REPOSITORY     where the copy goes; required, set it in config/override.env
#   RESTIC_PASSWORD_FILE  the repository password (default .local/restic-password, generated once)
#   OFFSITE_SECRETS_DIR   the secrets directory to copy (default .local/)
. "$(dirname "$0")/lib.sh"
. "$ROOT/scripts/db-lib.sh"

command -v restic >/dev/null \
  || die "restic is not installed (Arch/CachyOS: sudo pacman -S restic; others: https://restic.readthedocs.io/en/stable/020_installation.html)"
[ -n "${RESTIC_REPOSITORY:-}" ] || die "RESTIC_REPOSITORY is not set. Put it in config/override.env: a path on a second disk \
(RESTIC_REPOSITORY=/mnt/backup/lab) or any restic backend (sftp:, rest:, s3:, b2:, rclone:...). \
A repository on the same disk as $DATA_DIR does not count: it dies with that disk"
export RESTIC_REPOSITORY
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$LOCAL_DIR/restic-password}"
case "$RESTIC_PASSWORD_FILE" in /*) ;; *) RESTIC_PASSWORD_FILE="$ROOT/$RESTIC_PASSWORD_FILE" ;; esac
export RESTIC_PASSWORD_FILE
secrets="${OFFSITE_SECRETS_DIR:-$LOCAL_DIR}"
[ -d "$secrets" ] || die "$secrets does not exist; run make secrets"
[ -d "$DATA_DIR" ] || die "DATA_DIR=$DATA_DIR does not exist"
secrets=$(realpath -- "$secrets")
data=$(realpath -- "$DATA_DIR")

# A repository on a local path must not sit inside what it backs up, and should be on another disk.
case "$RESTIC_REPOSITORY" in
  sftp:*|rest:*|s3:*|b2:*|azure:*|gs:*|swift:*|rclone:*) repo_path="" ;;
  *) repo_path="${RESTIC_REPOSITORY#local:}" ;;
esac
if [ -n "$repo_path" ]; then
  case "$repo_path" in /*) ;; *) die "RESTIC_REPOSITORY=$RESTIC_REPOSITORY: use an absolute path" ;; esac
  repo_real=$(realpath -m -- "$repo_path")
  for d in "$(realpath -- "$ROOT")" "$data" "$secrets"; do
    case "$repo_real/" in "$d"/*) die "RESTIC_REPOSITORY=$repo_path is inside $d: a backup there is lost with what it backs up. Use a second disk or another machine" ;; esac
  done
  if command -v findmnt >/dev/null; then
    d="$repo_real"; while [ ! -e "$d" ]; do d=$(dirname "$d"); done
    repo_dev=$(findmnt -n -o SOURCE -T "$d" || true); data_dev=$(findmnt -n -o SOURCE -T "$data" || true)
    if [ -n "$repo_dev" ] && [ "${repo_dev%%\[*}" = "${data_dev%%\[*}" ]; then
      warn "RESTIC_REPOSITORY=$repo_path is on the same device (${repo_dev%%\[*}) as $DATA_DIR: it does not survive that disk failing"
    fi
  fi
fi

# restic exits 10 when the repository does not exist and 12 on a wrong password (restic 0.17+).
# Probe with a dummy password so a missing password file is never replaced for an existing repository.
rc=0
out=$(env -u RESTIC_PASSWORD_FILE -u RESTIC_PASSWORD_COMMAND RESTIC_PASSWORD=probe restic cat config 2>&1 >/dev/null) || rc=$?
case "$rc" in
  10) new_repo=1 ;;
  0|12) new_repo="" ;;
  *) die "cannot open restic repository $RESTIC_REPOSITORY: $out" ;;
esac
# Only a run from a terminal creates the repository: an unattended run that finds none (second disk
# not mounted) must fail instead of quietly starting a new repository on the wrong disk.
if [ -n "$new_repo" ] && [ "${OFFSITE_INIT:-}" != 1 ] && [ ! -t 0 ]; then
  die "restic repository $RESTIC_REPOSITORY does not exist (is its disk mounted?). Create it by running make offsite from a terminal, or with OFFSITE_INIT=1"
fi
if [ ! -s "$RESTIC_PASSWORD_FILE" ]; then
  [ -n "$new_repo" ] || die "repository $RESTIC_REPOSITORY exists, but its password file $RESTIC_PASSWORD_FILE is missing. Put back the copy you kept off this machine"
  (umask 077; mkdir -p "$(dirname "$RESTIC_PASSWORD_FILE")"
   openssl rand -base64 48 | tr -dc 'A-Za-z0-9' > "$RESTIC_PASSWORD_FILE")
  chmod 600 "$RESTIC_PASSWORD_FILE"
  warn "########################################################################"
  warn "generated the restic password: $RESTIC_PASSWORD_FILE"
  warn "COPY IT OFF THIS MACHINE NOW, for example into your password manager."
  warn "It lives on the same disk as the data. If that disk dies, the backup"
  warn "cannot be opened without the copy. Show it with: cat $RESTIC_PASSWORD_FILE"
  warn "########################################################################"
fi
if [ -n "$new_repo" ]; then
  log "initialising restic repository $RESTIC_REPOSITORY"
  restic init >&2
else
  rc=0; out=$(restic cat config 2>&1 >/dev/null) || rc=$?
  [ "$rc" = 0 ] || die "cannot open restic repository $RESTIC_REPOSITORY with $RESTIC_PASSWORD_FILE (exit $rc): $out"
fi

rc=0
if cluster_exists; then
  step "fresh database dumps"
  if ! "$ROOT/scripts/backup.sh"; then
    warn "the fresh dumps failed; copying the existing ones:"; warn_newest_dumps; rc=1
  fi
else
  warn "cluster $CLUSTER_NAME is not running; copying the existing dumps:"; warn_newest_dumps
fi

# DATA_DIR inside .local/ is copied once, as part of .local/. Everything excluded is regenerated by make up.
targets=("$secrets")
case "$data/" in "$secrets"/*) ;; *) targets+=("$data") ;; esac
[ -f "$ROOT/config/override.env" ] && targets+=("$ROOT/config/override.env")
excludes=()
for x in bin k3s kubeconfig cluster-ready; do excludes+=(--exclude "$secrets/$x"); done
excludes+=(--exclude "$(realpath -m -- "$RESTIC_PASSWORD_FILE")")

step "restic backup to $RESTIC_REPOSITORY"
brc=0
restic backup --tag lab-offsite "${excludes[@]}" "${targets[@]}" >&2 || brc=$?
case "$brc" in
  0) restic forget --tag lab-offsite --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune >&2 ;;
  3) warn "the snapshot is INCOMPLETE: restic could not read the paths listed above (check their owners and modes; see platform/README.md, Off-disk backups)"
     restic forget --tag lab-offsite --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune >&2
     rc=3 ;;
  *) die "restic backup failed (exit $brc)" ;;
esac
[ "$rc" = 0 ] && log "off-disk backup done: restic snapshots --tag lab-offsite"
exit "$rc"
