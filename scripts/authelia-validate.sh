#!/usr/bin/env bash
# authelia-validate.sh RENDERED_CONFIG: runs `authelia validate-config` in the pinned image
# with the real secrets mounted, before the config reaches the cluster.
. "$(dirname "$0")/lib.sh"
cfg="${1:?usage: authelia-validate.sh CONFIG}"
tmp=$(mktemp -d "$LOCAL_DIR/.authval.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
cp "$cfg" "$tmp/configuration.yml"; cp -r "$LOCAL_DIR/authelia" "$tmp/secrets"
chmod -R a+rX "$tmp"
out=$(docker run --rm --user 0 -v "$tmp:/cfg:ro" \
  -e AUTHELIA_SESSION_SECRET_FILE=/cfg/secrets/session_secret \
  -e AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=/cfg/secrets/storage_encryption_key \
  -e AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET_FILE=/cfg/secrets/jwt_secret \
  "$AUTHELIA_IMAGE" authelia validate-config --config /cfg/configuration.yml 2>&1) || { echo "$out" >&2; die "Authelia config is invalid"; }
echo "$out" | grep -q 'without errors' || { echo "$out" >&2; die "Authelia config validation reported problems"; }
log "authelia validate-config: OK"
