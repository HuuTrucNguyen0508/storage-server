# Lab platform

One single-node k3s cluster on this machine that hosts Home, Storage, Todo, Stirling PDF and the observability stack. Authelia handles sign-in for all of them, Traefik serves them over HTTPS, and app data lives on the host. `docs/architecture.md` is the contract. This file covers how to run the platform.

## Bring it up

You need Linux with systemd, `sudo`, Docker (it builds the app images), `helm`, `jq`, `envsubst`, `openssl` and `curl`. `make up` downloads a pinned `kubectl` into `.local/bin/` and the pinned k3s binary and its `install.sh` into `.local/k3s/`, and checks their checksums. It ignores any `kubectl` already on your `PATH`.

`make up` installs k3s system-wide: the binary at `/usr/local/bin/k3s`, its config at `/etc/rancher/k3s/config.yaml` (from `cluster/k3s.yaml`), and systemd unit `k3s`, which starts on boot. That needs `sudo`. Step 1 uses `sudo` only when k3s must change (another version, a changed config, a stopped service) or `.local/kubeconfig` must be rewritten. Steps 9 and 10, like every `make deploy-<app>`, first look for each app image in the node's image list (no `sudo`) and run `sudo k3s ctr` only when the node doesn't list it: to check containerd itself and import the image. A rebuilt image always needs `sudo`, and sudo asks again whenever its cached credential has expired (5 minutes by default), so a first install can ask twice. `make up` owns this machine's k3s: don't run it where k3s already serves something else.

```sh
make up        # install or converge k3s and everything on it
make creds     # URLs and every login
make status    # nodes, Helm releases, unhealthy pods, volumes, routes, certificates
make smoke     # security checks against the running cluster (about 2 minutes)
make down CONFIRM=1   # dump the databases, then uninstall k3s from this machine; .local/ and the data directory stay
```

`make up` is idempotent: rerun it after a failure or a change. It runs these steps:

1. Install or converge the k3s server (one node in every profile). If the old kind cluster still runs, it stops and points to "Migration from kind".
2. Add the CoreDNS rewrite (ConfigMap `kube-system/coredns-custom`) so `*.${DOMAIN}` resolves to Traefik inside the cluster.
3. Install the Prometheus Operator CRDs.
4. Install cert-manager and issue the wildcard certificate.
5. Install Traefik.
6. Create the host-backed volumes and install Authelia with the users.
7. Install the CloudNativePG operator. `.local/cluster-ready` is written after this step.
8. Install the observability stack.
9. Deploy Stirling PDF and Home.
10. Deploy every `services/<app>` that has a `Dockerfile` and `deploy/kustomization.yaml`.

Set `SKIP_APPS=1` to skip step 10. If step 8 or an app fails, the remaining steps still run, and `make up` exits non-zero at the end.

`kubectl` setup: `export KUBECONFIG=$PWD/.local/kubeconfig`. `make up` copies k3s's root-only admin kubeconfig (`/etc/rancher/k3s/k3s.yaml`) there with context `k3s-lab`, and also adds that context to `~/.kube/config`. k3s's own `kubectl`, `crictl` and `ctr` symlinks aren't created, so the `kubectl` on your `PATH` stays yours.

Deploy a single app with `make deploy-<app>`. It builds `services/<app>/Dockerfile` from the repo root and tags the image `lab/<app>:<16 hex chars of the image ID>`, so the tag is immutable. It then imports the image into k3s's containerd unless the node already lists that tag (`sudo k3s ctr images import`, so a new image asks for your password), renders `kubectl kustomize services/<app>/deploy` with `IMAGE_TAG` set, applies it and waits for the rollout. This machine has no `docker buildx`, so the legacy builder runs: no `RUN <<EOF` heredocs and no `RUN --mount`.

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

- **Ingress:** Traefik v3.7 (Helm chart pinned in `config/versions.env`) runs behind a NodePort Service on node ports `${HTTP_PORT}` and `${HTTPS_PORT}` (80 and 443), with `externalTrafficPolicy: Local`. kube-proxy serves node ports only on `LISTEN_ADDRESS` (`127.0.0.1` locally). Traefik can't use a hostPort, because namespace `traefik` enforces Pod Security `restricted`; host networking would bypass the NetworkPolicies that admit app traffic only from Traefik pods.
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
- **Network:** every app namespace denies ingress by default and allows only what it needs. k3s's embedded kube-router controller enforces NetworkPolicy, and `make smoke` proves it every run.
- **Pod Security:** `home`, `storage`, `todo`, `auth`, `traefik`, `loadgen` and `cnpg-system` enforce `restricted`. `pdf` enforces `baseline`; `platform/stirling-pdf/README.md` explains why.
- **Stirling PDF:** see `platform/stirling-pdf/README.md` for its API, limits and metrics.

