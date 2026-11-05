// Names for the things journeys create (folders, projects, labels), and the rule for what a
// teardown may remove. Runs overlap (the 5-minute synthetic check fires during a load
// test), so a teardown must never touch another live run's items:
//   k6-<created, base 36>-<run tag>-<unique>
// A sweep removes items with its own run tag, and leftovers older than two hours.
import { PREFIX, TESTID } from "./config.js";

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export const RUN_TAG = hash(TESTID);
const STALE_MS = 2 * 3600 * 1000;

export function itemName(unique) {
  return `${PREFIX}${Date.now().toString(36)}-${RUN_TAG}-${unique}`;
}

// Per-VU label name for quick-add (`@label` creates it on first use).
export function labelName() {
  return `${PREFIX}${Date.now().toString(36)}-${RUN_TAG}-l${__VU}`;
}

export function sweepable(name) {
  const m = /^k6-([0-9a-z]+)-([0-9a-z]+)-/.exec(name);
  if (!m) return false;
  return m[2] === RUN_TAG || Date.now() - parseInt(m[1], 36) > STALE_MS;
}
