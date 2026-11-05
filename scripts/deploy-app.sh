#!/usr/bin/env bash
# deploy-app.sh APP: builds services/APP/Dockerfile from the repo root, tags it with an
# immutable tag derived from the image ID, loads it into kind, renders
# `kubectl kustomize services/APP/deploy` with IMAGE_TAG set, applies it and waits.
. "$(dirname "$0")/lib.sh"
app="${1:?usage: deploy-app.sh APP}"
[[ "$app" =~ ^[a-z][a-z0-9-]*$ ]] || die "bad app name: $app"
dir="$ROOT/services/$app"
[ -f "$dir/Dockerfile" ] && [ -f "$dir/deploy/kustomization.yaml" ] \
  || die "services/$app needs a Dockerfile and deploy/kustomization.yaml"
require_cluster

log "building lab/$app"
docker build -f "$dir/Dockerfile" -t "lab/$app:build" "$ROOT" >&2
id=$(docker image inspect -f '{{.Id}}' "lab/$app:build")
IMAGE_TAG="${id#sha256:}"; IMAGE_TAG="${IMAGE_TAG:0:16}"; export IMAGE_TAG
docker tag "lab/$app:build" "lab/$app:$IMAGE_TAG"
log "image lab/$app:$IMAGE_TAG"
# kind skips nodes that already hold this image ID.
kind load docker-image "lab/$app:$IMAGE_TAG" --name "$CLUSTER_NAME" >&2

out="$LOCAL_DIR/deploy-$app.yaml"
k kustomize "$dir/deploy" | render > "$out"
grep -q '^kind: Namespace$' "$out" && warn "services/$app/deploy ships a Namespace; the platform owns namespaces"
k apply -f "$out"

# Wait for every workload in the rendered output.
k get -f "$out" -o json 2>/dev/null | jq -r '
  (if .kind == "List" then .items else [.] end)[]
  | select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "DaemonSet")
  | "\(.metadata.namespace) \(.kind | ascii_downcase)/\(.metadata.name)"' \
| while read -r ns ref; do wait_rollout "$ns" "$ref" "${ROLLOUT_TIMEOUT:-600s}"; done
log "deployed $app ($IMAGE_TAG)"