## Data and backups

Data that must survive a rebuild lives on the host under `DATA_DIR` (default `.local/data`). `DATA_DIR` must not sit inside `/var/lib/rancher`, `/var/lib/kubelet`, `/run/k3s`, `/etc/rancher` or `/var/lib/cni`, because `make down` deletes those; the scripts refuse such a path.

For a new install, set `DATA_DIR` in `config/override.env` to a directory outside the checkout, for example `DATA_DIR=/srv/lab-data` or a path on a second disk. The default `.local/data` sits inside the git checkout. Deleting the checkout, or running `git clean -fdx` (which also removes ignored files), deletes every uploaded file, every dump and Authelia's database with it. Moving the data of an existing install is not automated.

The host-backed volumes point at these directories directly:

| Path | What |
|---|---|
| `storage/` | uploaded files (volume `storage-data`) |
| `backups/storage/`, `backups/todo/` | nightly `pg_dump` files (`<app>-YYYYmmddTHHMMSSZ.dump`, newest 7 kept) |
| `auth/` | Authelia's SQLite database (TOTP and WebAuthn registrations, bans) and `notification.txt` |
| `smoke/` | marker file written by `make smoke` (safe to delete) |

`make down` and `make up` keep all of this. `make smoke` proves it: a marker written through a PVC by an earlier cluster is still there after the rebuild. The PostgreSQL data directories live on k3s's local-path storage (`/var/lib/rancher/k3s/storage`), which `make down` deletes, so they come back empty. That is why the dumps exist.

- `make backup` runs every `<app>-db-backup` CronJob now and waits (`APPS="todo"` to limit).
- `make restore` restores the newest dump of each app:
  1. scales every Deployment in the app's namespace to 0;
  2. runs `pg_restore --clean --if-exists --no-owner --single-transaction` in a Job built from the CronJob's pod template;
  3. scales the Deployments back.

  `DUMP=<file>` picks a specific dump. `pg_restore --clean` drops only objects that are in the dump: rows come back exactly, but tables created after the dump stay.
- `make down` runs `make backup` before it uninstalls k3s. It refuses when the cluster is not running (start it with `sudo systemctl start k3s`) or a dump fails, and prints the newest dump of each app. `SKIP_BACKUP=1` uninstalls anyway and loses every change since those dumps.
- A full rebuild with data: `make down CONFIRM=1 && make up && make restore`.

### Off-disk backups

