// Home journey: the portal page with its static assets, then who-am-I.
import http from "k6/http";
import { get, verify, ensureSignedIn } from "../lib/http.js";
import { json, think } from "../lib/util.js";
import { URLS, USER } from "../lib/config.js";

const APP = "home";
const ASSETS = ["/ui/tokens.css", "/ui/base.css", "/home.css", "/home.js", "/favicon.svg"];

export function journey() {
  ensureSignedIn();
  const page = get(APP, "/", { name: "GET /", kind: "page" });
  verify(APP, page, { "portal: page 200": (r) => r.status === 200 && String(r.body).includes("<title>Lab</title>") });
  const batch = http.batch(ASSETS.map((a) => ({
    method: "GET",
    url: URLS[APP] + a,
    params: { tags: { app: APP, name: `GET ${a}`, kind: "page" }, redirects: 0, responseType: "text" },
  })));
  verify(APP, batch[0], { "portal: assets load": () => batch.every((r) => r.status === 200) });
  const me = get(APP, "/api/me", { name: "GET /api/me" });
  verify(APP, me, { "me: signed-in user": () => me.status === 200 && json(me) && json(me).user === USER });
  think();
}
