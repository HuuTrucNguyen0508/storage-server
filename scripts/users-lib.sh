# shellcheck shell=bash
# User database helpers shared by secrets.sh and users.sh. Source after lib.sh.
# .local/users.json is the Authelia file backend. JSON is valid YAML, so the
# Secret carries it unchanged as users_database.yml.

USERS_JSON="$LOCAL_DIR/users.json"

valid_username() { [[ "$1" =~ ^[a-z][a-z0-9_-]{1,31}$ ]]; }

user_exists() { jq -e --arg u "$1" '.users[$u] != null' "$USERS_JSON" >/dev/null; }

# hash_password PASSWORD: argon2id digest from the pinned Authelia image.
# The password goes in through the environment, not the command line.
hash_password() {
  local out
  out=$(PW="$1" docker run --rm -e PW "$AUTHELIA_IMAGE" \
    sh -c 'authelia crypto hash generate argon2 --variant argon2id --password "$PW"') \
    || die "password hashing failed"
  out=$(printf '%s\n' "$out" | sed -n 's/^Digest: //p')
  [[ "$out" == '$argon2id$'* ]] || die "unexpected hash output"
  printf '%s' "$out"
}

# user_put USER EMAIL DISPLAYNAME GROUPS(comma) HASH
user_put() {
  local tmp; tmp=$(mktemp "$LOCAL_DIR/.users.XXXXXX")
  jq --arg u "$1" --arg e "$2" --arg n "$3" --arg g "$4" --arg p "$5" \
    '.users[$u] = {disabled: false, displayname: $n, email: $e, password: $p, groups: ($g | split(",") | map(select(length > 0)))}' \
    "$USERS_JSON" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$USERS_JSON"
}

user_set_password_hash() { # USER HASH
  local tmp; tmp=$(mktemp "$LOCAL_DIR/.users.XXXXXX")
  jq --arg u "$1" --arg p "$2" '.users[$u].password = $p' "$USERS_JSON" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$USERS_JSON"
}

user_delete() {
  local tmp; tmp=$(mktemp "$LOCAL_DIR/.users.XXXXXX")
  jq --arg u "$1" 'del(.users[$u])' "$USERS_JSON" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$USERS_JSON"
}

# apply_users_secret: (re)creates Secret auth/authelia-users from users.json.
# The users-sync sidecar copies it into Authelia's watched directory (see platform/auth/authelia.yaml),
# and Authelia reloads it without dropping sessions.
apply_users_secret() {
  k -n auth create secret generic authelia-users \
    --from-file=users_database.yml="$USERS_JSON" --dry-run=client -o yaml \
    | k apply -f - >/dev/null
}
