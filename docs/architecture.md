# Lab platform contract

This file is the contract every part of the repo builds against. If you need to change a name, port, header or path listed here, say so in your report; the coordinator updates this file.

## What the platform is

One single-node Kubernetes cluster (native k3s) that hosts:

| App | Host | Namespace | Who can open it | What it is |
|---|---|---|---|---|
| Home | `home.${DOMAIN}` | `home` | users | Static portal with tiles for every app |
| Auth | `auth.${DOMAIN}` | `auth` | everyone | Authelia single sign-on portal |
| Storage | `storage.${DOMAIN}` | `storage` | users (public share paths: everyone) | File server for the owner and friends, with sharing and an in-browser file viewer (Go + React) |
| Todo | `todo.${DOMAIN}` | `todo` | users | Feature-complete todo app with shared projects (TypeScript + React) |
| PDF | `pdf.${DOMAIN}` | `pdf` | users | Stirling PDF |
| Grafana | `grafana.${DOMAIN}` | `monitoring` | admins | Dashboards for metrics, logs and traces |
| Prometheus | `prometheus.${DOMAIN}` | `monitoring` | admins | |
| Alertmanager | `alertmanager.${DOMAIN}` | `monitoring` | admins | |
| Traefik | `traefik.${DOMAIN}` | `traefik` | admins | Traefik dashboard |

Load generation and synthetic checks run as k6 Jobs and a CronJob in namespace `loadgen`.

## Profiles

- `local` (default): a native single-node k3s server on this machine (systemd unit `k3s`, starts on boot), `DOMAIN=lab.localhost` (browsers, curl and systemd-resolved send `*.localhost` to loopback with no DNS setup), self-signed CA, Traefik's ports served only on `127.0.0.1`. k3s's API server (TCP 6443) and kubelet (TCP 10250) listen on every interface and require TLS client certificates or tokens. flannel uses the `host-gw` backend (one node needs no tunnel), so there is no VXLAN port.
- `ci`: same as local with smaller retention, for GitHub Actions (16 GB RAM, 14 GB disk). The runner has passwordless `sudo` and systemd, so `make up` installs k3s there the same way.
- `remote`: for real use with friends. A real domain whose wildcard record points at the machine (for example its Tailscale address), `LISTEN_ADDRESS` set to that address, Let's Encrypt through cert-manager DNS-01, `AUTH_POLICY=two_factor`. Documented in `platform/README.md`; the issuer template is committed but may be unverified.

In every profile, data that must survive a cluster rebuild lives on the host under `${DATA_DIR}` (see "Data").

## Configuration and rendering

