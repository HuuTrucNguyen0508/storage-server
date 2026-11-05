# Todo API implementation report

Verified on 2026-11-05, repository `/home/theadenkingof/Documents/Code/storage-server`, branch `k8s-platform`. No git state-changing commands were run. No cluster was recreated. No delegation was used.

## Files and API

- `api/src/app.ts`: Fastify routes, request protection, identity, static serving, SSE lifecycle, graceful shutdown.
- `api/src/db.ts`: project role checks, scoped task access, transactions, version conflicts, recurrence successors, durable events, reminder claims, migration runner.
- `api/src/schema.ts` and `responses.ts`: strict Zod request/domain schemas and endpoint-specific response validation. PATCH schemas explicitly remove create-time defaults.
- `api/src/quickadd/index.ts`: dependency-free parsing, local calendar helpers and recurrence arithmetic, ready for direct web import.
- `api/src/metrics.ts`, `telemetry.ts`, `main.ts`: OpenMetrics on 9464, OTel HTTP/Fastify/pg instrumentation, startup.
- `api/migrations/001_initial.sql`, `002_reminder_claim.sql`: tables, constraints, indexed tsvector search, event log and reminder claims.
- `api/test/`: real PostgreSQL Docker setup, integration/calendar tests, reproducible ingress and monitoring proof scripts; API-only verification image recipe.
- `Dockerfile`: pinned Node 26.13.0 multi-stage full API/web build, production dependencies, uid 1000, read-only root compatible.
- `deploy/{app,db,kustomization}.yaml`: two replicas, services, probes, resources, PDB, ServiceMonitor, streaming Traefik route, NetworkPolicies, pinned CloudNativePG PostgreSQL 18.6, backup claim and CronJob.
- `API.md`: exact routes, shapes, status codes, stream protocol, quick-add grammar and typical request flows.
- `METRICS.md`: every required domain/HTTP metric and Node runtime collectors.
- `README.md`: configuration, development, deployment, backups and operational choices.

The API supports project/section/label management; nested, ordered and movable tasks; optimistic concurrency; recurring completion history; Markdown source and search; comments; user timezone views; absolute/relative live reminders; shared projects with editor/viewer roles, invitations, removal/leave/transfer; SSE replay and cross-replica notifications; JSON import/export and CSV export. Deletion of tasks is soft with restore. Project deletion cascades. Activity is retained in the durable event log.

Required metrics: `http_server_request_duration_seconds{method,route,status_code}`, `http_server_active_requests`, `todo_tasks_created_total`, `todo_tasks_completed_total`, `todo_tasks_open`, `todo_projects`, `todo_live_connections`, plus Node/process metrics. Latency buckets match the architecture contract; OpenMetrics exemplars carry trace_id.

## Local verification

From `services/todo/api`:

```text
$ pnpm typecheck
$ tsc --noEmit
$ pnpm lint
$ eslint src test
$ pnpm build
$ tsc
$ pnpm test
 Test Files  2 passed (2)
      Tests  38 passed (38)
```

The suite uses a real `postgres:18.6-alpine3.24` Docker container on a free loopback port, cleaned up after testing. It covers routes, authorization and private labels/comments/events, viewer restrictions, sibling-origin rejection, recurrence, timezone/DST/date parsing, nested-task cycle checks, movement, preserved PATCH fields, optimistic conflicts, import/export, reminder contention between two app instances, real HTTP SSE delivery between two app instances, and event replay/filtering.

## Deployment proof and the concurrent web task

`make deploy-todo` successfully built and rolled out full placeholder-web images, including `lab/todo:28000ff53a0db595`:

```text
deployment "todo" successfully rolled out
[lab] deployed todo (28000ff53a0db595)
```

While API hardening continued, the separately owned web task began replacing its placeholder. A subsequent normal build failed because the web snapshot lacked its lockfile, then because `/src/main.tsx` had not been written yet. The production Dockerfile correctly builds the web project; no web files were changed to bypass that work.

To verify the latest API independently, the API-only test Dockerfile reuses the immutable, previously verified placeholder web artifact and replaces the API build/dependencies/migrations. Reproduction from repo root:

```sh
bash services/todo/api/test/deploy-api-proof.sh
```

Observed final output:

```text
deployment "todo" successfully rolled out
API proof image lab/todo:9080c2976e761946
NAME                    READY   STATUS    RESTARTS
todo-68b4bf94bf-2m6lx     1/1     Running   0
todo-68b4bf94bf-2x469     1/1     Running   0
```

Deployment image is `lab/todo:9080c2976e761946`, readyReplicas=2. Database pod is Ready, pinned to `ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie`, and carries the todo labels through inheritedMetadata. App containers run as non-root with readOnlyRootFilesystem, dropped capabilities and RuntimeDefault seccomp. The API-only proof recipe requires the earlier image locally. The normal production build has no such dependency.

