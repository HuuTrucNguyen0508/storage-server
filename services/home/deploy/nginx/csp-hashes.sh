#!/bin/sh
# Build-time helper (services/home/Dockerfile): fills the CSP with the sha256 of every inline <script>.
set -eu
apk add --no-cache openssl >/dev/null
mkdir -p /tmp/inline
n=0
for f in $(find /site -name '*.html'); do
  n=$((n + 1))
  # Write each inline <script> body (exact bytes between the tags) to its own file.
  awk -v out="/tmp/inline/$n" 'BEGIN { RS = "\001" } {
    s = $0; k = 0
    while ((i = index(s, "<script>")) > 0) {
      s = substr(s, i + 8); j = index(s, "</script>")
      k++; file = out "-" k; printf "%s", substr(s, 1, j - 1) > file; close(file)
      s = substr(s, j + 9)
    }
  }' "$f"
done
hashes=""
for part in /tmp/inline/*; do
  [ -e "$part" ] || continue
  hashes="$hashes 'sha256-$(openssl dgst -sha256 -binary "$part" | base64)'"
done
sed "s|__INLINE_SCRIPT_HASHES__|$hashes|" /conf/security-headers.conf > /conf/security-headers.rendered
echo "inline script hashes:$hashes"
