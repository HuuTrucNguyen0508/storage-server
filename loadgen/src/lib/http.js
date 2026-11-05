import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { DOMAIN, LOGIN_MODE, LOGIN_STAGGER, LOGIN_TRIES, RELOGIN_JITTER, URLS, USER, PASSWORD } from "./config.js";
import { json } from "./util.js";

// Any 2xx or 3xx counts as success for http_req_failed. A request that is supposed to
// return something else says so with `expect` (see call()).
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }));

export const logins = new Counter("loadgen_logins");
export const relogins = new Counter("loadgen_relogins");
export const loginRetries = new Counter("loadgen_login_retries");

// Per VU: true once this VU's cookie jar holds an Authelia session.
let signedIn = false;
// The cookie value setup() obtained, in LOGIN_MODE=shared.
let sharedSession = "";
let staggered = false;

export function useSharedSession(value) {
  sharedSession = value || "";
}

// One firstfactor POST, retried while Traefik's login limiter answers 429 (a random 0.2 to
// 2 s apart, up to LOGIN_TRIES times). 429 is an expected answer, not a failure; running
// out of tries is.
function postFirstFactor(jar) {
  let res;
  for (let attempt = 1; attempt <= LOGIN_TRIES; attempt++) {
    const params = {
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", Accept: "application/json" },
      tags: { app: "auth", name: "POST /api/firstfactor", kind: "login" },
      redirects: 0,
      responseCallback: http.expectedStatuses(200, 429),
    };
    if (jar) params.jar = jar;
    res = http.post(`${URLS.auth}/api/firstfactor`, JSON.stringify({ username: USER, password: PASSWORD, keepMeLoggedIn: false }), params);
    if (res.status !== 429) return res;
    loginRetries.add(1);
    sleep(0.2 + Math.random() * 1.8);
  }
  return res;
}

// Signs in as the run's user and returns the session cookie value (for setup()).
export function loginForSession() {
  const jar = new http.CookieJar();
  const res = postFirstFactor(jar);
  const ok = check(res, { "login: 200 and status OK": (r) => r.status === 200 && json(r) && json(r).status === "OK" }, { app: "auth" });
  if (!ok) throw new Error(`setup login failed with status ${res.status}; check LOADGEN_USER and LOADGEN_PASSWORD, and that Authelia is up`);
  logins.add(1);
  const cookies = jar.cookiesForURL(URLS.auth);
  return cookies.authelia_session && cookies.authelia_session[0];
}

// POST https://auth.${DOMAIN}/api/firstfactor, once per VU. The session cookie lands in the
// VU's cookie jar (Domain=${DOMAIN}) and goes to every app host after that.
export function login(why) {
  const res = postFirstFactor();
  const body = json(res);
  signedIn = check(res, { "login: 200 and status OK": (r) => r.status === 200 && body && body.status === "OK" }, { app: "auth" });
  if (signedIn) (why === "expired" ? relogins : logins).add(1);
  return signedIn;
}

const READ = { GET: 1, HEAD: 1, OPTIONS: 1 };

export function signOut() {
  http.post(`${URLS.auth}/api/logout`, "{}", {
    headers: { "X-Requested-With": "fetch", "Content-Type": "application/json" },
    tags: { app: "auth", name: "POST /api/logout", kind: "login" },
    redirects: 0,
  });
  signedIn = false;
}

export function ensureSignedIn() {
  if (!signedIn && LOGIN_MODE === "shared" && sharedSession) {
    http.cookieJar().set(URLS.auth, "authelia_session", sharedSession, { domain: DOMAIN, path: "/" });
    signedIn = true;
  }
  if (!signedIn && LOGIN_STAGGER > 0 && !staggered) {
    staggered = true;
    sleep(Math.random() * LOGIN_STAGGER); // VUs start together; their first logins should not
  }
  if (!signedIn && !login()) throw new Error("login failed; check LOADGEN_USER and LOADGEN_PASSWORD");
}

// A response that says the session is gone: Authelia answers 302 (browsers), 303 (writes)
// or 401 (no Accept header) before the app sees the request.
function sessionLost(res) {
  if (res.status === 401) return true; // the apps never answer 401 to a signed-in user
  if (res.status === 302 || res.status === 303) return String(res.headers.Location || "").startsWith(URLS.auth);
  return false;
}

/**
 * One HTTP call, tagged for the metrics.
 *
 * call(app, method, path, opts)
 *   name   route template for the `name` tag (never an ID or token). Default: "METHOD path".
 *   kind   `kind` tag: api (default), transfer, preview, convert, stream, login, page.
 *   json   body sent as JSON.
 *   body / contentType   raw body (ArrayBuffer, string) and its Content-Type.
 *   headers  extra headers.
 *   expect   statuses that count as success, for example [404] or [{min:200,max:299}].
 *   guest    true for a public (no-account) call: uses jar, never signs in or re-signs in.
 *   jar      cookie jar for guest calls.
 *   binary   true to receive the body as bytes; none: true to discard it.
 *   timeout  k6 duration string.
 */
export function call(app, method, path, o = {}) {
  if (!o.guest) ensureSignedIn();
  const params = {
    headers: Object.assign({ Accept: o.binary || o.none ? "*/*" : "application/json" }, o.headers),
    tags: { app, name: o.name || `${method} ${path.split("?")[0]}`, kind: o.kind || "api" },
    redirects: 0,
  };
  if (!READ[method]) params.headers["X-Requested-With"] = "fetch";
  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    params.headers["Content-Type"] = "application/json";
  } else if (o.contentType) {
    params.headers["Content-Type"] = o.contentType;
  }
  if (o.binary) params.responseType = "binary";
  if (o.none) params.responseType = "none";
  if (o.timeout) params.timeout = o.timeout;
  if (o.jar) params.jar = o.jar;
  if (o.expect) params.responseCallback = http.expectedStatuses(...o.expect);
  const url = URLS[app] + path;
  let res = http.request(method, url, body, params);
  if (!o.guest && sessionLost(res)) {
    // Spread the re-logins: after an Authelia restart every VU loses its session at once,
    // and each password check costs Authelia about 200 MiB.
    if (__ENV.DEBUG) console.log(`LOST ${method} ${path} -> ${res.status} loc=${res.headers.Location} body=${String(res.body).slice(0,80)} cookies=${JSON.stringify(Object.keys(http.cookieJar().cookiesForURL(URLS.auth)))}`);
    sleep(Math.random() * RELOGIN_JITTER);
    if (login("expired")) res = http.request(method, url, body, params);
  }
  return res;
}

export const get = (app, path, o) => call(app, "GET", path, o);
export const post = (app, path, o) => call(app, "POST", path, o);
export const put = (app, path, o) => call(app, "PUT", path, o);
export const patch = (app, path, o) => call(app, "PATCH", path, o);
export const del = (app, path, o) => call(app, "DELETE", path, o);

// check() with the app tag, so thresholds like `checks{app:storage}` work.
export function verify(app, res, checks) {
  return check(res, checks, { app });
}

export function newGuestJar() {
  return new http.CookieJar();
}