## Real ingress and SSO proof

Run `python3 services/todo/api/test/ingress-proof.py` from repository root. It trusts `.local/ca.crt`, reads local credentials without printing them, and logs Alice and Bob in through `POST https://auth.lab.localhost/api/firstfactor` with distinct session jars. No browser is used.

Final run:

```text
create project: 201 e3b52763-e99b-421a-bcef-64503a58ad59
quick add: 201 28d9abd0-22c1-4451-a922-49666d36c5de
today: 200 contains task
complete recurring: 200 next due 2026-12-05T09:00:00.000Z
comment: 201 alice
viewer write: 403
share editor: 200
sibling Origin: 403
SSE event latency after mutation request: 0.069 seconds
INGRESS PROOF PASSED
```

Pod logs show Bob's `/api/events` connection on `todo-68b4bf94bf-2m6lx` at `16:29:06.315Z` and Alice's `PATCH /api/tasks/:id` on `todo-68b4bf94bf-2x469` at `16:29:06.534Z`, status 200. The latter trace ID is `d543a9e4af63cc1ffb2e1b8fae8eaa14`. This proves delivery through PostgreSQL across replicas rather than only in-process fan-out. The measured 69 ms includes the mutation request and event receipt.

The proof project remains available for inspection. The next occurrence retained its due date, priority and recurrence after the title-only edit.

## Backup proof

```text
$ make backup APPS=todo
wrote /backups/todo-20261105T162907Z.dump (18286 bytes)
[lab] newest dump: /home/theadenkingof/Documents/Code/storage-server/.local/data/backups/todo/todo-20261105T162907Z.dump
[lab] todo backup OK
```

The backup runs as uid 70, uses the matching pinned PostgreSQL 18 client, writes a partial file then renames atomically, and retains the newest seven timestamped dumps. A destructive restore was not part of this task's proof and was not run.

## Monitoring proof

`python3 services/todo/api/test/observability-proof.py` starts temporary kubectl port-forwards for Prometheus, Loki and Tempo, queries their HTTP APIs and closes all forwards in finally.

- `GET /api/v1/query?query=up{namespace="todo"}` returned 1 for both API pods and todo-db-1.
- Loki `GET /loki/api/v1/query_range`, query `{namespace="todo"} |= "request"`, returned a todo JSON request log with RFC 3339 time, string level, service, trace_id, span_id, user, method, route, path, status, duration_ms and bytes. Final sample pod `todo-68b4bf94bf-2m6lx`, trace_id `7f0858e231365ce2744fc583d7cfa2b1`.
- Tempo `GET /api/search?tags=service.name%3Dtodo` returned todo traces. `GET /api/traces/307e55ee6d7fb7fb6c674955eaaf433` returned one batch with PostgreSQL instrumentation.
- Final script output: `OBSERVABILITY PROOF PASSED`.

The first monitoring check revealed that the reference DB policy omitted Prometheus access to port 9187. Adding a narrowly selected monitoring/Prometheus ingress rule changed the DB target from up=0 to up=1.

## Contract changes and choices

No edits to `docs/architecture.md`. Added database exporter ingress from the contract's Prometheus pods on 9187, needed by the existing CloudNativePG PodMonitor. Other names, ports, identity headers, expected origin, metric names, log fields and backup shapes follow the contract.

Chose numeric ranks for ordering, personal labels whose IDs can be retained by project editors, UTC due instants plus dateOnly intent, durable non-expiring events, one-second heartbeat/fallback polling, transactionally ordered event IDs, and a per-task/scheduled-instant reminder claim with a conditional version-checked update. Import is additive with remapped IDs, exports owned projects and personal labels, and preserves membership/comments/completed tasks; it is not a database restore. Members' independently owned label definitions are not exported with another user's data.

## Remaining integration work

The React UI is deliberately owned by another task and remains outside this implementation. Once its files are complete, rerun `make deploy-todo` to combine the final API and final React bundle through the normal Dockerfile, then perform the UI task's headless browser checks. The latest API is already deployed and independently proven with the previously built placeholder.

Operational limits are documented in README.md: no task pagination or event retention yet; imports limited to 2 MiB; cross-project parent moves require moving children first; duplicate copies one task, not an entire subtask tree; DST gap/overlap local times use the Intl calendar helper's resolution. No email/push reminders, only live events. No root-cluster deletion, git commits or out-of-scope file changes were performed.

Reusable debugging finding for the coordinator's work-history record: Zod 4 `.partial()` retains create defaults. Every PATCH schema must remove those defaults or a title-only update resets fields such as due/recurrence/priority. The new regression test proves field preservation. Recording outside the owned paths was left to the coordinator.
