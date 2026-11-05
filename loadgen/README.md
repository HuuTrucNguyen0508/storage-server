# Load generator and synthetic checks

k6 (v2.3) scripts that sign in as the `loadgen` user and drive every app the way a person would: storage, todo, Stirling PDF, the home portal and the Authelia login. They run inside the cluster as Kubernetes Jobs in namespace `loadgen`, verify TLS against the lab CA, and write their metrics to Prometheus (remote write), so Grafana shows them next to the apps' own metrics. A CronJob runs one pass of every journey every 5 minutes, so the dashboards always have authenticated traffic and a broken journey raises an alert.

```sh
make load-smoke                          # one pass of every app, about 15 s
make load-load                           # 20 VUs for 10 minutes, mixed across apps
loadgen/run.sh stress storage            # ramp one app until it breaks
loadgen/run.sh load todo                 # one app only
loadgen/report.sh <testid>               # read a run back out of Prometheus
```

`run.sh` prints the Job's log, ends with a table and one JSON line (`"msg":"k6 summary"`, also in Loki), and exits with k6's exit code: `0` passed, `99` a threshold failed, `107` the script itself failed (for example the login did not work).

## Layout

| Path | What |
|---|---|
| `src/entry/main.js` | k6 entry point: scenarios per app, teardown, summary |
| `src/lib/` | `config` (env), `http` (login, tagging, request helper), `profiles` (profiles and thresholds), `data`, `names`, `summary`, `util` |
| `src/apps/` | one journey per app: `storage`, `todo`, `pdf`, `home`, `auth` |
| `fixtures/` | small PDFs, a docx, a PNG and a Markdown file, written by `fixtures/generate.mjs` (no third-party documents; rerun it to regenerate the same bytes) |
| `deploy/` | kustomize: script ConfigMaps, the `synthetic-checks` CronJob, alert rules, a default-deny NetworkPolicy, a ServiceAccount without a token |
| `install.sh` | applies `deploy/` and creates the credentials Secret from `.local/credentials.env` (idempotent; `--delete` removes it all) |
| `run.sh` | creates a Job from the CronJob's pod template, follows its log, exits with k6's code |
| `report.sh`, `report.mjs` | per-app numbers and per-step stress table, read from Prometheus |
| `screenshots.mjs` | headless Playwright screenshots of the k6 and Apps HTTP RED dashboards through the real ingress, signed in as `admin` |
| `test-rules.sh` | promtool unit tests of the alert rules |

How a run is wired: the scripts and fixtures are ConfigMaps generated from `src/` and `fixtures/` (`kubectl kustomize --load-restrictor LoadRestrictionsNone`, because they sit outside `deploy/`). The Job's pod uses `grafana/k6:2.3.0` pinned by digest, Pod Security `restricted` (non-root, read-only root filesystem, no capabilities, seccomp `RuntimeDefault`), `SSL_CERT_FILE` pointing at ConfigMap `lab-ca` (TLS verification stays on), and Secret `loadgen-credentials`. Metrics go out with `--out experimental-prometheus-rw` to `http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write` with `K6_PROMETHEUS_RW_TREND_STATS=p(50),p(90),p(95),p(99),avg,max` and `K6_PROMETHEUS_RW_STALE_MARKERS=true`. Every metric has the tag `testid` (default `<profile>-<app>-<UTC time>`; the CronJob uses `synthetic`).

## Profiles

Selected with the first argument of `run.sh` (or `-e PROFILE=` on the host). The second argument (or `APP=storage,todo`) limits the apps. Defaults below; every knob is an environment variable that `run.sh` passes to the Job.

