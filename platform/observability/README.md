# Observability

Metrics, logs, traces, probes and alerts for the whole lab, in namespace `monitoring`.
`make up` installs it at step 8. To install or update it on its own:

```sh
bash platform/observability/install.sh            # PROFILE=local
PROFILE=ci bash platform/observability/install.sh # smaller retention and requests
```

The script is idempotent. A rerun on a converged cluster takes about 20 seconds. Chart versions
are pinned at the top of `install.sh`. The Prometheus Operator CRDs come from `install-crds.sh`
(bring-up step 3). Its CRD chart (32.0.2) matches the operator in kube-prometheus-stack (v0.94.2).

Grafana: `https://grafana.${DOMAIN}/`. Prometheus: `https://prometheus.${DOMAIN}/`.
Alertmanager: `https://alertmanager.${DOMAIN}/`. All three are behind Authelia, and only group
`admins` gets in. Logs and traces contain usernames, so friends don't get Grafana.

## What runs where

| Component | Chart (version) / image | Kind | Service (port) | Storage |
|---|---|---|---|---|
| Prometheus v3.15.1 | kube-prometheus-stack 92.20.0 | StatefulSet `prometheus-kps-prometheus` | `prometheus` (9090), also `kps-prometheus` | PVC 10 GiB, 7 days / 9 GiB |
| Alertmanager | kube-prometheus-stack | StatefulSet `alertmanager-kps-alertmanager` | `alertmanager` (9093) | PVC 1 GiB |
| Prometheus Operator v0.94.2 | kube-prometheus-stack | Deployment `kps-operator` | `kps-operator` (443) | none |
| Grafana 13.3.0 | kube-prometheus-stack (grafana subchart 14.4.0) | Deployment `grafana` | `grafana` (80) | PVC 1 GiB (SQLite: users, stars) |
| kube-state-metrics 2.20.0, node-exporter 1.12.1 | kube-prometheus-stack | Deployment, DaemonSet | | none |
| Loki 3.6.16 | grafana/loki 7.5.0, single binary | StatefulSet `loki` | `loki` (3100) | PVC 10 GiB, 7 days (compactor retention) |
| Tempo 2.9.0 | grafana/tempo 1.24.4, single binary | StatefulSet `tempo` | `tempo` (3200, OTLP 4317/4318) | PVC 10 GiB, 7 days |
| Grafana Alloy v1.21.3 | grafana/alloy 1.15.0 | Deployment `alloy` (1 replica) | `alloy` (4317 gRPC, 4318 HTTP, 12345 UI) | emptyDir |
| blackbox_exporter v0.29.1 | prometheus-blackbox-exporter 11.20.2 | Deployment `blackbox-exporter` | `blackbox-exporter` (9115) | none |
| Alert webhook sink | `python:3.14.8-alpine3.24` + `manifests/alert-sink.py` | Deployment `alert-sink` | `alert-sink` (8080) | none |
| metrics-server v0.9.0 | metrics-server 3.14.0 | Deployment `metrics-server` | APIService `v1beta1.metrics.k8s.io` | none |

The Prometheus PVC is the one that gets big. Its retention stops at 7 days or 9 GiB, whichever
comes first.

### Files

