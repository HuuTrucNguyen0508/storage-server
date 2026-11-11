# Storage

The lab's file server at `https://storage.${DOMAIN}`: each person signed in through Authelia gets a private space; they upload, browse, preview and share files with friends (by username, read or edit) and with anyone (public links with optional password, expiry and download limit, or upload-only drop links). One Go binary serves the JSON API, the embedded React app and the guest pages.

- API: [API.md](API.md) · Metrics: [METRICS.md](METRICS.md) · Screenshots: [docs/shots/](docs/shots/) · Security notes: [docs/security.md](docs/security.md)

## Layout

```
cmd/storage/          main: config, servers, graceful shutdown
internal/config/      environment variables (table below)
internal/store/       PostgreSQL: migrations, and authz.go, the one place that decides access
internal/blobs/       the storage-data volume: blobs named by random id, resumable chunk writes
internal/server/      HTTP: routing (public and private routers), middleware, handlers, tests
internal/preview/     thumbnails, Office-to-PDF through Stirling PDF, ZIP listings
internal/filetype/    file kind and the inline-serving allowlist, from the name only
internal/names/       file name rules (NFC, no slashes or control characters, numbering)
internal/telemetry/   JSON logs, Prometheus metrics, OpenTelemetry tracing
internal/testdb/      a throwaway postgres:18.6 container for integration tests
web/                  React + TypeScript (Vite); `pnpm build` writes web/ui-dist, embedded by web/embed.go
deploy/               kustomization: CloudNativePG cluster, PVCs, Deployment, Service, CronJob,
                      ServiceMonitor, NetworkPolicies, IngressRoutes
Dockerfile            node build → go build → distroless static, non-root
```

## How it works

