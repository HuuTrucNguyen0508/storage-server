# Storage: the React app is built first, embedded into the Go binary, and the
# binary runs alone on a distroless, non-root, read-only image.
# Build from the repo root: docker build -f services/storage/Dockerfile -t lab/storage:dev .

ARG NODE_IMAGE=node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
ARG GO_IMAGE=golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb
ARG RUN_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329

FROM ${NODE_IMAGE} AS web
COPY tools/install-corepack.mjs /tmp/install-corepack.mjs
RUN node /tmp/install-corepack.mjs && corepack enable
WORKDIR /src/services/storage/web
COPY services/storage/web/package.json services/storage/web/pnpm-lock.yaml ./
RUN corepack install && pnpm install --frozen-lockfile
COPY packages/ui /src/packages/ui
COPY services/storage/web/ ./
RUN pnpm build

FROM ${GO_IMAGE} AS go
WORKDIR /src
COPY services/storage/go.mod services/storage/go.sum ./
RUN go mod download
COPY services/storage/ ./
COPY --from=web /src/services/storage/web/ui-dist ./web/ui-dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/storage ./cmd/storage

FROM ${RUN_IMAGE}
COPY --from=go /out/storage /storage
USER 65532:65532
EXPOSE 8080 9464
ENTRYPOINT ["/storage"]