| Profile | Shape | Knobs |
|---|---|---|
| `smoke` | 1 VU, 1 iteration per app, no think time. Every optional step runs (Office preview, ZIP, SPA assets). | `SMOKE_TIMEOUT` (4m) |
| `load` | Ramp to `VUS` over 20 % of `LOAD_MINUTES`, hold 60 %, ramp down 20 %. VUs split across apps 7 storage : 6 todo : 3 home : 2 auth : 2 pdf, so 20 in total. With one app, all `VUS` go to it. | `VUS` (20), `LOAD_MINUTES` (10), `THINK` (1), `OFFICE_SHARE` (0.1) |
| `stress` | Steps of `STEP_SECONDS` (50) after a `RAMP_SECONDS` (10) ramp, through `STRESS_STEPS`. Run it one app at a time: `loadgen/run.sh stress storage`. With several apps the step numbers are total VUs, split by the share above. Aborts when more than 25 % of requests fail. | `STRESS_STEPS` (`2,4,8,12,16,24,32,48,64`), `STEP_SECONDS`, `RAMP_SECONDS` |
| `spike` | 20 % of peak for 1 minute, 15 s up to peak (`VUS` x `SPIKE_FACTOR`, 40 by default), 1 minute at peak, back down, 1 minute at base. | `VUS`, `SPIKE_FACTOR` (2) |
| `soak` | `SOAK_VUS` (4) VUs split across the apps, for `SOAK_DURATION` (1h). | `SOAK_VUS`, `SOAK_DURATION` |

Every iteration lasts at least `MIN_ITERATION_SECONDS` (1; 0 in smoke). Without that floor a journey that cannot sign in retries as fast as the CPU allows: an early run sent 600 000 logins in two minutes and OOM-killed Authelia.

## What each journey does

All requests are tagged `app` and `name` (the route template, never an ID or token) plus `kind` (`api`, `transfer`, `preview`, `convert`, `page`, `stream`, `login`). `url` is dropped from the tags, so metric cardinality stays bounded. Mutations send `X-Requested-With: fetch` and JSON or multipart bodies, as the request-forgery rules require.

- **storage**: open the SPA now and then (page and `/assets/`), `GET /api/me`, list the root, create a folder `k6-<time>-<run tag>-<id>`, upload a few KiB of text, a 4 to 64 KiB binary, Markdown, a PNG, a PDF, a 1 to 3 MiB binary in 1 MiB chunks (so the offset protocol runs), and with `OFFICE_SHARE` a docx; list the folder, search by name, download the medium and small file, fetch a thumbnail, an inline range of the PNG, the Markdown and PDF viewer bytes, poll the Office preview until Stirling returns the PDF, now and then download the folder as ZIP. Then create a password-protected link, open it as a guest (separate cookie jar, no account): page, locked answer before the password, unlock with the right password only (wrong ones count toward a 30-per-15-minutes limit per client address, and every pod shares one), thumbnail, download, revoke, and check the link is dead. Finally move the folder to the trash and delete it for good, even when a step failed.
- **todo**: `GET /api/me` and projects, create a project, preview the quick-add parse, quick-add four tasks with inline syntax (`today 9am p1 @label every month`, `tomorrow p2`, `next friday 14:30`, `every weekday`) plus one plain task, list Today, Upcoming, all (sorted by due), search and sections, edit a task with its version, comment and list comments, complete it (and check the next occurrence exists), list completed, hold `GET /api/events` for one second (k6 reports the timeout as status 0; the check looks for the first `resync` event), delete the project.
- **pdf**: Stirling `status`, merge two PDFs, compress the result, PDF to PNG, and with `OFFICE_SHARE` a docx to PDF (LibreOffice, one session, so rare). The pdf scenario is 2 VUs in `load`.
- **home**: portal page and its five static assets, `GET /api/me` (must say `loadgen`).
- **auth**: the login rate. Sign in from scratch, `GET /api/state` and `/api/user/info`, sign out, wait 1.5 to 3.5 s. Right passwords only: wrong ones feed Authelia's regulation and would ban the account.

Every iteration of every app cleans up after itself. After the run, `teardown()` removes leftovers: items are named `k6-<created, base 36>-<run tag>-<id>` and a sweep deletes items with its own run tag and anything older than two hours, never another live run's items (the 5-minute synthetic check overlaps a load test), then empties the trash. Storage usage and todo data are back to zero after each run (proved, see below).

