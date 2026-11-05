#!/usr/bin/env bash
set -euo pipefail
# Run from repository root. Requires the immutable earlier full build locally.
source scripts/lib.sh
docker build -f services/todo/api/test/Dockerfile.api-proof -t lab/todo:api-proof .
id=$(docker image inspect -f '{{.Id}}' lab/todo:api-proof)
IMAGE_TAG="${id#sha256:}"; IMAGE_TAG="${IMAGE_TAG:0:16}"; export IMAGE_TAG
docker tag lab/todo:api-proof "lab/todo:$IMAGE_TAG"
kind load docker-image "lab/todo:$IMAGE_TAG" --name lab
k kustomize services/todo/deploy | render | k apply -f -
k -n todo rollout status deployment/todo --timeout=300s
printf 'API proof image lab/todo:%s\n' "$IMAGE_TAG"
