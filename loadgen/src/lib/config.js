// Environment and constants shared by every journey. All values come from k6 environment
// variables (`k6 run -e NAME=value` or the Job's env), so the same scripts run on a laptop
// and in the cluster.
export const DOMAIN = __ENV.DOMAIN || "lab.localhost";
export const SCHEME = __ENV.SCHEME || "https";

export const APPS = ["storage", "todo", "pdf", "home", "auth"];

// Base URL of each app, keyed by the `app` tag value.
export const URLS = Object.fromEntries(APPS.map((a) => [a, `${SCHEME}://${a}.${DOMAIN}`]));

export const USER = __ENV.LOADGEN_USER || "loadgen";
export const PASSWORD = __ENV.LOADGEN_PASSWORD || "";

export const PROFILE = __ENV.PROFILE || "smoke";
// Every metric carries this tag so dashboards can pick one run (`testid=~"$testid"`).
export const TESTID = __ENV.TESTID || `${PROFILE}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;

// Which apps this run exercises: "all" or a comma list such as "storage,todo".
export const SELECTED = (() => {
  const raw = (__ENV.APP || "all").trim();
  if (raw === "all" || raw === "") return APPS.slice();
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of list) if (!APPS.includes(a)) throw new Error(`unknown app "${a}"; expected one of ${APPS.join(", ")}`);
  return list;
})();

// Think time between user actions is scaled by THINK (seconds multiplier). Smoke runs
// have none; the other profiles default to 1.
export const THINK = Number(__ENV.THINK !== undefined ? __ENV.THINK : PROFILE === "smoke" ? 0 : 1);
export const SMOKE = PROFILE === "smoke";

// File sizes for the storage journey. MEDIUM is the large upload in MiB (default 1 to 3).
export const MEDIUM_MIN_MIB = Number(__ENV.MEDIUM_MIN_MIB || 1);
export const MEDIUM_MAX_MIB = Number(__ENV.MEDIUM_MAX_MIB || 3);
// Bytes per PUT when uploading the medium file, so it takes several chunks.
export const CHUNK_BYTES = Number(__ENV.CHUNK_BYTES || 1024 * 1024);

// Prefix of everything the journeys create. Teardown only touches names with this prefix.
export const PREFIX = "k6-";

// Optional share of iterations that include the slow Office preview (LibreOffice through
// Stirling PDF). Smoke always runs it once.
export const OFFICE_SHARE = Number(__ENV.OFFICE_SHARE !== undefined ? __ENV.OFFICE_SHARE : 0.1);

// No iteration is shorter than this (seconds). Smoke has no floor.
export const MIN_ITERATION_SECONDS = Number(__ENV.MIN_ITERATION_SECONDS !== undefined ? __ENV.MIN_ITERATION_SECONDS : SMOKE ? 0 : 1);

// How virtual users get a session. "per-vu" (default): each VU signs in itself, once, and
// keeps the cookie. "shared": the run signs in once in setup() and every VU reuses that
// cookie (one login per run; useful when Authelia is the thing under test or is struggling).
export const LOGIN_MODE = __ENV.LOGIN_MODE || "per-vu";
// Seconds over which VUs spread their first login, and their re-login after losing the
// session, so logins do not all land at once. Traefik admits 6 concurrent logins and
// answers the rest 429; login() retries those.
export const LOGIN_STAGGER = Number(__ENV.LOGIN_STAGGER !== undefined ? __ENV.LOGIN_STAGGER : SMOKE ? 0 : 4);
export const RELOGIN_JITTER = Number(__ENV.RELOGIN_JITTER || 10);
// 429 retries per login, each after a random 0.2 to 2 s.
export const LOGIN_TRIES = Number(__ENV.LOGIN_TRIES || 10);