## Login and Authelia

Each VU signs in through `POST https://auth.${DOMAIN}/api/firstfactor` once, keeps the cookie (`noCookiesReset: true`; k6 clears cookies between iterations otherwise) and signs in again only if it loses the session (re-logins are spread over `RELOGIN_JITTER` seconds). First logins are staggered over `LOGIN_STAGGER` seconds (4, none in smoke). Every password check costs Authelia 64 MiB (argon2id), so Traefik admits six concurrent logins and answers `429` to the rest; the helper retries 429 up to `LOGIN_TRIES` (10) times with 0.2 to 2 s of random wait and counts them in `loadgen_login_retries` (the summary line shows `login_retries_429`). `LOGIN_MODE=shared` makes the run sign in once in `setup()` and hands the cookie to every VU, for when Authelia is the thing you want to leave alone.

## Thresholds

A run fails (exit 99) when any of these crosses. They are per app and per `kind` of request, p95 in milliseconds, and live in `src/lib/profiles.js` (`BUDGET`). Smoke multiplies the latency budgets by 3 (one cold pass) and demands zero errors and 100 % checks; `stress` and `spike` multiply them by 4 and only fail on gross errors (more than 25 % failed requests or fewer than 75 % checks).

| App | api | page | transfer | preview | convert | stream | login |
|---|---|---|---|---|---|---|---|
| storage | 400 | 800 | 3000 | 800 | 20000 | | 2500 |
| todo | 400 | | | | | 2000 | 2500 |
| pdf | 2500 | | | | 20000 | | 2500 |
| home | 200 | 400 | | | | | 2500 |
| auth | 500 | | | | | | 2500 |

For every app in `load`, `soak`: `http_req_failed` below 1 % and checks above 99 %. Checks are the correctness assertions in the journeys (status, body shape, byte counts, "revoked link stops working", "a PDF comes back").

## Running from the host

```sh
export SSL_CERT_FILE=$PWD/.local/ca.crt           # the lab CA, TLS verification stays on
source .local/credentials.env
k6 run -e PROFILE=smoke -e LOADGEN_PASSWORD=$LOADGEN_PASSWORD loadgen/src/entry/main.js
# Remote write from the host: kubectl -n monitoring port-forward svc/prometheus 9090:9090, then
K6_PROMETHEUS_RW_SERVER_URL=http://127.0.0.1:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS='p(50),p(90),p(95),p(99),avg,max' \
  k6 run --out experimental-prometheus-rw -e PROFILE=load -e LOAD_MINUTES=2 -e TESTID=host-1 \
  -e LOADGEN_PASSWORD=$LOADGEN_PASSWORD loadgen/src/entry/main.js
```

The host reaches `*.lab.localhost` through systemd-resolved (loopback), the pods through CoreDNS. `DOMAIN` (default `lab.localhost`) and `SCHEME` are variables for the remote profile. A load generator on the same machine competes with the cluster for CPU; the numbers below say how much it used.

## Reading results

- **Grafana** (`https://grafana.lab.localhost`, admins): dashboard *Load tests (k6)*, pick the run in *Test ID*. Panels: VUs and request rate, request duration (p50 to p99), status codes, failure and check rates, p95 by request `name`, requests by scenario (one scenario per app), data rate, connection phases, and below those Traefik's per-app rate and p95. The dashboard *Apps / HTTP RED* shows the same traffic from the apps' own `http_server_request_duration_seconds`.
- Series end with a stale marker when a run ends, so an instant query at "now" returns nothing; use a range query, the dashboard, or `max_over_time(k6_http_reqs_total{testid="x"}[1h])`.
- The tile "p95 duration" is the maximum over all request names, which includes the one-second stream hold on `GET /api/events` (a client-side timeout by design). Look at "p95 by request name" for real routes.
- **`loadgen/report.sh <testid>`** prints per-app requests, request rate, error rate and p95 from k6 beside the apps' own and Traefik's numbers for the same window. For a stress run add `--app storage --steps 2,4,8 --hold 40 --ramp 10` to get one row per step with k6 throughput, error rate and p95, the app's CPU, CPU throttling, memory, the database's CPU and connections, and the k6 pod's own CPU.
- **Logs** in Loki: `{namespace="loadgen"} |= "k6 summary"` (one JSON line per run, with per-app requests, rps, p50, p95, p99, errors and failed checks).
- **Screenshots**: `node loadgen/screenshots.mjs <testid> <from-epoch-s> <to-epoch-s>` writes `.local/loadgen/screenshots/k6-dashboard.png` and `apps-http-red.png`.