Everything above is on one disk. `make offsite` copies it to a [restic](https://restic.net) repository somewhere else:

- `DATA_DIR`: uploaded files, the dumps, Authelia's database;
- `.local/` without what `make up` regenerates (`bin/`, `k3s/`, `kubeconfig`, `cluster-ready`). This keeps the accounts (`credentials.env`, `passwords/`, `users.json`), Authelia's keys (`authelia/`; without `storage_encryption_key`, Authelia cannot read its own database) and the CA browsers already trust (`ca.key`, `ca.crt`). When `DATA_DIR` is inside `.local/`, it is copied once, as part of `.local/`;
- `config/override.env`.

When the cluster is running, `make offsite` runs `make backup` first. When it is not, it copies the existing dumps and names the newest one of each app. Then it keeps 7 daily, 4 weekly and 6 monthly snapshots (tag `lab-offsite`) and prunes the rest.

Set it up once:

1. Install restic: `sudo pacman -S restic` on Arch and CachyOS.
2. In `config/override.env`, set `RESTIC_REPOSITORY` to a path on a second disk (`RESTIC_REPOSITORY=/mnt/backup/lab`) or to a remote restic backend (`sftp:`, `rest:`, `s3:`, `b2:`, `rclone:`; put the backend's credentials in the same file). A repository on the same disk does not count: it dies with that disk. `make offsite` refuses a path inside the checkout, `DATA_DIR` or `.local/`, and warns when the path is on the same device as `DATA_DIR`.
3. Run `make offsite`. The first run creates the repository and generates its password in `.local/restic-password` (`RESTIC_PASSWORD_FILE` overrides the path). **Copy that password off the machine now**, for example into a password manager. It sits on the same disk as the data, and nobody can open the backup without it.
4. Run `make offsite-timer`. It installs and enables the systemd user units `lab-offsite.service` and `lab-offsite.timer`: every night at 03:30 UTC, after the 03:00 UTC dumps. `Persistent=true` runs a missed backup when the machine comes back on. User timers run only while you are logged in, unless you run `sudo loginctl enable-linger $USER`. Read the logs with `journalctl --user -u lab-offsite.service`.

The storage app writes its files as UID 65532 into directories with mode 700 (`DATA_DIR/storage/blobs/` and its siblings), which your user cannot read. restic then saves an incomplete snapshot and lists the paths it could not read. `make offsite` exits with code 3 and skips the retention policy, so incomplete snapshots never push out complete ones. Until restic can read those directories, the off-disk copy does not contain the uploaded files.

To restore from the off-disk copy, for example onto a new disk:

1. Clone the repository. Do not run `make up` yet: it would generate new secrets and a new CA.
2. Install restic and restore a snapshot into an empty directory. restic stores absolute paths, so the files land under the paths they had when the snapshot was taken. Run it with `sudo`, so the files keep the owners the pods need:

   ```sh
   restic -r /mnt/backup/lab --password-file ~/restic-password snapshots --tag lab-offsite  # pick one; latest is the newest
   sudo restic -r /mnt/backup/lab --password-file ~/restic-password restore latest --target /var/tmp/lab-restore
   ```

3. Copy the files into place. `old` is the checkout path in the snapshot:

   ```sh
   old=/var/tmp/lab-restore/home/you/storage-server
   sudo cp -a "$old/.local/." .local/                   # secrets, and DATA_DIR when it was .local/data
   sudo cp -a "$old/config/override.env" config/
   # DATA_DIR outside .local/: sudo cp -a /var/tmp/lab-restore/<old DATA_DIR>/. "<DATA_DIR>/"
   ```

4. Run `make up`, then `make restore`. `make restore` loads the newest dump of each app from `DATA_DIR/backups/<app>/` into its new database. Put the restic password in `.local/restic-password` (mode 600) before the next `make offsite`.

## Run it for friends (`remote` profile)

The local profile listens only on `127.0.0.1`. To let friends in, run the same stack on a machine they can reach, with a real domain:

1. **Pick an address.** The easiest is a Tailscale tailnet: invite your friends, then use the machine's Tailscale IP (`tailscale ip -4`). Ports 443 and 80 on that address must be free: kube-proxy takes them over, so a program already listening there stops getting traffic. If `tailscale serve` already holds port 443 on that address, stop it or use another address. A public IP also works, but then the whole internet reaches your Authelia login.
2. **DNS:** create the records `lab.example.com` and `*.lab.example.com` pointing at that address.
3. **Configure:** `cp config/remote.env.example config/override.env` and set `DOMAIN`, `LISTEN_ADDRESS`, `ACME_EMAIL`. The example sets `AUTH_POLICY=two_factor` and `CERT_ISSUER=letsencrypt-dns01`.
4. **Certificates:** `platform/cert-manager/letsencrypt-dns01.yaml` issues the wildcard through Let's Encrypt DNS-01, so no inbound port 80 is needed. It is written for Cloudflare; put an API token with `Zone:DNS:Edit` in `.local/dns01-api-token`. For another DNS provider, swap the solver. **This template is unverified.** It needs a real domain and DNS credentials, so it was not tested here. Point it at Let's Encrypt staging first: the file says how.
5. Run `make up`. It writes the new address into k3s's config (`nodeport-addresses`) and restarts k3s; the cluster doesn't have to be rebuilt. Firewall TCP ports 6443 and 10250 if the address is reachable by people you don't trust (see "Security on the server").
6. **Two-factor:** each user signs in, then registers TOTP or a passkey. Authelia verifies identity with a one-time code. The filesystem notifier writes that code to `${DATA_DIR}/auth/notification.txt`; read it there and pass it on. For email delivery, replace `notifier.filesystem` in `platform/auth/configuration.yml` with an SMTP notifier.

With a real CA, users don't need `.local/ca.crt`. The `ci` profile (`PROFILE=ci`) is the local profile with smaller retention, for GitHub Actions; `make up` installs k3s on the runner the same way.

## Security on the server

- k3s listens on every interface, not only on `LISTEN_ADDRESS`: the API server on TCP 6443 and the kubelet on TCP 10250. Both require TLS client certificates or tokens. On a network you don't trust (a shared LAN, a public IP), firewall them so only this machine reaches them. flannel uses the `host-gw` backend (`cluster/k3s.yaml`), so k3s's default VXLAN port (UDP 8472, no authentication) is not open.
- The server forwards packets for the pod and service networks (10.42.0.0/16, 10.43.0.0/16). A machine on the same LAN that adds a route to them through the server reaches Traefik directly, without going through `LISTEN_ADDRESS`; the NetworkPolicies still keep it away from the apps, Authelia and the databases. Firewall forwarded traffic from the LAN if that matters on your network.
- Pods are routable from the host, and kube-router admits traffic that comes from the node itself (that is how kubelet probes work). So any process on the server can reach app pods directly, skip Traefik, and send forged `Remote-*` headers. Don't give untrusted people a shell on the server. (Under kind, the pod network sat inside Docker, so this is new.)
- `make down` runs k3s's uninstaller, which also runs `tailscale set --advertise-routes=` when Tailscale is installed: it clears routes this machine advertises to the tailnet. Advertise them again afterwards if you use them.
- node-exporter runs in the pod network (`hostNetwork: false`), so its unauthenticated host metrics are not served on port 9100 of the host's interfaces.

## Migration from kind

Earlier versions ran the platform on a kind cluster. If that cluster still exists, `make up` stops and prints these steps, because the kind cluster holds host ports 80 and 443:

1. With the previous checkout (from before the move to k3s), run `make backup`. Check that new dumps are in `DATA_DIR/backups/storage/` and `DATA_DIR/backups/todo/`.
2. Delete the kind cluster with the `kind` binary still in `.local/bin/`: `.local/bin/kind delete cluster --name lab`. This deletes the PostgreSQL volumes. The dumps, uploaded files, Authelia data, credentials and CA stay in `DATA_DIR` and `.local/`.
3. Update the checkout.
4. Run `make up`. It asks for your sudo password to install k3s.
5. Run `make restore`.

Browsers that trust `.local/ca.crt` keep trusting it: the CA is the same.

## Files

| Path | What |
|---|---|
| `config/local.env`, `config/versions.env` | settings and pins; `config/override.env` (untracked) overrides both |
| `cluster/k3s.yaml` | k3s server config template, rendered to `.local/k3s-config.yaml` and installed as `/etc/rancher/k3s/config.yaml` |
| `scripts/lib.sh` | config loading, `render` (envsubst with the `RENDER_VARS` allowlist), `k`/`h` wrappers, wait helpers |
| `scripts/up.sh`, `down.sh`, `status.sh`, `creds.sh`, `tools.sh`, `secrets.sh` | lifecycle |
| `scripts/k3s.sh` | `make up` step 1: install or converge k3s, write `.local/kubeconfig`; stops while the old kind cluster exists |
| `scripts/users.sh` | SSO users |
| `scripts/deploy-app.sh` | build and deploy one app |
| `scripts/backup.sh`, `scripts/restore.sh` | database dumps |
| `scripts/offsite.sh`, `scripts/offsite-timer.sh` | off-disk copy with restic, and its nightly systemd user timer (`--print` shows the units) |
| `scripts/smoke.sh` | security and platform checks (`ONLY=sso,netpol,...`, `KEEP=1`) |
| `platform/namespaces/` | namespaces with Pod Security labels |
| `platform/storage/` | StorageClass `lab-host` and the static host volumes |
| `platform/dns/` | CoreDNS rewrite block, applied as ConfigMap `kube-system/coredns-custom` |
| `platform/cert-manager/` | chart values, issuers, remote DNS-01 template |
| `platform/traefik/` | chart values and NetworkPolicy |
| `platform/auth/` | Authelia config and manifests, identity middlewares |
| `platform/cnpg/` | operator chart values |
| `platform/stirling-pdf/` | Stirling PDF manifests and API notes |
| `platform/smoke/` | fixtures for `make smoke` |
| `services/home/Dockerfile`, `services/home/deploy/` | Home portal image (nginx, strict CSP, `GET /api/me`) and manifests |
