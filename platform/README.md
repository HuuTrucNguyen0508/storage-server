# Lab platform

One kind cluster on this machine that hosts Home, Storage, Todo, Stirling PDF and the observability stack. Authelia handles sign-in for all of them, Traefik serves them over HTTPS, and app data lives on the host. `docs/architecture.md` is the contract. This file covers how to run the platform.

## Bring it up

You need Linux, Docker, `helm`, `jq`, `envsubst`, `openssl` and `curl`. `make up` downloads pinned `kind` and `kubectl` into `.local/bin/` and checks their checksums. It ignores any `kind` or `kubectl` already on your `PATH`.

```sh
make up        # create or converge everything (about 3 minutes from scratch, about 15 s when nothing changed)
make creds     # URLs and every login
make status    # nodes, Helm releases, unhealthy pods, volumes, routes, certificates
make smoke     # security checks against the running cluster (about 2 minutes)
make down CONFIRM=1   # delete the cluster; .local/ and the data directory stay
```

`make up` is idempotent: rerun it after a failure or a change. It runs these steps:

1. Create the kind cluster (1 control plane and 2 workers; one node for `PROFILE=ci`).
2. Patch CoreDNS so `*.${DOMAIN}` resolves to Traefik inside the cluster.
3. Install the Prometheus Operator CRDs.
4. Install cert-manager and issue the wildcard certificate.
5. Install Traefik.
6. Create the host-backed volumes and install Authelia with the users.
7. Install the CloudNativePG operator. `.local/cluster-ready` is written after this step.
8. Install the observability stack.
9. Deploy Stirling PDF and Home.
10. Deploy every `services/<app>` that has a `Dockerfile` and `deploy/kustomization.yaml`.

Set `SKIP_APPS=1` to skip step 10. If step 8 or an app fails, the remaining steps still run, and `make up` exits non-zero at the end.

`kubectl` setup: `export KUBECONFIG=$PWD/.local/kubeconfig`. `make up` also adds context `kind-lab` to `~/.kube/config`.

Deploy a single app with `make deploy-<app>`. It builds `services/<app>/Dockerfile` from the repo root and tags the image `lab/<app>:<16 hex chars of the image ID>`, so the tag is immutable. It then loads the image into kind, renders `kubectl kustomize services/<app>/deploy` with `IMAGE_TAG` set, applies it and waits for the rollout. This machine has no `docker buildx`, so the legacy builder runs: no `RUN <<EOF` heredocs and no `RUN --mount`.

## URLs and logins

| URL | Who |
|---|---|
| https://home.lab.localhost/ | users |
| https://storage.lab.localhost/ | users (share links: anyone) |
| https://todo.lab.localhost/ | users |
| https://pdf.lab.localhost/ | users |
| https://grafana.lab.localhost/, https://prometheus.lab.localhost/, https://alertmanager.lab.localhost/, https://traefik.lab.localhost/dashboard/ | admins |
| https://auth.lab.localhost/ | sign-in |

`*.localhost` resolves to the loopback address in browsers and curl without any DNS setup. Nothing listens on `::1`. Chromium and curl fall back to `127.0.0.1` (tested by `make smoke` and a headless Chromium run).

`make creds` prints every login. Built-in accounts:

| User | Groups |
|---|---|
| `admin` | `admins`, `users` |
| `alice` | `users` |
| `bob` | `users` |
| `loadgen` | `users`, `loadgen` (always one factor; used by k6) |

Passwords are generated into `.local/credentials.env` and `.local/passwords/<user>`. Sign out with the link in the top bar, or open `https://auth.lab.localhost/logout?rd=https%3A%2F%2Fhome.lab.localhost%2F`. The sign-out link was tested in headless Chromium: after it, Home and PDF both ask for a new login.

### Add a friend

```sh
scripts/users.sh add dana dana@example.com            # prints dana's generated password
scripts/users.sh add erin erin@example.com --admin    # also in group admins
scripts/users.sh passwd dana                          # new password
scripts/users.sh remove dana
scripts/users.sh list
```

Changes go to Secret `auth/authelia-users`. A sidecar copies the Secret into Authelia's watched directory, and Authelia reloads the users within about a minute without signing anyone out (tested: a new user logged in after 48 s, and an existing session stayed valid). Send the password over a private channel. Authelia allows 5 failed logins in 2 minutes, then bans that username for 10 minutes.

