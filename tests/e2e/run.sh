#!/usr/bin/env bash
# End-to-end journeys through the real ingress and Authelia sign-in, in headless
# Chromium. `make e2e` runs this against the live cluster (`make up` first).
#
#   tests/e2e/run.sh [playwright args...]     for example: tests/e2e/run.sh -g storage
#   INSTALL_BROWSER=1   also download Chromium (CI does; a workstation usually has it)
#   DOMAIN=...          override config/local.env
# Reports: tests/e2e/playwright-report/ (CI) and tests/e2e/test-results/ (traces of failures).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
root=$(cd ../.. && pwd)

[ -f "$root/.local/credentials.env" ] || { echo "e2e: $root/.local/credentials.env is missing; run make up" >&2; exit 1; }
domain="${DOMAIN:-$(sed -n 's/^DOMAIN=//p' "$root/config/local.env")}"

# Node resolves hostnames itself (the browser treats *.localhost as loopback, Node's API
# client does not on every system). Fail early, with the fix, instead of ENOTFOUND mid-run.
if ! getent hosts "todo.${domain}" >/dev/null 2>&1; then
  echo "e2e: todo.${domain} does not resolve. Add the lab hosts to /etc/hosts:" >&2
  echo "  echo '127.0.0.1 ${domain} home.${domain} auth.${domain} storage.${domain} todo.${domain} pdf.${domain} grafana.${domain} prometheus.${domain} alertmanager.${domain} traefik.${domain}' | sudo tee -a /etc/hosts" >&2
  exit 1
fi

pnpm install --frozen-lockfile >&2
[ -z "${INSTALL_BROWSER:-}" ] || pnpm exec playwright install --with-deps chromium >&2

exec pnpm exec playwright test "$@"