| Path | What it is |
|---|---|
| `install.sh` | Installs everything (namespace, secrets, charts, manifests, rules, dashboards) |
| `install-crds.sh` | Prometheus Operator CRDs (bring-up step 3) |
| `values/*.yaml` | Helm values. Rendered with `scripts/lib.sh render`, so only `${DOMAIN}`-style allowlisted variables change |
| `values/ci/*.yaml` | `PROFILE=ci` overlays: 1 day of retention, 2 GiB volumes, smaller requests |
| `alloy/config.alloy` | The Alloy pipeline: log tailing, events, OTLP, token redaction |
| `manifests/` | Namespace, Services `prometheus` and `alertmanager`, IngressRoutes, NetworkPolicies, Probes, the CNPG PodMonitor, the alert sink |
| `rules/lab.rules.yaml` | Recording rules and alerts (plain Prometheus format, wrapped into PrometheusRule `lab-rules`) |
| `rules/lab.rules.test.yaml`, `rules/test.sh` | promtool unit tests, run in the pinned Prometheus image |
| `dashboards/build.mjs` | Generates every dashboard JSON in `dashboards/<folder>/` |
| `tests/` | Proofs against the live cluster (see [Checks](#checks)) |

## Signal matrix

| Component | Metrics | Logs (Loki) | Traces (Tempo) | Missing, and why |
|---|---|---|---|---|
| Traefik | Per entry point, router and service: requests, durations, bytes, open connections, TLS cert expiry (`traefik_*`, ServiceMonitor from the Traefik chart) | JSON access log with `trace_id`/`TraceId`, `RouterName`, status and duration, plus its own log | Every request (OTLP HTTP to Alloy), W3C context passed to apps | No request paths in access logs: the platform drops `RequestPath` because paths can carry share tokens. Span `url.path` is kept, with the token redacted. |
| Authelia | `authelia_request`, `authelia_request_duration`, `authelia_authz`, `authelia_authn`, `authelia_authn_duration` (port 9959) | JSON logs with `level` | none | Authelia 4.39 exports no traces. Forward-auth calls show as Traefik `AuthRequest` spans. |
| Storage app | Contract HTTP metrics, `storage_*` domain metrics, Go runtime (port 9464) | JSON with `trace_id`, `user`, `route`, `path` (tokens replaced) | OTLP, with database child spans | |
| Todo app | Contract HTTP metrics, `todo_*` domain metrics, Node.js runtime (port 9464) | JSON with `trace_id`, `user` | OTLP, with database child spans | |
| Home portal | Traefik service metrics, probe | nginx logs | Traefik span only | Static nginx, no instrumentation. |
| Stirling PDF 3.2.2 | Traefik service metrics, probe, container CPU, memory and restarts | Logs (plain text, so no `level` label) | Traefik span only | Native Prometheus metrics need a paid licence. Checked on this cluster: `/actuator` lists `health` only, and `/actuator/prometheus` and `/actuator/metrics` return 404. Office conversions the storage app requests show on the Storage dashboard (`storage_office_conversion*`). |
| PostgreSQL (CloudNativePG) | `cnpg_*` from each instance (PodMonitor `monitoring/cnpg-clusters`, port 9187), operator metrics (cnpg-system PodMonitor) | JSON logs (`container="postgres"`) | Apps' `pg.query*` client spans | No server-side traces. |
| Grafana | `grafana_*` | JSON logs | OTLP gRPC to Alloy | |
| Prometheus, Alertmanager, Loki, Tempo, Alloy, operator, kube-state-metrics, node-exporter, CoreDNS, cert-manager, kubelet/cAdvisor, API server | Own metrics via ServiceMonitors | Logs | none | |
| Kubernetes events | | `app="kubernetes-events"` | | |
| kube-controller-manager, kube-scheduler, etcd, kube-proxy | none | Logs | none | kind binds them to 127.0.0.1 inside the node container. Their scrape jobs, dashboards and alerts are off, so they don't raise permanent `*Down` alerts. |
| k6 load tests | `k6_*` via Prometheus remote write, tagged `testid` | Job logs | none | |
| Public URLs | Blackbox probes (`probe_*`, including `probe_ssl_earliest_cert_expiry`) | | | Signed-in user journeys come from the load generator's k6 synthetic CronJob. |

Log labels: `namespace`, `pod`, `container`, `app` (from `app.kubernetes.io/name`, falling back
to `app` and `k8s-app`), `job` (`<namespace>/<container>`), and `level` (`debug|info|warn|error`)
for JSON lines with a `level` key. `trace_id` is stored as structured metadata:
`{app="storage"} | trace_id="..."`.

### Share-token redaction

Alloy rewrites the path segment after `/s/` and `/api/public/` to `{token}` before anything is
stored:

- **Log lines**: `stage.replace` in `loki.process "pods"` and `loki.process "events"`.
- **OTLP**: span, resource and span-event attributes (`url.path`, `url.full`, `http.target`,
  `http.route`, ...), span names, metric data-point attributes, and log bodies and attributes
  (`otelcol.processor.transform "redact"`).

`tests/redaction.sh` proves this on the live cluster. It requests
`https://storage.${DOMAIN}/s/<fake>/file.txt` through Traefik, prints a log line with both kinds
of token, and posts an OTLP span carrying tokens in four attributes. It then asserts that the
token appears nowhere in Loki or Tempo and that `/s/{token}/file.txt` does.

## From a log line to its trace, and back

- **Log line to trace.** In Grafana Explore (Loki), or in any logs panel, expand a line that has
  `trace_id` (apps, Traefik) or `TraceId` (Traefik). The derived field shows **Open trace**, which
  opens the trace in Tempo.
- **Trace to logs.** In a Tempo trace, open a span and choose **Logs for this span**. It runs
  `{namespace=~".+"} |= "<trace id>"` over the span's time window, plus or minus 5 minutes.
- **Trace to metrics.** In the same span menu, choose **Request rate**, **Error rate** or
  **p95 latency**. These query Tempo's span metrics (`traces_spanmetrics_*`) for that service.
- **Metric to trace.** On _Apps / HTTP RED_, _Storage_ (thumbnails) and _Traces_, the latency
  graphs show exemplars as dots. Clicking one opens the trace (exemplar label `trace_id`).
- **Service graph.** The _Traces_ dashboard, or Explore > Tempo > Service Graph. It is built
  from `traces_service_graph_*`.

Verified on this cluster: a todo latency exemplar (`trace_id` 35458dfc...) opened its trace in
Tempo, and the same ID found the todo app's log line in Loki.

## Dashboards

The Grafana sidecar provisions them from ConfigMaps. The folder comes from the directory:

| Folder | Dashboards |
|---|---|
| Lab | Lab overview, Logs explorer, Traces |
| Apps | Apps / HTTP RED, Storage, Todo |
| Platform | Traefik, Authelia, Stirling PDF, PostgreSQL (CloudNativePG) |
| Load tests | Load tests (k6) |
| Kubernetes | The dashboards kube-prometheus-stack ships (cluster, namespace, pod, node, persistent volume, API server, kubelet, CoreDNS, Prometheus, Alertmanager) |

Provisioned dashboards are read-only in the UI. To add or change one:

1. Edit `dashboards/build.mjs`. The helpers `stat`, `timeseries`, `gauge`, `table`,
   `instantTable` and `logs` keep panels consistent. Alternatively, drop an exported JSON file
   into `dashboards/<folder>/`. Set a fixed `uid`, and use datasource UIDs `prometheus`,
   `loki`, `tempo` and `alertmanager`.
2. Run `node platform/observability/dashboards/build.mjs`. It rewrites every JSON file in
   `lab/`, `apps/`, `platform/` and `load-tests/`. Hand-made files belong in a new folder
   directory.
3. Run `bash platform/observability/install.sh`. It creates one ConfigMap per file and deletes
   ConfigMaps whose file is gone.
4. Run `node platform/observability/tests/check-dashboards.mjs`. It runs every Prometheus and
   Loki query against the live stack, through port-forwards on 19090 and 13100.

### Load tests (k6)

Run k6 with `--out experimental-prometheus-rw` against
`http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write`, and tag each run with
`--tag testid=<name>`. k6 v2.3 sends only `k6_http_req_duration_p99` unless you set
`K6_PROMETHEUS_RW_TREND_STATS`. Checked on this cluster: the dashboard needs
`K6_PROMETHEUS_RW_TREND_STATS=p(50),p(90),p(95),p(99),avg,max`. Durations arrive in seconds.
Names seen: `k6_vus`, `k6_http_reqs_total`, `k6_http_req_failed_rate`, `k6_checks_rate`,
`k6_iterations_total`, `k6_data_sent_total`, `k6_data_received_total`, and
`k6_http_req_{duration,waiting,connecting,tls_handshaking,sending,receiving,blocked}_<stat>`.

Pods in namespace `loadgen` may reach Prometheus port 9090 (NetworkPolicy `prometheus`).

## Alerts

Rules live in `rules/lab.rules.yaml`. Every alert goes to the webhook sink, which logs each
notification as JSON. Find them with
`{namespace="monitoring", app="alert-sink"} | json | msg="alert"`. `Watchdog` (always firing)
and `InfoInhibitor` go to the `null` receiver. The values file has a commented email receiver
example.

| Alert | Fires when | For | Severity |
|---|---|---|---|
| `LabAppDown` | A blackbox probe fails (an SSO URL doesn't redirect to Authelia, or `auth` isn't 200) | 2m | critical |
| `LabAppHigh5xxRatio` | Over 5% of an app's requests at Traefik are 5xx, at 1 request a minute or more | 5m | warning |
| `LabAppHighLatency` | p95 of an app's own `http_server_request_duration_seconds` is over 1s. Streaming and transfer routes are excluded (`events`, `stream`, `upload`, `download`, `chunk`, `content`, `raw`, `thumbnail`, `preview`, `sse`, `live`) | 10m | warning |
| `LabAppHighLatencyTraefik` | p95 at Traefik is over 1s for home, auth, prometheus or alertmanager. Stirling PDF is excluded because conversions are slow by design. Grafana is excluded because its live websocket counts as one long request. | 10m | warning |
| `LabSLOErrorBudgetBurnFast` | Storage or todo burn their 99.5% availability budget at 14.4x (1h and 5m windows) or 6x (6h and 30m) | | critical |
| `LabSLOErrorBudgetBurnSlow` | 3x (1d and 2h windows) or 1x (3d and 6h) | | warning |
| `LabPodCrashLooping` | A container is in CrashLoopBackOff (replaces the chart's `KubePodCrashLooping`) | 5m | warning |
| `LabPersistentVolumeClaimAlmostFull` | A PVC is over 85% used (kubelet volume stats) | 5m | warning |
| `LabHostVolumeAlmostFull` | The host filesystem behind the nodes' `/var` (every PVC) or `/data` (`DATA_DIR`) is over 85% full. This is kind's stand-in for the rule above: local-path and hostPath volumes report no kubelet volume stats. | 5m | warning |
| `LabStorageVolumeLowFreeSpace` | `storage_volume_free_bytes / storage_volume_size_bytes` is below 10% | 5m | warning |
| `LabCNPGInstanceDown` | A CNPG instance reports PostgreSQL down, can't be scraped, or isn't Ready | 2m | critical |
| `LabCertificateExpiringSoon` | A probed URL's certificate expires in under 14 days | 10m | warning |
| `LabCertManagerCertificateExpiringSoon` | Any cert-manager Certificate expires in under 14 days | 10m | warning |
| `LabLokiIngestionErrors` | Loki discards samples or answers pushes with 5xx | 10m | warning |
| `LabAlloyLogSendErrors` | Alloy drops log entries on the way to Loki | 10m | warning |
| `LabTempoIngestionErrors` | Tempo discards spans, or Alloy fails to export them | 10m | warning |
| `LabPrometheusIngestionErrors` | Remote write fails, samples are rejected as out of order, or nothing is appended | 10m | warning |
| `LabRemoteWriteReceiveErrors` | The remote-write receiver answers with 5xx | 10m | warning |

The chart's default Kubernetes, node, Prometheus and Alertmanager rules stay on. The exceptions
are the components kind can't expose, `NodeMemoryMajorPagesFaults` (noisy on a shared laptop
kernel), and `KubePodCrashLooping`.

To unit test the rules, run `bash platform/observability/rules/test.sh`. It runs
`promtool check rules` and `promtool test rules` in `quay.io/prometheus/prometheus:v3.15.1`.

## Network policies

`manifests/networkpolicies.yaml` denies all ingress by default. It then allows:

- Traefik pods to Grafana (3000), Prometheus (9090) and Alertmanager (9093).
- OTLP (4317, 4318) into Alloy from every namespace.
- Namespace `loadgen` to Prometheus (9090) for k6 remote write.
- Prometheus to scrape everything in the namespace.
- Grafana to query Prometheus, Loki, Tempo and Alertmanager.
- Alloy to push to Loki and Tempo and to remote-write to Prometheus.
- Tempo to remote-write to Prometheus.
- Alertmanager to call the sink.
- Any source to reach the operator's webhook port and metrics-server (10250). The API server
  calls them from the node network.

Other namespaces that Prometheus scrapes must allow the Prometheus pods
(`app.kubernetes.io/name=prometheus` in `monitoring`) on their metrics port. For CNPG instances
that is port 9187. Blackbox probes go through Traefik, which accepts traffic from anywhere.

Because of these policies, the API server's service proxy (`kubectl get --raw
/api/v1/namespaces/monitoring/services/...`) can't reach the stack. Use `kubectl port-forward`.

## Resource use

Measured on the local profile with `kubectl top pods -n monitoring`, about 30 minutes after
install, with the storage and todo apps running:

| Pod | Memory |
|---|---|
| prometheus | 636 MiB |
| grafana (3 containers) | 616 MiB |
| tempo | 291 MiB |
| loki | 259 MiB |
| alloy | 196 MiB |
| others (operator, Alertmanager, kube-state-metrics, blackbox, 3 node-exporters, metrics-server, sink) | about 290 MiB |
| **total** | **about 2.3 GiB** |

The memory requests add up to about 2.4 GiB, and CPU idles below 0.1 core. The `ci` profile cuts
retention to 1 day and volumes to 2 GiB each.

## Checks

Run these from the repo root against the live cluster:

| Command | Proves |
|---|---|
| `bash platform/observability/rules/test.sh` | Rule syntax and unit tests (promtool) |
| `bash platform/observability/tests/redaction.sh` | Share tokens never reach Loki or Tempo |
| `bash platform/observability/tests/alert-delivery.sh` | An alert posted to Alertmanager reaches the sink and Loki |
| `bash platform/observability/tests/netpol.sh` | The monitoring NetworkPolicies allow and block what they should |
| `node platform/observability/tests/check-dashboards.mjs` | Every dashboard query is valid. Reports which panels have data. Needs port-forwards: `kubectl -n monitoring port-forward svc/kps-prometheus 19090:9090` and `svc/loki 13100:3100` |
| `cd platform/observability/tests/ui && pnpm install && pnpm check` | Headless Chromium through Authelia: admin reaches Grafana as Grafana Admin with no Grafana login form, and alice gets 403. Screenshots go to `.local/observability/screenshots/` |

## Known limits

- **Alloy tails pod logs through the Kubernetes API** (`loki.source.kubernetes`), not from node
  files. This needs no hostPath and runs non-root on a read-only root filesystem. When pods
  churn, a new pod's first lines can take 10 to 30 seconds to arrive (client-side API
  throttling). Lines a pod writes in the seconds before it is deleted can be lost. On a busier
  cluster, switch to a DaemonSet with `loki.source.file` on `/var/log/pods`.
- **Grafana roles.** The auth proxy can't map `Remote-Groups` to roles (team sync is Enterprise).
  Everyone who arrives gets the org role Admin, and only admins can arrive. Authelia's `admin`
  user matches Grafana's built-in `admin` login, so it is also the Grafana server admin. Friends
  added with `scripts/users.sh add ... --admin` become org Admins, not server admins.
- **The grafana/tempo single-binary chart is deprecated upstream** in favour of
  tempo-distributed. 1.24.4 with Tempo 2.9.0 works. Move to tempo-distributed, or to Tempo's own
  manifests, when the chart stops getting releases.
- **node-exporter in kind reports the host** (all nodes share the host kernel and disks), so
  host CPU and memory gauges average the three identical series.
