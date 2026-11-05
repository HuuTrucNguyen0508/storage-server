#!/usr/bin/env node
// Reads one k6 run back out of Prometheus: what k6 measured (k6_* with the run's testid)
// next to what the apps measured themselves, and, for stress runs, one row per step with
// the resource that limits the app.
//
//   loadgen/report.sh <testid> [--app storage] [--steps 2,4,8] [--hold 50] [--ramp 10]
//
// loadgen/report.sh port-forwards Prometheus and calls this with PROM_URL. No dependencies.
const PROM = process.env.PROM_URL || "http://localhost:9090";
const args = process.argv.slice(2);
const testid = args[0];
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
if (!testid || testid.startsWith("--")) {
  console.error("usage: report.mjs <testid> [--app storage] [--steps 2,4,8] [--hold 50] [--ramp 10]");
  process.exit(2);
}
const appOpt = opt("app", "");
const steps = opt("steps", "").split(",").filter(Boolean).map(Number);
const hold = Number(opt("hold", 50));
const ramp = Number(opt("ramp", 10));

const T = `testid="${testid}"`;

async function api(path, params) {
  const url = `${PROM}/api/v1/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  const body = await res.json();
  if (body.status !== "success") throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body.data.result;
}
const instant = async (query, time) => (await api("query", time ? { query, time } : { query })).map((r) => ({ labels: r.metric, v: Number(r.value[1]) }));
const one = async (query, time) => {
  const r = await instant(query, time);
  return r.length ? r[0].v : NaN;
};
async function range(query, start, end, step) {
  const r = await api("query_range", { query, start, end, step });
  return r.map((s) => ({ labels: s.metric, values: s.values.map(([t, v]) => [Number(t), Number(v)]) }));
}
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const ms = (s) => (Number.isFinite(s) ? (s * 1000 >= 1000 ? `${(s).toFixed(2)}s` : `${(s * 1000).toFixed(0)}ms`) : "-");
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "-");

// Run window from k6_vus.
const now = Math.floor(Date.now() / 1000);
const vus = await range(`sum(k6_vus{${T}})`, now - 6 * 3600, now, 5);
if (!vus.length || !vus[0].values.length) {
  console.error(`no k6_vus series for testid ${testid} in the last 6 hours`);
  process.exit(1);
}
const startT = vus[0].values[0][0];
const endT = vus[0].values[vus[0].values.length - 1][0];
const dur = endT - startT + 5;
console.log(`testid ${testid}: ${new Date(startT * 1000).toISOString()} to ${new Date(endT * 1000).toISOString()} (${dur}s), peak VUs ${Math.max(...vus[0].values.map((v) => v[1]))}`);

// --- k6's view, per app --------------------------------------------------------------
const inc = (m, extra = "") => `sum by (app) (increase(${m}{${T}${extra}}[${dur + 10}s]))`;
const atEnd = endT + 20;
const reqs = await instant(inc("k6_http_reqs_total"), atEnd);
const bad = await instant(inc("k6_http_reqs_total", ',expected_response="false"'), atEnd);
const badBy = Object.fromEntries(bad.map((r) => [r.labels.app, r.v]));
const p95 = await instant(`max by (app) (max_over_time(k6_http_req_duration_p95{${T},kind=~"api|page|login"}[${dur + 10}s]))`, atEnd);
const p95By = Object.fromEntries(p95.map((r) => [r.labels.app, r.v]));
const p95t = await instant(`max by (app) (max_over_time(k6_http_req_duration_p95{${T},kind=~"transfer|preview|convert"}[${dur + 10}s]))`, atEnd);
const p95tBy = Object.fromEntries(p95t.map((r) => [r.labels.app, r.v]));
console.log("\nk6 (peak of the 5 s p95 windows, so stricter than the run-wide p95 in the k6 summary):");
console.log("app       requests   req/s   errors   p95 api/page/login   p95 transfer/preview/convert");
for (const r of reqs.sort((a, b) => a.labels.app.localeCompare(b.labels.app))) {
  const a = r.labels.app;
  console.log(`${a.padEnd(8)} ${fmt(r.v).padStart(9)} ${fmt(r.v / dur, 1).padStart(7)} ${pct((badBy[a] || 0) / r.v).padStart(8)} ${ms(p95By[a]).padStart(20)} ${ms(p95tBy[a]).padStart(30)}`);
}

// --- the apps' own view over the same window ------------------------------------------
const window = `${dur + 10}s`;
console.log("\nApps' own http_server_request_duration_seconds over the same window:");
console.log("app      requests   req/s   5xx     p95");
for (const ns of ["storage", "todo"]) {
  const sel = `{namespace="${ns}"}`;
  const n = await one(`sum(increase(http_server_request_duration_seconds_count${sel}[${window}]))`, atEnd);
  const e = await one(`sum(increase(http_server_request_duration_seconds_count{namespace="${ns}",status_code=~"5.."}[${window}]))`, atEnd);
  const q = await one(`histogram_quantile(0.95, sum by (le) (increase(http_server_request_duration_seconds_bucket${sel}[${window}])))`, atEnd);
  console.log(`${ns.padEnd(8)} ${fmt(n).padStart(8)} ${fmt(n / dur, 1).padStart(7)} ${pct((e || 0) / n).padStart(7)} ${ms(q).padStart(8)}`);
}
console.log("\nTraefik (every app, including home, auth and pdf, which have no metrics of their own):");
console.log("app      requests   req/s   5xx     p95");
for (const app of ["home", "auth", "storage", "todo", "pdf"]) {
  const svc = `exported_service=~"${app}-.*"`;
  const n = await one(`sum(increase(traefik_service_requests_total{${svc}}[${window}]))`, atEnd);
  const e = await one(`sum(increase(traefik_service_requests_total{${svc},code=~"5.."}[${window}]))`, atEnd);
  const q = await one(`histogram_quantile(0.95, sum by (le) (increase(traefik_service_request_duration_seconds_bucket{${svc}}[${window}])))`, atEnd);
  console.log(`${app.padEnd(8)} ${fmt(n).padStart(8)} ${fmt(n / dur, 1).padStart(7)} ${pct((e || 0) / n).padStart(7)} ${ms(q).padStart(8)}`);
}

// --- stress: one row per step -----------------------------------------------------------
if (steps.length && appOpt) {
  const target = { storage: ["storage", "storage"], todo: ["todo", "api"], pdf: ["pdf", "stirling-pdf"], home: ["home", "home"], auth: ["auth", "authelia"] }[appOpt];
  const [ns, container] = target;
  const dbPod = `${ns}-db-1`;
  console.log(`\nStress steps for ${appOpt} (a step's numbers skip its first ${ramp + 10} s, the ramp and warm-up):`);
  console.log("step  VUs   k6 req/s  k6 err   k6 p95 api  k6 p95 xfer  login p95   app CPU  throttled   app mem   DB CPU  DB conns  SSO CPU  Traefik CPU  k6 CPU");
  for (let i = 0; i < steps.length; i++) {
    const from = startT + i * (ramp + hold) + ramp + 10;
    const to = startT + (i + 1) * (ramp + hold);
    if (to > endT + 5) break;
    const w = `${to - from}s`;
    const q = async (expr) => one(expr, to);
    const rps = await q(`sum(increase(k6_http_reqs_total{${T}}[${w}])) / ${to - from}`);
    const err = await q(`sum(increase(k6_http_reqs_total{${T},expected_response="false"}[${w}])) / sum(increase(k6_http_reqs_total{${T}}[${w}]))`);
    const lat = await q(`max(avg_over_time(k6_http_req_duration_p95{${T},kind=~"api|page"}[${w}]))`);
    const xfer = await q(`max(avg_over_time(k6_http_req_duration_p95{${T},kind=~"transfer|preview|convert"}[${w}]))`);
    const login = await q(`max(avg_over_time(k6_http_req_duration_p95{${T},kind="login"}[${w}]))`);
    const cpu = await q(`sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",container="${container}"}[${w}]))`);
    const thr = await q(`sum(increase(container_cpu_cfs_throttled_periods_total{namespace="${ns}",container="${container}"}[${w}])) / sum(increase(container_cpu_cfs_periods_total{namespace="${ns}",container="${container}"}[${w}]))`);
    const mem = await q(`max(container_memory_working_set_bytes{namespace="${ns}",container="${container}"}) / 1048576`);
    const dbcpu = await q(`sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod="${dbPod}",container="postgres"}[${w}]))`);
    const conns = await q(`sum(cnpg_backends_total{namespace="${ns}"})`);
    const ssocpu = await q(`sum(rate(container_cpu_usage_seconds_total{namespace="auth",container="authelia"}[${w}]))`);
    const tfcpu = await q(`sum(rate(container_cpu_usage_seconds_total{namespace="traefik",container="traefik"}[${w}]))`);
    const k6cpu = await q(`sum(rate(container_cpu_usage_seconds_total{namespace="loadgen",container="k6"}[${w}]))`);
    console.log(
      `${String(i + 1).padStart(4)} ${String(steps[i]).padStart(4)} ${fmt(rps, 1).padStart(10)} ${pct(err).padStart(7)} ${ms(lat).padStart(11)} ${ms(xfer).padStart(12)} ${ms(login).padStart(10)} ${fmt(cpu, 2).padStart(8)} ${pct(thr).padStart(10)} ${(fmt(mem) + "Mi").padStart(9)} ${fmt(dbcpu, 2).padStart(8)} ${fmt(conns).padStart(9)} ${fmt(ssocpu, 2).padStart(8)} ${fmt(tfcpu, 2).padStart(12)} ${fmt(k6cpu, 2).padStart(7)}`,
    );
  }
}
