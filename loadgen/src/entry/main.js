// k6 entry point. One exported function per app (the scenarios in lib/profiles.js name
// them through `exec`), plus a teardown that removes anything the run left behind.
import { buildOptions } from "../lib/profiles.js";
import { sleep } from "k6";
import { LOGIN_MODE, MIN_ITERATION_SECONDS, SELECTED, TESTID, PROFILE } from "../lib/config.js";
import { ensureSignedIn, loginForSession, useSharedSession } from "../lib/http.js";
import { summarize } from "../lib/summary.js";
import * as storage from "../apps/storage.js";
import * as todo from "../apps/todo.js";
import * as pdf from "../apps/pdf.js";
import * as home from "../apps/home.js";
import * as auth from "../apps/auth.js";

const base = buildOptions();
// Every metric carries the run's testid, so Grafana can show one run at a time.
export const options = Object.assign(base, { tags: { testid: TESTID } });

// Every iteration lasts at least MIN_ITERATION_SECONDS, even when it fails at once. Without
// that floor a journey that cannot sign in would retry as fast as the CPU allows (an early
// run sent 600 000 logins in two minutes and OOM-killed Authelia).
function paced(journey) {
  return (data) => {
    useSharedSession(data && data.session);
    const started = Date.now();
    try {
      journey();
    } finally {
      const left = MIN_ITERATION_SECONDS - (Date.now() - started) / 1000;
      if (left > 0) sleep(left);
    }
  };
}

export const storageJourney = paced(storage.journey);
export const todoJourney = paced(todo.journey);
export const pdfJourney = paced(pdf.journey);
export const homeJourney = paced(home.journey);
export const authJourney = paced(auth.journey);

const SWEEPS = { storage: storage.sweep, todo: todo.sweep };

export function teardown(data) {
  useSharedSession(data && data.session);
  ensureSignedIn();
  for (const app of SELECTED) if (SWEEPS[app]) SWEEPS[app]();
}

export function handleSummary(data) {
  return summarize(data);
}

export function setup() {
  console.log(`loadgen: profile=${PROFILE} testid=${TESTID} apps=${SELECTED.join(",")} login=${LOGIN_MODE}`);
  // The auth journey signs in by itself; everything else can share one session.
  return { session: LOGIN_MODE === "shared" ? loginForSession() : "" };
}
