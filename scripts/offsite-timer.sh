#!/usr/bin/env bash
# offsite-timer.sh [--print]: installs and enables a systemd user service and timer that run
# scripts/offsite.sh from this checkout every night at 03:30 UTC, after the 03:00 UTC database dumps.
# Idempotent. --print writes the two units to stdout and installs nothing.
. "$(dirname "$0")/lib.sh"

case "$ROOT" in *[\"\\]*) die "the checkout path $ROOT contains a quote or backslash; systemd cannot run scripts from it" ;; esac
exec_path="${ROOT//%/%%}/scripts/offsite.sh"
service="[Unit]
Description=Lab off-disk backup (restic) of $exec_path

[Service]
Type=oneshot
ExecStart=\"$exec_path\"
Nice=10
IOSchedulingClass=idle
"
timer="[Unit]
Description=Nightly lab off-disk backup (restic)

[Timer]
OnCalendar=*-*-* 03:30 UTC
Persistent=true

[Install]
WantedBy=timers.target
"

if [ "${1:-}" = --print ]; then
  printf '# lab-offsite.service\n%s\n# lab-offsite.timer\n%s' "$service" "$timer"
  exit 0
fi
[ -z "${1:-}" ] || die "usage: $0 [--print]"
[ -n "${RESTIC_REPOSITORY:-}" ] || die "set RESTIC_REPOSITORY in config/override.env and run make offsite once before installing the timer"

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
changed=""
write_unit() { # NAME CONTENT
  cmp -s "$unit_dir/$1" <(printf '%s' "$2") && return 0
  printf '%s' "$2" > "$unit_dir/$1"; changed=1; log "wrote $unit_dir/$1"
}
write_unit lab-offsite.service "$service"
write_unit lab-offsite.timer "$timer"
[ -z "$changed" ] || systemctl --user daemon-reload
systemctl --user enable --now lab-offsite.timer
systemctl --user list-timers lab-offsite.timer --no-pager >&2 || true
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
  warn "user timers run only while you are logged in. To run it at 03:30 regardless: sudo loginctl enable-linger $(id -un)"
fi
log "logs: journalctl --user -u lab-offsite.service; run it now: systemctl --user start lab-offsite.service"
