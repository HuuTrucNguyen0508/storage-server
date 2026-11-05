#!/usr/bin/env bash
# Screenshots every mockup and the Home portal, light and dark, desktop and
# phone, with headless Chromium only (never a visible browser).
#
#   docs/design/tools/shots.sh            # all
#   docs/design/tools/shots.sh todo       # only files whose name contains "todo"
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="$root/docs/design/mockups/shots"
mkdir -p "$out"
filter="${1:-}"

pages=()
for f in "$root"/docs/design/mockups/*.html; do pages+=("$f"); done
pages+=("$root/services/home/site/index.html")

shot() {
  local file="$1" theme="$2" size="$3" w="$4" h="$5"
  local name
  name="$(basename "$file" .html)"
  [[ "$file" == */services/home/* ]] && name="home"
  local png="$out/$name-$theme-$size.png"
  timeout 90 chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --window-size="$w,$h" --screenshot="$png" "file://$file?theme=$theme" >/dev/null 2>&1 \
    && echo "$png" || echo "FAILED $png" >&2
}
export -f shot
export out

jobs=()
for f in "${pages[@]}"; do
  [[ -n "$filter" && "$f" != *"$filter"* ]] && continue
  jobs+=("$f light desktop 1440 900" "$f dark desktop 1440 900" "$f light phone 390 844" "$f dark phone 390 844")
done
printf '%s\n' "${jobs[@]}" | xargs -P 4 -L 1 bash -c 'shot "$@"' _