## Synthetic checks

CronJob `synthetic-checks` (`*/5 * * * *`, `concurrencyPolicy: Forbid`, history 1 success and 2 failures, `ttlSecondsAfterFinished` 1 h, 4 minute deadline) runs the smoke profile with `testid=synthetic`. Alerts (PrometheusRule `loadgen-synthetic`, routed by Alertmanager to the webhook sink):

- `LabSyntheticJourneyFailed` (warning): a `synthetic-checks-*` Job failed in the last 10 minutes (k6 exits non-zero when any threshold or check fails, or when it cannot sign in). The log of that Job says which journey.
- `LabSyntheticChecksNotSucceeding` (warning): no successful run for 20 minutes.

`loadgen/test-rules.sh` unit-tests both with promtool. To try the alert yourself, create a run that cannot work: `kubectl -n loadgen create job synthetic-checks-broken --from=cronjob/synthetic-checks` with `DOMAIN` set to something that does not exist.

## Capacity numbers (measured on this machine, on kind)

These numbers were measured on the earlier kind cluster, before the platform moved to native single-node k3s. They haven't been re-measured on k3s.

Machine: 24 logical CPUs, 30 GB, kind with one control plane and two workers, the k6 pod limited to 2 CPUs and 1 GiB. All apps run one replica except todo (two). Generator and system under test share the machine.

### Load profile, 10 minutes, 20 VUs, all apps (testid `load-all-20261105172144`)

Run on 2026-11-05 after the last Authelia change. 35 765 requests, 2 621 iterations, 144 MB received, 0 failed checks, 0 failed requests, all thresholds passed.

| App | VUs | Requests | req/s | p50 | p95 | p99 | max | Errors | Checks |
|---|---|---|---|---|---|---|---|---|---|
| storage | 7 | 17 463 | 29 | 3 ms | 31 ms | 71 ms | 1.07 s | 0 % | 100 % |
| todo | 6 | 7 274 | 12 | 7 ms | 440 ms | 2.00 s | 2.00 s | 0 % | 100 % |
| pdf | 2 | 946 | 2 | 7 ms | 19 ms | 107 ms | 802 ms | 0 % | 100 % |
| home | 3 | 8 687 | 14 | 1 ms | 3 ms | 5 ms | 99 ms | 0 % | 100 % |
| auth | 2 | 1 395 | 2 | 1 ms | 319 ms | 335 ms | 454 ms | 0 % | 100 % |

