// handleSummary: a table for humans and one JSON line for Loki (key names follow the
// platform's log contract: time, level, msg, service).
import { PROFILE, SELECTED, TESTID } from "./config.js";

const ms = (v) => (v === undefined || v === null ? "-" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`);
const val = (m, k) => (m && m.values ? m.values[k] : undefined);

export function summarize(data) {
  const m = data.metrics;
  const seconds = (data.state && data.state.testRunDurationMs ? data.state.testRunDurationMs : 0) / 1000;
  const apps = {};
  for (const app of SELECTED) {
    const dur = m[`http_req_duration{app:${app}}`];
    const failed = m[`http_req_failed{app:${app}}`];
    const checks = m[`checks{app:${app}}`];
    const reqs = val(m[`http_req_failed{app:${app}}`], "passes") + val(m[`http_req_failed{app:${app}}`], "fails");
    apps[app] = {
      requests: reqs || 0,
      rps: seconds ? round((reqs || 0) / seconds) : 0,
      p50_ms: round(val(dur, "med")),
      p95_ms: round(val(dur, "p(95)")),
      p99_ms: round(val(dur, "p(99)")),
      max_ms: round(val(dur, "max")),
      error_rate: round(val(failed, "rate"), 4),
      checks: (val(checks, "passes") || 0) + (val(checks, "fails") || 0),
      checks_rate: round(val(checks, "rate"), 4),
      checks_failed: val(checks, "fails") || 0,
    };
  }
  const thresholdFailures = [];
  for (const [name, metric] of Object.entries(m)) {
    for (const [expr, ok] of Object.entries(metric.thresholds || {})) if (!ok) thresholdFailures.push(`${name} ${expr}`);
  }
  const failedChecks = [];
  const walk = (g) => {
    for (const c of g.checks || []) if (c.fails > 0) failedChecks.push({ check: c.name, fails: c.fails, passes: c.passes });
    for (const sub of g.groups || []) walk(sub);
  };
  if (data.root_group) walk(data.root_group);

  const result = {
    testid: TESTID,
    profile: PROFILE,
    duration_s: round(seconds, 1),
    vus_max: val(m.vus_max, "max"),
    iterations: val(m.iterations, "count"),
    requests: val(m.http_reqs, "count"),
    data_received_mb: round((val(m.data_received, "count") || 0) / 1e6, 1),
    data_sent_mb: round((val(m.data_sent, "count") || 0) / 1e6, 1),
    logins: val(m.loadgen_logins, "count") || 0,
    relogins: val(m.loadgen_relogins, "count") || 0,
    login_retries_429: val(m.loadgen_login_retries, "count") || 0,
    apps,
    threshold_failures: thresholdFailures,
    failed_checks: failedChecks,
    passed: thresholdFailures.length === 0,
  };

  const rows = SELECTED.map((a) => {
    const s = apps[a];
    return `${a.padEnd(8)} ${String(s.requests).padStart(7)} ${String(s.rps).padStart(7)} ${ms(s.p50_ms).padStart(8)} ${ms(s.p95_ms).padStart(8)} ${ms(s.p99_ms).padStart(8)} ${ms(s.max_ms).padStart(8)} ${(s.error_rate * 100).toFixed(2).padStart(7)}% ${(s.checks_rate * 100).toFixed(2).padStart(7)}%`;
  });
  const table = [
    "",
    `testid=${TESTID} profile=${PROFILE} duration=${result.duration_s}s vus_max=${result.vus_max} iterations=${result.iterations} requests=${result.requests}`,
    "app       reqs     rps      p50      p95      p99      max   errors   checks",
    ...rows,
    thresholdFailures.length ? `THRESHOLDS FAILED:\n  ${thresholdFailures.join("\n  ")}` : "all thresholds passed",
    failedChecks.length ? `FAILED CHECKS:\n  ${failedChecks.map((c) => `${c.check} (${c.fails} of ${c.fails + c.passes})`).join("\n  ")}` : "all checks passed",
    "",
  ].join("\n");
  const line = JSON.stringify({ time: new Date().toISOString(), level: result.passed ? "info" : "error", msg: "k6 summary", service: "loadgen", ...result });
  return { stdout: `${table}\n${line}\n`, ...(__ENV.SUMMARY_FILE ? { [__ENV.SUMMARY_FILE]: JSON.stringify(result, null, 2) } : {}) };
}

function round(v, d = 0) {
  if (v === undefined || v === null || Number.isNaN(v)) return 0;
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}
