#!/usr/bin/env bash
# status.sh [--urls]: cluster health at a glance, or just the URLs.
. "$(dirname "$0")/lib.sh"

urls() {
  cat <<URLS
URLs (trust .local/ca.crt in your browser; logins: make creds)
  Home          https://home.${DOMAIN}/
  Storage       https://storage.${DOMAIN}/
  Todo          https://todo.${DOMAIN}/
  PDF           https://pdf.${DOMAIN}/
  Sign-in       https://auth.${DOMAIN}/
  Grafana       https://grafana.${DOMAIN}/        (admins)
  Prometheus    https://prometheus.${DOMAIN}/     (admins)
  Alertmanager  https://alertmanager.${DOMAIN}/   (admins)
  Traefik       https://traefik.${DOMAIN}/dashboard/  (admins)
URLS
}
if [ "${1:-}" = --urls ]; then urls; exit 0; fi

echo "== k3s"
if [ -x "$K3S_BIN" ]; then installed=$("$K3S_BIN" --version | sed -n 1p); else installed="not installed at $K3S_BIN"; fi
echo "  $installed (pinned $K3S_VERSION)," \
  "service $(systemctl is-active k3s 2>/dev/null || true)"
require_cluster
echo; echo "== nodes"; k get nodes -o wide
echo; echo "== helm releases"; h list -A
echo; echo "== workloads not ready"
k get pods -A --no-headers | awk '$4 != "Running" && $4 != "Completed" {print}' | sed 's/^/  /' || true
k get pods -A --no-headers | awk '$4 == "Running" { split($3, r, "/"); if (r[1] != r[2]) print "  " $0 }' || true
echo; echo "== volumes"; k get pv -l app.kubernetes.io/part-of=lab
echo; echo "== routes"; k get ingressroute -A
echo; echo "== certificates"; k get certificate -A
echo; urls