(todo's p95 and p99 come from the live-stream hold, which was two seconds in this run and is one second now; the todo API routes themselves answer in tens of milliseconds. The p50 and p95 of auth are one cheap `GET` per three requests next to a 320 ms argon2 login.)

The same traffic in Prometheus for that window (`loadgen/report.sh load-all-20261105172144`): k6 counted 17 537 storage and 7 299 todo requests; the apps' own `http_server_request_duration_seconds` counted 18 815 and 7 456 (they also see the probes, the synthetic run and health checks) at p95 37 ms and 46 ms; Traefik counted 17 851 storage, 7 090 todo, 8 846 home, 1 457 auth and 972 pdf requests, with 0.00 % 5xx.

### Stress, one app at a time

Steps of 40 s after a 10 s ramp. Where marked, `THINK=0.2` and a shared login put the load on the app instead of on the login. "Knee" is the step where p95 or errors stop being flat or throughput stops growing. Resource numbers are Prometheus averages over the step.

| App | Knee | What happens past it | What limits it |
|---|---|---|---|
| storage (`THINK=0.2`) | 32 to 64 VUs, about 470 to 540 req/s | 96 VUs: 278 req/s, p95 1.2 s; 192 VUs: 196 req/s, p95 1.5 s, errors under 0.3 %: 92 `503 preview_busy` from the Office converter (documented back-pressure) and two `500`s (one folder create, one upload chunk) | Not a pod limit: storage used at most 0.96 of 2 CPUs with no throttling, k6 0.28 of 2. The database connection count sits flat at 25 from the second step (the pool), PostgreSQL used 0.44 to 0.9 CPUs, and the host load average was 17 to 21 on 24 CPUs with 113 MB/s of writes at the peak, so the shared host (disk and CPU of one machine running kind, k6 and the apps) and the pool come first. Not proved which of the two |
| todo (`THINK=0.2`) | 32 VUs, about 196 req/s | 64 VUs: 123 req/s, p95 0.7 s; 192 VUs: p95 2.8 s, no errors; the 1 s stream check starts failing (335 of 2 238) | Database connection pool: the connection count stops at 31, which is 2 pods x `max: 15` plus the LISTEN connection (`services/todo/api/src/app.ts:50`), while todo used 0.2 to 0.6 of 4 CPUs and PostgreSQL about 0.5 |
| pdf, cheap calls (merge, compress, to image) | none up to 32 VUs | 147 req/s, p95 22 ms, Stirling at 1.33 of 4 CPUs, 938 MiB of 4 GiB | nothing yet |
| pdf, docx to PDF | 3 VUs | p95 5.2 s at 3 VUs, 7 s from 4 VUs, flat after (the single LibreOffice session serialises conversions) | Stirling's one LibreOffice session; storage's Office preview shares it |
| home (`THINK=0`) | about 1 400 req/s | 20 to 31 % errors, Traefik restarted | Traefik, not home: home used 0.06 CPU and 6 MiB; Traefik (limit 512 MiB) was OOM-killed at about 2 500 req/s, which briefly took every app down |
| auth | 4 VUs, about 46 req/s = 11 to 12 sign-ins/s | login p95 336 ms rising to 496 ms at 8 VUs; no errors; 59 `429` retries over the run | Authelia's 1 CPU limit (CPU 0.98 to 1.00, throttled 97 to 100 % from 4 VUs). Memory peaked at 624 MiB of 1 GiB |

At the first stress pass (`THINK=1`, up to 48 VUs) storage reached 212 req/s and todo 139 req/s with flat p95 and no errors; the knees above come from the second pass.

Every login also costs one forward-auth call per request at the ingress: Authelia used 0.05 CPU for storage at 470 req/s, so the SSO check is not what limits the apps below 1 CPU.

The k6 pod (2 CPUs) used at most 0.28 CPUs during these runs, so the generator was not the limit except possibly for home. Because it shares the host with the cluster, treat absolute numbers as a floor for a dedicated machine.

## Things that bit while building this

- k6 clears cookies between iterations unless `noCookiesReset: true`.
- `render` (envsubst) must not touch the script ConfigMaps: `${PROFILE}` and `${DOMAIN}` in JavaScript template literals were replaced by the host's values. `install.sh` renders only the CronJob.
- A teardown that sweeps by prefix kills other runs' in-flight items; names now carry a run tag.
- Authelia's argon2id password check takes 64 MiB, so a handful of simultaneous logins killed it at 512 MiB; it has 1 GiB now and Traefik caps concurrent logins.
- The first docx conversion after Stirling has been idle can take anywhere from 2 s to 40 s (LibreOffice restarts); the smoke budget (3 x 20 s) allows it.
- k6 prints a `Request Failed` warning for each deliberate stream timeout; ignore them.
