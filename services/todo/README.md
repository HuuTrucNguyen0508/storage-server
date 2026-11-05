# Todo service

Fastify 5 API, PostgreSQL 18 database through CloudNativePG, same-origin static web build. The placeholder web page is replaced by the separate React task. API.md is the client contract. METRICS.md describes monitoring.

From `services/todo/api`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
DATABASE_URL=postgres://... APP_ENV=development AUTH_MODE=dev DEV_USER=alice pnpm start
```

Tests start an isolated `postgres:18.6-alpine3.24` Docker container on an ephemeral loopback port and remove it after the suite. Docker must be available. The two Fastify instances in integration tests share this real database. No browser is used.

From the repository root, `make deploy-todo` builds the image, loads kind and applies the manifests, waiting for both replicas. `make backup APPS=todo` writes a custom PostgreSQL dump to `.local/data/backups/todo/`. Nightly backups retain seven files. `make restore APPS=todo` uses the platform restore procedure. The app is stateless; durable users/projects/tasks/comments/events/reminder claims live in PostgreSQL. Startup applies ordered migrations under a session advisory lock after up to 120 database connection retries.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | pg connection URI, deployment reads todo-db-app/uri |
| `PORT` | 8080 | HTTP port |
| `METRICS_PORT` | 9464 | separate metrics listener |
| `AUTH_MODE` | header | header or dev |
| `APP_ENV` | production | dev auth refused unless development |
| `DEV_USER` | alice | local development username |
| `DEV_GROUPS` | empty | optional comma-separated development groups |
| `EXPECTED_ORIGIN` | https://todo.lab.localhost | exact permitted mutation Origin |
| `WEB_ROOT` | ../web/dist | built web root relative to API working directory; image uses /app/web/dist |
| `AUTH_PUBLIC_URL` | https://auth.lab.localhost | logout/login portal for UI |
| `HOME_URL` | https://home.lab.localhost/ | shared portal URL |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | enables traces, deployment uses http://alloy.monitoring.svc.cluster.local:4318 |
| `OTEL_SERVICE_NAME` | SDK default | deployment sets todo |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | deployment sets environment and service.namespace=lab |
| `HOSTNAME` | local | pod label in structured logs, supplied by Kubernetes |

Header mode reads Remote-User/Name/Email/Groups supplied by the SSO middleware. NetworkPolicy admits public HTTP from Traefik only. The frontend receives groups on `/api/me`. Request bodies are limited to 2 MiB, including import; split larger imports into coherent exports. No writable filesystem is needed. SIGTERM closes SSE connections and HTTP/metrics servers before ending the PostgreSQL pool.

## Design choices and operational limits

Authorization checks are centralized in Store.role/task/create/update/validateTask. Route handlers handle identity-local labels/profile and explicitly check project roles before executing scoped queries. Indexed full-text search uses PostgreSQL's simple language configuration. Date-only values still have a UTC instant; interpret them using the profile timezone. A reminder's absolute time takes precedence over its relative offset. At-most-once database claims prevent two replicas emitting separate reminder records; reconnect replay uses event IDs for deduplication.

Events currently have no retention job. Import is additive and preserves owned project content with remapped IDs, not an administrative database restore. PostgreSQL snapshots and backups are the exact recovery mechanism. Cross-project moves require clearing or moving the section/parent reference, and moving children first. The API returns all matching tasks without pagination; suitable for this friends-scale installation. Calendar helpers use Intl with IANA zones; schedule DST-transition gap times with care. No email or push notifications are sent; reminders use the signed-in live stream.

Verification evidence and the current web-task integration boundary are recorded in [PROOF.md](PROOF.md). While the web sources are being replaced, `bash services/todo/api/test/deploy-api-proof.sh` builds the API against the immutable previously verified placeholder artifact. After the web task finishes, use the normal `make deploy-todo` again.
