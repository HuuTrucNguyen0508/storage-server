#!/usr/bin/env bash
# creds.sh: URLs and every SSO login from .local/.
. "$(dirname "$0")/lib.sh"
load_creds
"$ROOT/scripts/status.sh" --urls
echo
echo "Logins (Authelia, https://auth.${DOMAIN}/)"
for f in "$LOCAL_DIR"/passwords/*; do
  u=$(basename "$f")
  groups=$(jq -r --arg u "$u" '.users[$u].groups // [] | join(",")' "$LOCAL_DIR/users.json")
  printf '  %-10s %-28s groups=%s\n' "$u" "$(cat "$f")" "$groups"
done
echo
echo "Grafana local admin (break-glass): admin / ${GRAFANA_ADMIN_PASSWORD}"
echo "CA certificate to trust: $LOCAL_DIR/ca.crt"
