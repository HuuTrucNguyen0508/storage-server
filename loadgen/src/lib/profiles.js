// Profiles (smoke, load, stress, spike, soak), their per-app scenarios and the thresholds.
//
// A scenario per app, named after the app, so the k6 dashboard's "by scenario" panel is a
// per-app panel. SHARE says how the virtual users split across apps when everything runs
// together; with a single app (APP=storage) all VUS go to that app.
import { APPS, PROFILE, SELECTED, SMOKE } from "./config.js";

const env = (k, d) => (__ENV[k] !== undefined && __ENV[k] !== "" ? __ENV[k] : d);
const num = (k, d) => Number(env(k, d));

export const SHARE = { storage: 7, todo: 6, home: 3, auth: 2, pdf: 2 };
const SHARE_TOTAL = APPS.reduce((n, a) => n + SHARE[a], 0); // 20

// Latency budgets in ms (p95), per `kind` tag; errors under 1 %, checks above 99 %.
// Measured headroom is documented in loadgen/README.md.
export const BUDGET = {
  storage: { api: 400, transfer: 3000, preview: 800, convert: 20000, page: 800, login: 2500 },
  todo: { api: 400, stream: 2000, login: 2500 },
  pdf: { api: 2500, convert: 20000, login: 2500 },
  home: { api: 200, page: 400, login: 2500 },
  auth: { login: 2500, api: 500 },
};

function virtualUsers(app, peak) {
  if (SELECTED.length === 1) return peak;
  return Math.max(1, Math.round((peak * SHARE[app]) / SHARE_TOTAL));
}

function stagesFor(peak) {
  switch (PROFILE) {
    case "load": {
      const minutes = num("LOAD_MINUTES", 10);
      const up = Math.max(0.2, minutes * 0.2);
      return [
        { duration: `${Math.round(up * 60)}s`, target: peak },
        { duration: `${Math.round(minutes * 0.6 * 60)}s`, target: peak },
        { duration: `${Math.round(up * 60)}s`, target: 0 },
      ];
    }
    case "spike": {
      const base = Math.max(1, Math.round(peak * 0.2));
      return [
        { duration: "60s", target: base },
        { duration: "15s", target: peak },
        { duration: "60s", target: peak },
        { duration: "15s", target: base },
        { duration: "60s", target: base },
        { duration: "15s", target: 0 },
      ];
    }
    case "soak":
      return [
        { duration: "60s", target: peak },
        { duration: env("SOAK_DURATION", "1h"), target: peak },
        { duration: "30s", target: 0 },
      ];
    default:
      throw new Error(`no stages for profile ${PROFILE}`);
  }
}

// Steps of the stress ramp. With one app these are VUs of that app; with several they are
// total VUs split by SHARE.
export function stressSteps() {
  return env("STRESS_STEPS", "2,4,8,12,16,24,32,48,64").split(",").map((s) => Number(s.trim()));
}

function stressStages(app) {
  const hold = num("STEP_SECONDS", 50);
  const ramp = num("RAMP_SECONDS", 10);
  const stages = [];
  for (const step of stressSteps()) {
    const target = SELECTED.length === 1 ? step : Math.max(1, Math.round((step * SHARE[app]) / SHARE_TOTAL));
    stages.push({ duration: `${ramp}s`, target }, { duration: `${hold}s`, target });
  }
  stages.push({ duration: "10s", target: 0 });
  return stages;
}

function scenarios() {
  const out = {};
  for (const app of SELECTED) {
    const exec = `${app}Journey`;
    if (SMOKE) {
      out[app] = { executor: "per-vu-iterations", vus: 1, iterations: 1, maxDuration: env("SMOKE_TIMEOUT", "4m"), exec };
      continue;
    }
    const peak = PROFILE === "spike" ? num("VUS", 20) * num("SPIKE_FACTOR", 2) : PROFILE === "soak" ? num("SOAK_VUS", 4) : num("VUS", 20);
    out[app] = {
      executor: "ramping-vus",
      startVUs: 0,
      stages: PROFILE === "stress" ? stressStages(app) : stagesFor(virtualUsers(app, peak)),
      gracefulRampDown: "30s",
      gracefulStop: "60s",
      exec,
    };
  }
  return out;
}

// Latency scale: smoke runs once, so a cold LibreOffice start would trip tight budgets;
// stress and spike exist to cross budgets, so they only fail on gross errors.
function thresholds() {
  const t = {};
  const relaxed = PROFILE === "stress" || PROFILE === "spike";
  const scale = SMOKE ? 3 : relaxed ? 4 : 1;
  for (const app of SELECTED) {
    for (const [kind, ms] of Object.entries(BUDGET[app])) {
      t[`http_req_duration{app:${app},kind:${kind}}`] = [`p(95)<${ms * scale}`];
    }
    // App-wide latency (all kinds), for the summary; the real budgets are per kind above.
    t[`http_req_duration{app:${app}}`] = [`p(95)<${Math.max(...Object.values(BUDGET[app])) * scale}`];
    t[`http_req_failed{app:${app}}`] = [SMOKE ? "rate==0" : relaxed ? { threshold: "rate<0.25", abortOnFail: PROFILE === "stress", delayAbortEval: "30s" } : "rate<0.01"];
    t[`checks{app:${app}}`] = [SMOKE ? "rate==1" : relaxed ? "rate>0.75" : "rate>0.99"];
  }
  return t;
}

export function buildOptions() {
  return {
    scenarios: scenarios(),
    thresholds: thresholds(),
    // Drop `url` (raw IDs and tokens) and other high-cardinality tags from every metric.
    systemTags: ["status", "method", "name", "scenario", "check", "error", "error_code", "expected_response", "group"],
    // Keep the session cookie across iterations (k6 clears the jar by default).
    noCookiesReset: true,
    noConnectionReuse: false,
    discardResponseBodies: false,
    userAgent: "lab-loadgen/1 k6",
    insecureSkipTLSVerify: false,
    summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  };
}