- **Data.** Metadata in PostgreSQL (`storage-db`, CloudNativePG). File bytes on the `storage-data` volume at `blobs/<2 hex>/<32 hex>`, named by a random id. No request value ever reaches a filesystem path. Copies share a blob. A blob no file points at, and a blob file the database has no row for (after 6 h, so uploads in flight are safe), is moved to `quarantine/<32 hex>` instead of being deleted. Cleanup moves a quarantined blob back when the database references it again (a restored dump), and deletes it only after `BLOB_QUARANTINE_RETENTION` and once its quarantine mtime is older than the oldest kept `storage-*.dump` in `BACKUP_DIR`.
- **Access.** `store.Authorize` is the single decision for every node: owner, share (the strongest share on the node or any folder above it), or public link (the node is the link's node or below it). Things you can't see answer `404`, things you can see but not change answer `403`. Admins manage quotas and links, never other people's files.
- **Two routers.** `/s/`, `/api/public/`, `/assets/`, `/favicon.svg` (and the probes) go to a router that never reads identity; everything else goes through the identity middleware. The split matches the two IngressRoutes, so a public path can never fall through to a private handler.
- **Uploads.** Chunked and resumable (`POST /api/uploads`, then `PUT` chunks with `Upload-Offset`). Each chunk is appended, fsynced and recorded with the running SHA-256 state, so a dropped connection resumes from the last byte that arrived. The browser remembers session ids, so the same file dropped again after a reload resumes too. The declared size is reserved against the quota until the upload ends; sessions idle for 24 h are purged.
- **Previews.** Images, video and audio are served inline from an allowlist (with HTTP Range); everything script-capable is plain text or a download. PDFs render in the browser with pdf.js; text, code (highlight.js), Markdown (markdown-it with HTML off, then DOMPurify), JSON and CSV are fetched as text and rendered escaped. Thumbnails and Office conversions are cached on the volume by blob id. Office conversion runs at most `OFFICE_CONCURRENCY` at a time with a timeout; failures show the download.
- **Background jobs** (in-process, every 15 min): purge trash older than 30 days and abandoned uploads; quarantine unreferenced blobs and orphan files, rescue quarantined blobs the database references again, delete quarantined blobs past retention and older than the oldest kept dump; gauges every 30 s.

## Configuration

Environment variables only.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | (required) | PostgreSQL URL. In the cluster: secret `storage-db-app`, key `uri`. The app retries until it answers, then migrates under an advisory lock. |
| `DATA_DIR` | `/data` | Volume for blobs, upload scratch files and caches. Directories are 0750 and files 0640 in the process's group, whatever the umask, and a background pass at startup moves older entries the process owns to that group and those modes. In the cluster that group is the host owner's (`runAsGroup: ${DATA_GID}`), so `make offsite` can read the files. |
| `DOMAIN` | | Lab domain; builds the top bar's app links and the defaults below. |
| `PUBLIC_URL` | `https://storage.${DOMAIN}` | The app's own origin: the only accepted `Origin`, and the base of share links. |
| `AUTH_PUBLIC_URL` | `https://auth.${DOMAIN}` | Authelia, for the sign-out link. |
| `HOME_URL` | `https://home.${DOMAIN}/` | Where sign-out returns. |
| `AUTH_MODE` | `header` | `header` reads `Remote-*` from the proxy; `dev` signs everyone in as `DEV_USER`. |
| `APP_ENV` | `production` | `AUTH_MODE=dev` is refused unless this is `development`. |
| `DEV_USER`, `DEV_GROUPS` | , `users` | The dev identity. |
| `ADMIN_GROUP`, `USER_GROUP` | `admins`, `users` | Groups that make an admin and a user. Anyone in neither is refused. |
| `LISTEN_ADDR` | `:8080` | App port. |
| `METRICS_ADDR` | `:9464` | Metrics port (`/metrics` only). |
| `DEFAULT_QUOTA_BYTES` | 53687091200 (50 GiB) | Quota for new users; admins change it per user. |
| `MAX_FILE_BYTES` | 274877906944 (256 GiB) | Largest single file. |
| `MAX_CHUNK_BYTES` | 268435456 (256 MiB) | Largest upload chunk per request (the web app sends 16 MiB). |
| `MIN_FREE_PERCENT` | `5` | Uploads and copies are refused when they would leave less free space on the volume. |
| `TRASH_RETENTION` | `720h` | How long trash is kept. |
| `UPLOAD_SESSION_TTL` | `24h` | Idle upload sessions are purged after this. |
| `BLOB_QUARANTINE_RETENTION` | `192h` | Minimum time a removed blob stays in `quarantine/`. With `BACKUP_DIR` set, it must also predate the oldest kept dump (the start time in its `storage-<UTC timestamp>.dump` name) before deletion. |
| `BACKUP_DIR` | empty | Directory of kept `storage-*.dump` files; the Deployment mounts `storage-backups` read-only at `/backups`. Empty, unset or unreadable directories fall back to retention only; unreadable directories log a warning each sweep. Only directory read/execute permissions are needed to stat dump mtimes. |
| `TEXT_PREVIEW_BYTES` | 1048576 | The web app shows at most this much of a text file ("download to see the rest"). Public `/raw` also enforces this cap, including Range requests. |
| `STIRLING_URL` | | Stirling PDF base URL; empty turns Office previews off. |
| `OFFICE_CONCURRENCY` | `2` | Conversions at once. |
| `OFFICE_TIMEOUT` | `120s` | Per conversion. |
| `OFFICE_MAX_BYTES` | 104857600 | Larger documents are not converted. |
| `SHUTDOWN_TIMEOUT` | `30s` | Graceful shutdown budget. |
| `LOG_LEVEL` | `info` | `debug` also logs health checks. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | | Standard OpenTelemetry variables; without an endpoint, spans are created (logs carry trace ids) but not exported. |
| `GOMEMLIMIT` | | Set from the container's memory limit in the Deployment. |

## Develop

```sh
# backend
cd services/storage
go vet ./... && go test -race ./...          # needs Docker for the postgres:18.6 test container
# frontend
cd web && pnpm install && pnpm typecheck && pnpm test && pnpm build
# everything locally, headless: Postgres in Docker + the binary in AUTH_MODE=dev + Playwright
web/e2e/run-local.sh [screenshot dir]
# against a running dev server
cd web && pnpm dev                            # Vite on :5173, proxies /api to 127.0.0.1:8080
```

Run the binary by hand:

```sh
DATABASE_URL=postgres://… DATA_DIR=/tmp/storage PUBLIC_URL=http://127.0.0.1:8080 \
AUTH_MODE=dev APP_ENV=development DEV_USER=alice DEV_GROUPS=users,admins go run ./cmd/storage
```

## Deploy and prove

```sh
make deploy-storage                           # build, import into k3s, render, apply, wait
services/storage/web/e2e/cluster-proof.sh     # headless Chromium through Traefik + Authelia: alice, bob, a guest
services/storage/web/e2e/cluster-proof.sh --big   # plus a 2 GiB upload and checksum-verified download
```

`make backup` / `make restore` (platform) use the `storage-db-backup` CronJob. File contents need no backup job: `storage-data` lives on the host under `${DATA_DIR}/storage`. After a restore, the app's next cleanup (at startup) moves blobs the restored database references back out of `quarantine/`. Files uploaded after the dump lose their rows; they are quarantined, not deleted, and stay in `quarantine/` until past `BLOB_QUARANTINE_RETENTION` and older than the oldest kept dump (their bytes only, without names).

## Keyboard

Browser: `/` search, arrows move, `Enter` open, `Space` select, `Ctrl+A` all, `Delete` trash, `F2` rename, `S` share, `N` new folder, `Shift+F10` row menu, `Esc` clear. Viewer: `←`/`→` previous/next, `Esc` close, `D` download, `+`/`-`/`0` zoom (images, PDF), `PageUp`/`PageDown` PDF pages.