### Trust the local CA

`.local/ca.crt` is the root of every certificate. It is created once, kept across rebuilds, and name-constrained to `lab.localhost` and its subdomains, so it cannot vouch for any other site.

- **Chromium, Chrome, Brave (Linux):** `certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n lab-ca -i .local/ca.crt`, or Settings → Privacy and security → Security → Manage certificates → Authorities → Import.
- **Firefox:** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import, then tick "Trust this CA to identify websites".
- **System-wide (curl, most CLIs; Arch-based):** `sudo trust anchor .local/ca.crt`. On Debian or Ubuntu: copy it to `/usr/local/share/ca-certificates/lab-ca.crt` and run `sudo update-ca-certificates`.
- **One-off:** `curl --cacert .local/ca.crt https://home.lab.localhost/`.
- **Inside the cluster:** ConfigMap `lab-ca`, key `ca.crt`, in namespaces `home`, `storage`, `todo`, `pdf`, `auth`, `loadgen` and `traefik`.

## How it fits together

- **Ingress:** Traefik v3.7 (Helm chart pinned in `config/versions.env`) runs on the control-plane node behind a NodePort Service: 30080 and 30443, with `externalTrafficPolicy: Local`. kind maps host `127.0.0.1:80` and `127.0.0.1:443` to those ports.
  - HTTP redirects to HTTPS, and the entry points ignore client `X-Forwarded-*` headers.
  - `websecure` has no read or write timeout and no body limit.
  - Traefik rejects `%2F`, `%5C` and `%00` in paths, and drops header aliases such as `Remote_User`.
  - Access logs are JSON without the request path or headers.
  - Metrics are served on port 9100 (ServiceMonitor), and traces go over OTLP to Alloy.
- **TLS:** cert-manager's ClusterIssuer `lab-ca` signs `*.${DOMAIN}` and `${DOMAIN}`, and Traefik uses that certificate as its default (`traefik/lab-wildcard-tls`).
- **Identity:** Authelia 4.39 (`platform/auth/`):
  - SQLite on the host volume `auth-data`, with argon2id password hashes.
  - The session cookie is scoped to `lab.localhost`: HttpOnly, Secure, SameSite=Lax.
  - The filesystem notifier writes to `${DATA_DIR}/auth/notification.txt`.
  - Default policy is deny.
  - Middlewares `auth-strip-identity@kubernetescrd` and `auth-sso-chain@kubernetescrd`. Apps read `Remote-User`, `Remote-Groups`, `Remote-Email` and `Remote-Name`.
  - Sessions live in memory, so restarting Authelia signs everyone out.
- **Databases:** CloudNativePG operator in `cnpg-system`. Each app owns its `Cluster`. `platform/smoke/db.yaml` is a complete example that follows the contract: Cluster, backup CronJob, claim and NetworkPolicies.
- **Network:** every app namespace denies ingress by default and allows only what it needs. kindnet enforces NetworkPolicy, and `make smoke` proves it every run.
- **Pod Security:** `home`, `storage`, `todo`, `auth`, `traefik`, `loadgen` and `cnpg-system` enforce `restricted`. `pdf` enforces `baseline`; `platform/stirling-pdf/README.md` explains why.
- **Stirling PDF:** see `platform/stirling-pdf/README.md` for its API, limits and metrics.

## Data and backups

Data that must survive a rebuild lives on the host under `DATA_DIR` (default `.local/data`), which is mounted at `/data` in every kind node:

| Path | What |
|---|---|
| `storage/` | uploaded files (volume `storage-data`) |
| `backups/storage/`, `backups/todo/` | nightly `pg_dump` files (`<app>-YYYYmmddTHHMMSSZ.dump`, newest 7 kept) |
| `auth/` | Authelia's SQLite database (TOTP and WebAuthn registrations, bans) and `notification.txt` |
| `smoke/` | marker file written by `make smoke` (safe to delete) |

`make down` and `make up` keep all of this. `make smoke` proves it: a marker written through a PVC by an earlier cluster is still there after the rebuild. The PostgreSQL data directories live on kind's local-path storage and are rebuilt empty, which is why the dumps exist.

