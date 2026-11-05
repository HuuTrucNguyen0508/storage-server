// Auth journey: the sign-in rate. Each iteration signs in from scratch, checks the session
// state, signs out. Only right passwords: wrong ones count toward Authelia's regulation and
// would lock the loadgen account for everyone.
import { get, login, signOut, verify } from "../lib/http.js";
import { json, think } from "../lib/util.js";
import { sleep } from "k6";

const APP = "auth";

export function journey() {
  if (!login()) {
    sleep(5); // never retry in a tight loop; a failing login is the most expensive request
    return;
  }
  const state = get(APP, "/api/state", { name: "GET /api/state", guest: true });
  verify(APP, state, { "state: authenticated": (r) => r.status === 200 && json(r) && json(r).data && json(r).data.authentication_level >= 1 });
  const info = get(APP, "/api/user/info", { name: "GET /api/user/info", guest: true });
  verify(APP, info, { "user info: 200": (r) => r.status === 200 });
  signOut();
  think(1.5, 3.5);
}
