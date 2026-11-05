#!/usr/bin/env bash
# Generates everything in .local/ that must never be committed. Idempotent:
# existing values are kept, missing ones are created.
#   .local/credentials.env        built-in logins (contract)
#   .local/passwords/<user>       plain password of every SSO user (mode 600)
#   .local/users.json             Authelia file backend (argon2id hashes); JSON is valid YAML
#   .local/authelia/*             Authelia session, storage and JWT secrets
#   .local/ca.key, .local/ca.crt  local root CA (name-constrained to ${DOMAIN})
. "$(dirname "$0")/lib.sh"

umask 077
mkdir -p "$LOCAL_DIR" "$LOCAL_DIR/passwords" "$LOCAL_DIR/authelia" "$LOCAL_DIR/bin"
chmod 700 "$LOCAL_DIR" "$LOCAL_DIR/passwords" "$LOCAL_DIR/authelia"

random_secret() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }

# --- credentials.env -------------------------------------------------------
CREDS="$(creds_file)"
touch "$CREDS"; chmod 600 "$CREDS"
ensure_cred() { # KEY VALUE-GENERATOR...
  local key="$1"; shift
  grep -q "^${key}=" "$CREDS" || echo "${key}=$("$@")" >> "$CREDS"
}
fixed() { echo "$1"; }
ensure_cred ADMIN_USER fixed admin
ensure_cred ADMIN_PASSWORD random_secret 24
ensure_cred ALICE_PASSWORD random_secret 24
ensure_cred BOB_PASSWORD random_secret 24
ensure_cred LOADGEN_USER fixed loadgen
ensure_cred LOADGEN_PASSWORD random_secret 24
ensure_cred GRAFANA_ADMIN_PASSWORD random_secret 24
load_creds

# --- Authelia secrets ------------------------------------------------------
for f in session_secret storage_encryption_key jwt_secret; do
  [ -s "$LOCAL_DIR/authelia/$f" ] || random_secret 64 > "$LOCAL_DIR/authelia/$f"
done
chmod 600 "$LOCAL_DIR"/authelia/*

# --- users -----------------------------------------------------------------
. "$ROOT/scripts/users-lib.sh"
[ -s "$USERS_JSON" ] || echo '{"users":{}}' > "$USERS_JSON"
chmod 600 "$USERS_JSON"
seed_user() { # USER PASSWORD GROUPS DISPLAYNAME
  printf '%s' "$2" > "$LOCAL_DIR/passwords/$1"
  if ! user_exists "$1"; then
    log "creating SSO user $1"
    user_put "$1" "$1@${DOMAIN}" "$4" "$3" "$(hash_password "$2")"
  fi
}
seed_user "$ADMIN_USER" "$ADMIN_PASSWORD" admins,users "Admin"
seed_user alice "$ALICE_PASSWORD" users "Alice"
seed_user bob "$BOB_PASSWORD" users "Bob"
seed_user "$LOADGEN_USER" "$LOADGEN_PASSWORD" users,loadgen "Load generator"
chmod 600 "$LOCAL_DIR"/passwords/*

# --- local root CA ---------------------------------------------------------
if [ ! -s "$LOCAL_DIR/ca.key" ] || [ ! -s "$LOCAL_DIR/ca.crt" ] || [ "$(cat "$LOCAL_DIR/ca.domain" 2>/dev/null)" != "$DOMAIN" ]; then
  log "generating local root CA for $DOMAIN"
  openssl ecparam -name prime256v1 -genkey -noout -out "$LOCAL_DIR/ca.key"
  openssl req -x509 -new -key "$LOCAL_DIR/ca.key" -sha256 -days 3650 \
    -subj "/O=Lab/CN=Lab local root CA (${DOMAIN})" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -addext "nameConstraints=critical,permitted;DNS:${DOMAIN},permitted;DNS:.${DOMAIN}" \
    -out "$LOCAL_DIR/ca.crt"
  echo "$DOMAIN" > "$LOCAL_DIR/ca.domain"
  chmod 600 "$LOCAL_DIR/ca.key"; chmod 644 "$LOCAL_DIR/ca.crt"
fi

log "secrets ready in $LOCAL_DIR"