- `make backup` runs every `<app>-db-backup` CronJob now and waits (`APPS="todo"` to limit).
- `make restore` restores the newest dump of each app:
  1. scales every Deployment in the app's namespace to 0;
  2. runs `pg_restore --clean --if-exists --no-owner --single-transaction` in a Job built from the CronJob's pod template;
  3. scales the Deployments back.

  `DUMP=<file>` picks a specific dump. `pg_restore --clean` drops only objects that are in the dump: rows come back exactly, but tables created after the dump stay.
- A full rebuild with data: `make backup && make down CONFIRM=1 && make up && make restore`.

To back up the machine, copy `DATA_DIR` (pods write files there as their own UIDs, so use `sudo cp -a` or `sudo tar`). Also copy these from `.local/`:

- `credentials.env`, `passwords/` and `users.json` (the accounts)
- `authelia/` (session, storage and JWT keys; without `storage_encryption_key`, Authelia cannot read its own database)
- `ca.key` and `ca.crt` (the CA browsers already trust)

## Run it for friends (`remote` profile)

The local profile listens only on `127.0.0.1`. To let friends in, run the same stack on a machine they can reach, with a real domain:

1. **Pick an address.** The easiest is a Tailscale tailnet: invite your friends, then use the machine's Tailscale IP (`tailscale ip -4`). Ports 443 and 80 on that address must be free. On this machine `tailscale serve` already holds `100.82.114.81:443`; stop it or use another address. A public IP also works, but then the whole internet reaches your Authelia login.
2. **DNS:** create the records `lab.example.com` and `*.lab.example.com` pointing at that address.
3. **Configure:** `cp config/remote.env.example config/override.env` and set `DOMAIN`, `LISTEN_ADDRESS`, `ACME_EMAIL`. The example sets `AUTH_POLICY=two_factor` and `CERT_ISSUER=letsencrypt-dns01`.
4. **Certificates:** `platform/cert-manager/letsencrypt-dns01.yaml` issues the wildcard through Let's Encrypt DNS-01, so no inbound port 80 is needed. It is written for Cloudflare; put an API token with `Zone:DNS:Edit` in `.local/dns01-api-token`. For another DNS provider, swap the solver. **This template is unverified.** It needs a real domain and DNS credentials, so it was not tested here. Point it at Let's Encrypt staging first: the file says how.
5. Run `make down CONFIRM=1 && make up`. The host port mappings are fixed when the cluster is created, so a running cluster has to be recreated.
6. **Two-factor:** each user signs in, then registers TOTP or a passkey. Authelia verifies identity with a one-time code. The filesystem notifier writes that code to `${DATA_DIR}/auth/notification.txt`; read it there and pass it on. For email delivery, replace `notifier.filesystem` in `platform/auth/configuration.yml` with an SMTP notifier.

With a real CA, users don't need `.local/ca.crt`. The `ci` profile (`PROFILE=ci`) uses `cluster/kind-ci.yaml`, a single node, for GitHub Actions.

## Files

| Path | What |
|---|---|
| `config/local.env`, `config/versions.env` | settings and pins; `config/override.env` (untracked) overrides both |
| `cluster/kind.yaml`, `cluster/kind-ci.yaml` | kind cluster templates |
| `scripts/lib.sh` | config loading, `render` (envsubst with the `RENDER_VARS` allowlist), `k`/`h` wrappers, wait helpers |
| `scripts/up.sh`, `down.sh`, `status.sh`, `creds.sh`, `tools.sh`, `secrets.sh` | lifecycle |
| `scripts/users.sh` | SSO users |
| `scripts/deploy-app.sh` | build and deploy one app |
| `scripts/backup.sh`, `scripts/restore.sh` | database dumps |
| `scripts/smoke.sh` | security and platform checks (`ONLY=sso,netpol,...`, `KEEP=1`) |
| `platform/namespaces/` | namespaces with Pod Security labels |
| `platform/storage/` | StorageClass `lab-host` and the static host volumes |
| `platform/dns/` | CoreDNS rewrite block |
| `platform/cert-manager/` | chart values, issuers, remote DNS-01 template |
| `platform/traefik/` | chart values and NetworkPolicy |
| `platform/auth/` | Authelia config and manifests, identity middlewares |
| `platform/cnpg/` | operator chart values |
| `platform/stirling-pdf/` | Stirling PDF manifests and API notes |
| `platform/smoke/` | fixtures for `make smoke` |
| `services/home/Dockerfile`, `services/home/deploy/` | Home portal image (nginx, strict CSP, `GET /api/me`) and manifests |
