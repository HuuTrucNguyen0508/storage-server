#!/usr/bin/env bash
# users.sh: manage SSO users (Authelia file backend in .local/users.json).
#   users.sh add USERNAME EMAIL [--admin] [--name "Display Name"]   prints a generated password
#   users.sh passwd USERNAME                                        prints a new password
#   users.sh remove USERNAME
#   users.sh list
# Changes go to Secret auth/authelia-users; Authelia watches the file and reloads it
# without signing anyone out (the kubelet refreshes the mounted Secret within about a minute).
. "$(dirname "$0")/lib.sh"
. "$ROOT/scripts/users-lib.sh"
[ -s "$USERS_JSON" ] || "$ROOT/scripts/secrets.sh"

new_password() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 20; }

publish() {
  if cluster_exists && k -n auth get deployment authelia >/dev/null 2>&1; then
    apply_users_secret
    log "updated Secret auth/authelia-users; Authelia reloads it within about a minute"
  else
    log "cluster not running; the change applies on the next make up"
  fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  add)
    user="${1:-}"; email="${2:-}"; shift 2 || die "usage: users.sh add USERNAME EMAIL [--admin] [--name NAME]"
    groups=users; name="$user"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --admin) groups=admins,users ;;
        --name) name="${2:?--name needs a value}"; shift ;;
        *) die "unknown option $1" ;;
      esac
      shift
    done
    valid_username "$user" || die "username must match ^[a-z][a-z0-9_-]{1,31}$"
    [[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || die "invalid email: $email"
    user_exists "$user" && die "user $user already exists (use passwd to reset)"
    pw=$(new_password)
    user_put "$user" "$email" "$name" "$groups" "$(hash_password "$pw")"
    printf '%s' "$pw" > "$LOCAL_DIR/passwords/$user"; chmod 600 "$LOCAL_DIR/passwords/$user"
    publish
    echo "user:     $user ($groups)"
    echo "password: $pw"
    ;;
  passwd)
    user="${1:?usage: users.sh passwd USERNAME}"
    user_exists "$user" || die "no such user: $user"
    pw=$(new_password)
    user_set_password_hash "$user" "$(hash_password "$pw")"
    printf '%s' "$pw" > "$LOCAL_DIR/passwords/$user"; chmod 600 "$LOCAL_DIR/passwords/$user"
    # Keep credentials.env in step for the built-in accounts.
    key=""
    load_creds
    case "$user" in
      "$ADMIN_USER") key=ADMIN_PASSWORD ;; alice) key=ALICE_PASSWORD ;; bob) key=BOB_PASSWORD ;;
      "$LOADGEN_USER") key=LOADGEN_PASSWORD ;;
    esac
    if [ -n "$key" ]; then sed -i "s|^${key}=.*|${key}=${pw}|" "$(creds_file)"; fi
    publish
    echo "user:     $user"
    echo "password: $pw"
    ;;
  remove)
    user="${1:?usage: users.sh remove USERNAME}"
    user_exists "$user" || die "no such user: $user"
    load_creds
    case "$user" in "$ADMIN_USER"|alice|bob|"$LOADGEN_USER") die "$user is a built-in account" ;; esac
    user_delete "$user"; rm -f "$LOCAL_DIR/passwords/$user"
    publish
    echo "removed $user"
    ;;
  list)
    jq -r '.users | to_entries[] | "\(.key)\t\(.value.email)\t\(.value.groups | join(","))"' "$USERS_JSON" \
      | column -t -s $'\t' -N USER,EMAIL,GROUPS
    ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