- `config/local.env` holds committed, non-secret defaults: `PROFILE=local`, `DOMAIN=lab.localhost`, `CLUSTER_NAME=lab`, `LISTEN_ADDRESS=127.0.0.1`, `HTTP_PORT=80`, `HTTPS_PORT=443`, `AUTH_POLICY=one_factor`, `ENVIRONMENT=local`, `DATA_DIR=.local/data`. `DATA_GID` (the storage pod's group) defaults to the caller's primary group (`id -g`); `scripts/lib.sh` refuses 0 and anything that is not a group ID.
- `config/versions.env` pins tool and chart versions used by scripts (k3s `v1.37.2+k3s1` with the SHA-256 of its amd64 and arm64 binaries and of its `install.sh`, kubectl v1.37.2, charts, image pins). `CERT_ISSUER` and `ACME_EMAIL` select the certificate issuer for the remote profile.
- An optional untracked `config/override.env` overrides both.
- YAML files and Helm values that need these values contain `${VAR}` placeholders. `scripts/lib.sh` provides `render FILE...` (and stdin), which runs `envsubst` with an explicit allowlist (`RENDER_VARS`: `PROFILE DOMAIN DOMAIN_REGEX CLUSTER_NAME LISTEN_ADDRESS HTTP_PORT HTTPS_PORT AUTH_POLICY ENVIRONMENT DATA_DIR DATA_GID IMAGE_TAG AUTH_PUBLIC_URL HOME_URL CERT_ISSUER ACME_EMAIL NODE_PORT_RANGE NODE_PORT_ADDRESSES` plus the image pins). Never run `envsubst` without the allowlist: Grafana dashboards and PromQL contain `$` signs.
- `scripts/lib.sh` derives `KCTX=k3s-${CLUSTER_NAME}` (the kubectl context, `k3s-lab` by default), `NODE_PORT_RANGE` (`<lower of HTTP_PORT and HTTPS_PORT>-32767`) and `NODE_PORT_ADDRESSES` (`${LISTEN_ADDRESS}/32`, or `0.0.0.0/0` when `LISTEN_ADDRESS=0.0.0.0`). See "Ingress and TLS".
- Generated secrets and credentials live in `.local/` (gitignored, mode 700). The CA key `.local/ca.key` is generated once and kept across rebuilds (trust the CA once); the CA only signs `${DOMAIN}` and its subdomains, and its certificate is published as ConfigMap `lab-ca` (key `ca.crt`) in the app namespaces. `.local/credentials.env` holds `ADMIN_USER`, `ADMIN_PASSWORD`, `ALICE_PASSWORD`, `BOB_PASSWORD`, `LOADGEN_USER`, `LOADGEN_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`. `.local/ca.crt` is the local root CA. Regeneration is idempotent: existing values are kept.
- Scripts use a pinned `kubectl` downloaded with checksum verification into `.local/bin/` (within one minor version of k3s's Kubernetes), not whatever is on `PATH`. `scripts/tools.sh` also downloads and verifies the pinned k3s binary and its `install.sh` into `.local/k3s/` (not on `PATH`). It requires `sudo` and `systemctl` on `PATH` besides `helm`, `docker`, `envsubst`, `jq`, `curl` and `openssl`.
- The repo is public. Never commit a secret, password hash, private key or token.

## Bring-up order

`make up` runs these steps. Each is idempotent (safe to rerun after a partial failure) and waits for what it creates (CRDs established, Deployments rolled out):

1. Install or converge the k3s server (`K3S_VERSION`), one node for every profile:
   - If the old kind cluster `${CLUSTER_NAME}` still exists (it holds host ports 80/443), stop and print the migration steps (`platform/README.md`, "Migration from kind").
   - Render `cluster/k3s.yaml` to `.local/k3s-config.yaml`. It disables k3s's bundled Traefik, ServiceLB and metrics-server (the platform installs its own Traefik and metrics-server), labels the node `ingress-ready=true`, and sets the node port range and addresses (see "Ingress and TLS"). It holds no secrets.
   - Only when `/usr/local/bin/k3s --version` isn't `K3S_VERSION`, `/etc/rancher/k3s/config.yaml` differs, or the `k3s` unit isn't active: `sudo` installs the config (mode 0644) and the checksum-verified binary to `/usr/local/bin/k3s`, then runs k3s's pinned `install.sh` with no download and no `kubectl`/`crictl`/`ctr` symlinks (forcing a restart when only the config changed). Otherwise it logs "k3s <version> already running" and uses no `sudo`.
   - If `.local/kubeconfig` is missing or can't reach the API, copy `/etc/rancher/k3s/k3s.yaml` (mode 0600, read with `sudo`) to `.local/kubeconfig` (mode 0600) with its cluster, user and context renamed to `${KCTX}`. Wait for the API, then for the node to be Ready. Best effort: merge the context into `~/.kube/config`.
2. Add a CoreDNS rewrite so every pod resolves `*.${DOMAIN}` and `${DOMAIN}` to the Traefik service (`traefik.traefik.svc.cluster.local`), with anchored, escaped matching and answer rewriting. The block lives in ConfigMap `kube-system/coredns-custom`, key `lab-domain.override` (rendered from `platform/dns/rewrite.corefile`), which k3s's CoreDNS imports into its main server block. CoreDNS restarts only when that data changed. k3s re-applies its own `coredns` ConfigMap, so nothing edits it.
3. `platform/observability/install-crds.sh` (Prometheus Operator CRDs, so later charts can create ServiceMonitors).
4. cert-manager, a self-signed root CA (`ClusterIssuer` named `lab-ca`), and a wildcard certificate for `*.${DOMAIN}` + `${DOMAIN}` in secret `traefik/lab-wildcard-tls`, used as Traefik's default TLS store. The CA is exported to `.local/ca.crt`.
5. Traefik.
6. The host-backed PersistentVolumes listed under "Data" (Authelia needs `auth-data`), then Authelia, the identity middlewares, and the generated users.
7. CloudNativePG operator (namespace `cnpg-system`).
8. `platform/observability/install.sh` (full observability stack). If it fails, `make up` continues and exits non-zero at the end.
9. Stirling PDF and the Home portal.
10. Apps.

When steps 1 to 7 succeed, `make up` writes `.local/cluster-ready`. Tasks that need the cluster wait for that file.

Make targets: `up`, `down` (asks for `CONFIRM=1`; when k3s is installed it first runs `scripts/backup.sh` and refuses if the cluster is not running, a CloudNativePG cluster has no `<app>-db-backup` CronJob in its namespace, or a dump fails, unless `SKIP_BACKUP=1`; then runs `sudo /usr/local/bin/k3s-uninstall.sh`, which removes k3s from the machine with the cluster and its local-path volumes, then removes the `${KCTX}` context from `~/.kube/config` and deletes `.local/kubeconfig` and `.local/cluster-ready`; `${DATA_DIR}` and the rest of `.local/` stay; without k3s installed it says so), `status`, `creds` (print URLs and logins), `deploy-<app>`, `backup`, `restore`, `offsite` (restic copy of `${DATA_DIR}` and the `.local/` secrets to `RESTIC_REPOSITORY`), `offsite-timer` (installs the nightly systemd user timer for `offsite`), `load-<scenario>`, `e2e`, `smoke`.

### Apps and images

- An app is deployable when `services/<app>/Dockerfile` and `services/<app>/deploy/kustomization.yaml` both exist.
- Images build from the repo root, so a Dockerfile can copy `packages/ui/` and `tools/`: `docker build -f services/<app>/Dockerfile -t lab/<app>:<tag> .`
- Tags are immutable: `<tag>` is the first 16 hex characters of the built image ID. Manifests reference `lab/<app>:${IMAGE_TAG}`; `make deploy-<app>` builds, imports the image into k3s's containerd when it isn't there yet (`docker save lab/<app>:<tag> | sudo /usr/local/bin/k3s ctr -n k8s.io images import -`), renders `kubectl kustomize services/<app>/deploy` with `IMAGE_TAG` set, applies it, and waits for the rollout. Deployments use `imagePullPolicy: IfNotPresent`.
- This machine has no `docker buildx`, so the legacy builder runs: Dockerfiles must not use heredocs (`RUN <<EOF`) or `RUN --mount`. The root `.dockerignore` excludes `.git`, `.local`, `**/node_modules`, `**/dist`, `coverage` and `test-results`; per-Dockerfile ignore files don't work.
- Namespaces belong to the platform: `home`, `storage`, `todo`, `auth`, `traefik`, `cnpg-system` and `loadgen` exist with Pod Security `restricted`, `pdf` with `baseline` (Stirling PDF can't run as non-root). App deploy folders must not include Namespace objects.
- Every pod an app owns (app, backup and restore Jobs) carries `app.kubernetes.io/name=<app>`; NetworkPolicies and the restore Job rely on it.

## Ingress and TLS

- Traefik v3 (pinned), installed by Helm into namespace `traefik`, on the node labelled `ingress-ready=true`. The Traefik Service is `NodePort` with `externalTrafficPolicy: Local` and node ports `${HTTP_PORT}` and `${HTTPS_PORT}` (80 and 443 by default). k3s's API server allows them through `service-node-port-range=${NODE_PORT_RANGE}`, and kube-proxy serves node ports only on `${LISTEN_ADDRESS}` (`nodeport-addresses=${NODE_PORT_ADDRESSES}`), so the local profile answers on `127.0.0.1` only. A process already listening on those host ports would be shadowed by kube-proxy. Not a hostPort: namespace `traefik` enforces Pod Security `restricted`, which rejects hostPort. Not hostNetwork: it would bypass the NetworkPolicies that admit app traffic only from Traefik pods. Entry points `web` (redirects to HTTPS) and `websecure`. Entry points do not trust client `X-Forwarded-*` headers (`forwardedHeaders.insecure=false`, no trusted IPs unless the remote profile has a real upstream proxy).
- Routes use Traefik CRDs (`IngressRoute`, `Middleware`). `providers.kubernetesCRD.allowCrossNamespace=true`, so app routes reference middlewares in namespace `auth` as `auth-<name>@kubernetescrd`.
- Every route uses TLS from the default store (`tls: {}`). There is no IPv6 listener; clients that try `::1` first fall back to `127.0.0.1`.
- Traefik answers `400` to `%2F`, `%5C` and `%00` in paths. It forwards `//s/x` and `/%73/x` as `/s/x`, and `/assets/..;/api/x` unchanged, so public handlers must never normalise a request into a private route.
- Traefik's router and service labels arrive in Prometheus as `exported_router` and `exported_service`.
- Traefik exports Prometheus metrics (entry point `metrics`, port 9100, per-router and per-service labels), OTLP traces to `alloy.monitoring.svc.cluster.local:4318` over HTTP, and JSON access logs with `RequestPath` and all request headers dropped (paths can carry share tokens).
- Body size: Traefik does not cap request bodies on the storage route. Read and write timeouts on `websecure` allow multi-GiB uploads and downloads and long-lived server-sent event streams.

## Identity

- Authelia (pinned; namespace `auth`, service `authelia`, port 9091) is the only login. File user backend rendered from `.local/` into a Secret, argon2id hashes, a session cookie scoped to `${DOMAIN}` (`session.cookies[]` with an HTTPS `authelia_url`), regulation on, filesystem notifier, its SQLite database on the host-backed volume `auth-data`. Sessions are kept in memory: restarting Authelia signs everyone out (declared, accepted for one replica).
- Users created locally: `admin` (groups `admins`, `users`), `alice` and `bob` (group `users`), `loadgen` (groups `users`, `loadgen`). `scripts/users.sh add <username> <email> [--admin]` adds a friend and prints a generated password; `scripts/users.sh passwd <username>` resets one.
- Access control: default deny. Group `users` gets `${AUTH_POLICY}` on Home, Storage, Todo and PDF. Grafana, Prometheus, Alertmanager and the Traefik dashboard need group `admins`. User `loadgen` always gets `one_factor` (rule listed first).
- Middlewares in namespace `auth`:
  - `strip-identity`: deletes any client-sent `Remote-User`, `Remote-Groups`, `Remote-Email`, `Remote-Name` headers.
  - `sso`: Traefik `forwardAuth` to `http://authelia.auth.svc.cluster.local:9091/api/authz/forward-auth`, `trustForwardHeader: true` (safe because entry points don't trust client values), `forwardBody: false`, copying back `Remote-User`, `Remote-Groups`, `Remote-Email`, `Remote-Name`.
  - `sso-chain`: `strip-identity` then `sso`. Every authenticated route uses `auth-sso-chain@kubernetescrd`.
- Public routes use only `auth-strip-identity@kubernetescrd`. Today only the storage app has them: path prefixes `/s/`, `/api/public/`, `/assets/` and the exact path `/favicon.svg` on `storage.${DOMAIN}`, with a higher priority than the authenticated catch-all route. Prefixes match on segment boundaries (`/s/` does not match `/sx`).
- Logout link: `${AUTH_PUBLIC_URL}/logout?rd=<URL-encoded ${HOME_URL}>`, for example `https://auth.lab.localhost/logout?rd=https%3A%2F%2Fhome.lab.localhost%2F`, where `AUTH_PUBLIC_URL=https://auth.${DOMAIN}` and `HOME_URL=https://home.${DOMAIN}/`. After logout, Home sends the browser to the Authelia login page.
- Anonymous GET requests on SSO routes get `302` to `https://auth.${DOMAIN}/?rd=...`; anonymous POST, PUT and DELETE get `303`. An SPA must fetch with `redirect: "manual"` and treat an opaque redirect or 3xx as "signed out" (reload the page).
- Logging in without a browser (k6, tests): `POST https://auth.${DOMAIN}/api/firstfactor` with JSON `{"username":"...","password":"...","keepMeLoggedIn":false}` returns `{"status":"OK"}` and cookie `authelia_session` (Domain `${DOMAIN}`), valid on every app host.
- Home serves `GET https://home.${DOMAIN}/api/me` with `{"user","name","email","groups"}` from the identity headers (`401` when absent).
- Authelia also allows `whoami.${DOMAIN}`, used only by `make smoke`.
- Each password check costs 64 MiB (argon2id). Traefik's `auth/login-limit` middleware caps concurrent `POST /api/firstfactor` requests at 6 across all clients and answers `429` beyond that, so a login burst can't OOM-kill Authelia and sign everyone out. Clients retry on `429` with jittered backoff. `make smoke` proves the cap.

### What an app does with identity

- On every authenticated route, read `Remote-User` (the username, required), `Remote-Email`, `Remote-Name`, `Remote-Groups` (comma-separated). Missing `Remote-User` means `401` with a JSON error body.
- Upsert a local user row keyed by username (cache it briefly). Group `admins` grants admin rights inside the app.
- Public handlers never read identity headers, validate their own capability (the share token), and never fall through to private handlers.
- Local development without Authelia: `AUTH_MODE=dev` plus `DEV_USER=<name>` and optional `DEV_GROUPS`. The default is `AUTH_MODE=header`. Refuse `AUTH_MODE=dev` unless `APP_ENV=development`.

### Request forgery and CORS

Sibling subdomains are same-site and share the session cookie, so every app enforces:

- No CORS: never send `Access-Control-Allow-*` headers.
- State changes only through POST, PUT, PATCH or DELETE, never GET.
- A mutating request must carry `X-Requested-With: fetch`. If it carries an `Origin` header, the value must equal the app's own origin (`https://<app>.${DOMAIN}`). A missing `Origin` is allowed (non-browser clients such as k6). If the request has a body, its `Content-Type` must be `application/json` or `multipart/form-data` (or `application/octet-stream` for upload chunks). DELETE may have no body. Anything else gets `403`.
- Tests cover a sibling-origin request (`Origin: https://pdf.${DOMAIN}`) being refused.

### User content

- Downloads use `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- HTML, SVG, XML and any script-capable type are never served inline. They are downloads, or the SPA fetches them as text and shows them escaped.
- Inline media (images, video, audio, PDF bytes for pdf.js) is served with `nosniff`, a safe explicit content type, and `Content-Security-Policy: sandbox; default-src 'none'` plus only the directives the media needs.
- Markdown is rendered by the SPA with raw HTML disabled and the output sanitized.
- Preview, thumbnail and Range endpoints enforce the same authorization as downloads.

## Data

- Static PersistentVolumes with `storageClassName: lab-host` (created at step 6 by the platform task) point at directories under `${DATA_DIR}` on the host and bind to fixed claims. `scripts/lib.sh` makes `DATA_DIR` absolute, and `make up` applies `platform/storage/storage.yaml` through `render`:

  | PV | Host path | Claim (namespace/name) |
  |---|---|---|
  | `storage-data` | `${DATA_DIR}/storage` | `storage/storage-data` |
  | `storage-backups` | `${DATA_DIR}/backups/storage` | `storage/storage-backups` |
  | `todo-backups` | `${DATA_DIR}/backups/todo` | `todo/todo-backups` |
  | `auth-data` | `${DATA_DIR}/auth` | `auth/auth-data` |

  Pods mount these through PVCs (allowed under Pod Security `restricted`). Deleting the cluster leaves the data on the host. The leaf directories are mode 0777 because hostPath volumes ignore `fsGroup` (decision 17).
- `DATA_DIR` must not be inside `/var/lib/rancher`, `/var/lib/kubelet`, `/run/k3s`, `/etc/rancher` or `/var/lib/cni`: k3s's uninstaller (`make down`) deletes those. `scripts/lib.sh` refuses to run otherwise.
- PostgreSQL runs through CloudNativePG. Each app owns its own `Cluster` named `<app>-db` in its namespace (1 instance locally), database `<app>`, owner `<app>`, on k3s's default `local-path` storage class (under `/var/lib/rancher/k3s/storage`, which `make down` deletes). The app reads `DATABASE_URL` from secret `<app>-db-app`, key `uri`. Apps run migrations at startup under an advisory lock and retry until the database is ready.
- Database backups: each app's deploy folder includes a CronJob named `<app>-db-backup` (nightly at 03:00, keeps the newest 7) that mounts claim `<app>-backups` at `/backups` and writes `pg_dump --format=custom` to `/backups/<app>-<UTC timestamp YYYYmmddTHHMMSSZ>.dump`, using the `<app>-db-app` secret. It uses a pinned `postgres` client image matching the server's major version and runs as non-root under `restricted`.
- `make backup` (platform) runs `kubectl create job --from=cronjob/<app>-db-backup` for every app that has one and waits. `make restore` (platform) scales every Deployment in the app's namespace to 0, runs a one-off Job that copies the backup CronJob's pod template and restores the newest dump with `pg_restore --clean --if-exists --no-owner` into the app's database, then scales them back. `pg_restore --clean` only drops objects that are in the dump. Backup images: `postgres:18.6-alpine3.24` (uid 70). A working reference is `platform/smoke/db.yaml`. Restoring blobs needs no extra step: the storage app never deletes a blob file straight away but moves it to `quarantine/` on `storage-data`. It deletes a quarantined blob only once `BLOB_QUARANTINE_RETENTION` (default 8 days) has passed and the blob was quarantined before the oldest kept `storage-*.dump` (it reads `storage-backups`, mounted read-only at `/backups`), so every kept dump finds its files. The cleanup it runs at startup moves back every quarantined blob the restored database references. Files uploaded after the restored dump lose their database rows; they are quarantined rather than deleted, so their bytes (without names) stay recoverable from `quarantine/` until the retention ends.
- Off-disk copy: `make offsite` (`scripts/offsite.sh`) backs up `${DATA_DIR}`, `.local/` and `config/override.env` with restic to `RESTIC_REPOSITORY`, which must be set in `config/override.env`. It refuses a repository inside the checkout, `${DATA_DIR}` or `.local/`, and warns when it is on `${DATA_DIR}`'s device. From `.local/` it leaves out `bin/`, `k3s/`, `kubeconfig`, `cluster-ready` and the password file. The password is `RESTIC_PASSWORD_FILE` (default `.local/restic-password`, generated once, mode 600); the owner keeps a copy off the machine. When the cluster is running it runs `make backup` first, otherwise it copies the existing dumps. After each snapshot it keeps 7 daily, 4 weekly and 6 monthly snapshots; an incomplete one (restic exit 3) makes it exit 3. Only a run from a terminal (or `OFFSITE_INIT=1`) creates a repository, and `make offsite-timer` installs the timer only for a repository that opens. `make offsite-timer` installs the systemd user units `lab-offsite.{service,timer}` (03:30 UTC, after the 03:00 UTC dumps; `Persistent=true`). restic runs as the owner, so the storage pod runs as UID 65532 with `runAsGroup: ${DATA_GID}` (the owner's primary group by default) and writes `${DATA_DIR}/storage` with directories 0750 and files 0640. At startup, in the background, the storage app moves every entry it owns there to its group and those modes, which fixes data written before (0700/0600, group 65532).
- Storage file contents live on `storage-data`, named by opaque ID, never by user-supplied path.

## Observability

Namespace `monitoring`. The observability task owns everything there.

- Prometheus (kube-prometheus-stack) selects every `ServiceMonitor`, `PodMonitor`, `PrometheusRule` and `Probe` in every namespace with no label selector, stores exemplars, and accepts remote write (k6) at `http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write` (Service `prometheus`, port 9090; the chart's own Service is `kps-prometheus`). Alertmanager is also reachable as `alertmanager.monitoring:9093`. Namespace `monitoring` is Pod Security `privileged` because node-exporter reads the host. node-exporter runs with `hostNetwork: false`, so it doesn't serve host metrics on the host's interfaces and the `monitoring` NetworkPolicies apply to it. The platform's metrics-server runs there too (k3s's bundled one is disabled), so `kubectl top` works.
- Grafana Alloy receives OTLP at `alloy.monitoring.svc.cluster.local` ports 4317 (gRPC) and 4318 (HTTP), forwards traces to Tempo, and ships every pod's logs and Kubernetes events to Loki. It redacts share tokens (path segments after `/s/` and `/api/public/`) from span attributes and log lines.
- Grafana signs users in from the `Remote-User` header (auth proxy behind `sso-chain`; only admins reach it). Datasources Prometheus, Loki, Tempo and Alertmanager with fixed UIDs, linked so a trace opens its logs, a log line with `trace_id` opens its trace, and a latency exemplar opens its trace.
- `platform/observability/README.md` keeps a signal matrix: for every component, which metrics, logs and traces exist, and which don't and why (for example, Stirling PDF's native Prometheus metrics need a paid tier, so it is covered by Traefik service metrics, probes and its logs).
- Every app we write ships three signals:
  - **Metrics.** Prometheus text format at `GET /metrics` on a dedicated port named `metrics` (9464), never on the public port. The app's Service exposes it, and the app's deploy folder includes a `ServiceMonitor`.
  - **Traces.** OTLP over HTTP. Environment: `OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.monitoring.svc.cluster.local:4318`, `OTEL_SERVICE_NAME=<app>`, `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=${ENVIRONMENT},service.namespace=lab`. W3C trace context continues from Traefik. Database calls create child spans. No share tokens, cookies or passwords in span attributes.
  - **Logs.** One JSON object per line on stdout with keys `time` (RFC 3339), `level` (`debug`, `info`, `warn`, `error`), `msg`, `service`, and inside a request `trace_id`, `span_id`, `user`. Access logs add `method`, `route`, `path` (with share tokens replaced by `{token}`), `status`, `duration_ms`, `bytes`. Never log cookies, passwords or tokens.
- Required HTTP metrics, same names in every app so one dashboard covers them all:
  - `http_server_request_duration_seconds` histogram. Labels `method`, `route` (the route template, such as `/api/files/{id}`, never the raw path; unmatched requests use `route="unmatched"`), `status_code`. Buckets `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60`. Exemplars carry `trace_id` when the request is traced.
  - `http_server_active_requests` gauge.
  - Default runtime/process collectors for the language.
- Required domain metrics (apps may add more and must list all of them in `services/<app>/METRICS.md`):
  - Storage: `storage_upload_bytes_total`; `storage_download_bytes_total{kind="download|preview|public"}`; `storage_uploads_total{result="ok|error|quota|too_large"}`; `storage_files` (gauge, all users); `storage_used_bytes` (gauge); `storage_shares_active{type="user|link"}` (gauge); `storage_volume_free_bytes` (gauge); `storage_preview_requests_total{kind="image|video|audio|pdf|text|markdown|office|other"}`; `storage_thumbnail_duration_seconds` (histogram).
  - Todo: `todo_tasks_created_total`; `todo_tasks_completed_total`; `todo_tasks_open` (gauge); `todo_projects` (gauge); `todo_live_connections` (gauge, server-sent event clients).
- Health: `GET /healthz` (process alive, no dependencies) and `GET /readyz` (database reachable) on the app port.
- Database metrics come from the observability task's PodMonitor for every CloudNativePG cluster (port 9187); app NetworkPolicies allow that port from Prometheus pods. Apps don't ship their own database PodMonitor.
- k6 runs set `K6_PROMETHEUS_RW_TREND_STATS=p(50),p(90),p(95),p(99),avg,max` (k6 v2.3 sends only p99 by default) and tag every run with `testid`. Authelia answers `401` instead of `302` to requests without an `Accept` header, so k6 must log in through `/api/firstfactor` before calling an app.
- Alloy runs as one Deployment that tails logs through the Kubernetes API (no hostPath, non-root); a new pod's first lines arrive 10 to 30 seconds late.
- Alerts route to an in-cluster webhook sink by default (its received alerts land in Loki), so alert delivery is testable without outside services.

## Kubernetes conventions

- Labels on everything we write: `app.kubernetes.io/name`, `app.kubernetes.io/part-of: lab`, `app.kubernetes.io/component`.
- App namespaces (`home`, `storage`, `todo`) enforce Pod Security `restricted`. Containers run as non-root, drop all capabilities, use `seccompProfile: RuntimeDefault`, a read-only root filesystem where the app allows it, and set resource requests and limits. The storage app runs as UID 65532 in group `${DATA_GID}` (rendered); `restricted` does not constrain `runAsGroup`.
- NetworkPolicies deny ingress by default in `home`, `storage`, `todo`, `pdf`, `auth` and `monitoring`. Each allows only what it needs, selecting both namespace and pod labels:
  - App HTTP port from the Traefik pods in namespace `traefik`.
  - Metrics port from the Prometheus pods in namespace `monitoring`.
  - Database pods (`cnpg.io/cluster=<app>-db`, port 5432) from the app's own pods and backup Jobs; CloudNativePG instance ports from the operator in `cnpg-system`.
  - Authelia port 9091 from Traefik pods only. Stirling PDF port 8080 from Traefik pods and storage app pods (`app.kubernetes.io/name=storage` in namespace `storage`).
  - Pod labels to select: Traefik `app.kubernetes.io/name=traefik` (namespace `traefik`); Prometheus `app.kubernetes.io/name=prometheus` and the blackbox exporter `app.kubernetes.io/name=prometheus-blackbox-exporter` (namespace `monitoring`); CloudNativePG operator `app.kubernetes.io/name=cloudnative-pg` (namespace `cnpg-system`, ports 8000 and 5432).
  - Egress stays open.
- k3s enforces NetworkPolicy with its embedded kube-router controller. Like any policy controller it fails open if it doesn't start, so `make smoke` rechecks enforcement on every run. kube-router admits traffic whose source is the node itself, so kubelet probes still reach pods under default deny. Any process on the host gets the same access and could forge `Remote-*` headers, so a shell on the server is trusted (`platform/README.md`, "Security on the server").
- In-cluster access to public hostnames: CoreDNS rewrites `*.${DOMAIN}` to the Traefik ClusterIP. curl and Chromium treat `*.localhost` as loopback without asking DNS, so inside pods use `curl --resolve <host>:443:<traefik ClusterIP>`. Go programs (k6) use `/etc/hosts` then DNS.
- Ports: app HTTP 8080, metrics 9464.

## Cross-app integration

- Stirling PDF 3.2.2 has no free Prometheus metrics (`/actuator/prometheus` returns 404 without a paid licence); it is covered by Traefik service metrics, probes and logs.
- Storage previews Office documents (docx, xlsx, pptx, odt, ods, odp) by converting them to PDF through Stirling PDF at `STIRLING_URL=http://stirling-pdf.pdf.svc.cluster.local:8080`, with a concurrency limit and a cache. If conversion fails, the viewer offers a download instead. The API calls are documented in `platform/stirling-pdf/README.md`. The preview endpoint answers `202` while converting and the viewer polls it, because a request that sends no response headers for about 15 seconds gets closed by the client side (Traefik logs `499`). Any app endpoint that can take that long must answer early and be polled, and SSE streams must send heartbeats more often than that.
- Home, Storage and Todo share one top bar: an app switcher (Home, Storage, Todo, PDF, Grafana for admins), the signed-in user, and a sign-out link. Visual tokens come from `packages/ui/tokens.css`. Stirling PDF and Grafana keep their own UI.

## Repo layout and ownership

| Path | Owner |
|---|---|
| `cluster/`, `scripts/`, `Makefile`, `config/`, `platform/` except `platform/observability/` | platform |
| `platform/observability/` | observability |
| `services/storage/` (Go module, `web/`, `deploy/`, `API.md`, `METRICS.md`) | storage |
| `services/todo/` (`api/`, `web/`, `deploy/`, `API.md`, `METRICS.md`) | todo |
| `packages/ui/`, `services/home/site/`, `docs/design/` | design |
| `services/home/Dockerfile`, `services/home/deploy/` | platform |
| `loadgen/` | load generator |
| `tests/e2e/` | end-to-end |
| `.github/`, `README.md`, `docs/architecture.md`, `docs/decisions.md`, `tools/` | coordinator |

JavaScript projects use pnpm 12.17.0. Each JavaScript project has its own `package.json` and `pnpm-lock.yaml` (no root workspace), so tasks never write the same lockfile. Dockerfiles install pnpm through `tools/install-corepack.mjs`, never with npm.

## Release gates

Before merge, observed in the running cluster: from-scratch `make up` succeeds and a second run is idempotent; the security checks in the platform brief pass; storage and todo end-to-end flows pass in headless Playwright through real SSO; a backup, `make down` (which dumps first), `make up`, `make restore` cycle keeps files, shares and todos; dashboards show live data for every app; an alert reaches the webhook sink; each k6 scenario runs and its results appear in Grafana.
