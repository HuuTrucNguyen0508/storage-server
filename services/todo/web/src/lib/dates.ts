// Calendar helpers in the user's profile timezone. The arithmetic comes from
// the API's own module so the client and server agree on what "today" is.

import { dayKey, localInstant, localParts } from "../../../api/src/quickadd/index.ts";

export { dayKey, localInstant, localParts };

/** "YYYY-MM-DD" plus n days. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return t.toISOString().slice(0, 10);
}

export function todayKey(tz: string, now = new Date()): string {
  return dayKey(now, tz);
}

/** Splits a stored instant into the local date and time inputs use. */
export function toLocalInputs(iso: string, tz: string): { date: string; time: string } {
  const p = localParts(new Date(iso), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** The instant for a local date (and optional "HH:MM") in tz. Date-only values sit at local midnight, as quick add stores them. */
export function fromLocalInputs(date: string, time: string | null, tz: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time ? (time.split(":").map(Number) as [number, number]) : [0, 0];
  return localInstant({ year: y, month: m, day: d, hour: hh, minute: mm, second: 0 }, tz).toISOString();
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = tz + JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts });
    fmtCache.set(k, f);
  }
  return f;
}

export function timeOf(iso: string, tz: string): string {
  return fmt(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** A day key as words relative to today: Today, Tomorrow, Yesterday, Friday, 3 Nov, 3 Nov 2027. */
export function dayWords(key: string, today: string): string {
  if (key === today) return "Today";
  if (key === addDays(today, 1)) return "Tomorrow";
  if (key === addDays(today, -1)) return "Yesterday";
  const d = new Date(key + "T12:00:00Z");
  if (key > today && key <= addDays(today, 6)) return fmt("UTC", { weekday: "long" }).format(d);
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return fmt("UTC", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** Heading for an Upcoming day: "Today", "Tomorrow", then "Friday 7 November". */
export function dayHeading(key: string, today: string): { title: string; sub: string } {
  const d = new Date(key + "T12:00:00Z");
  const long = fmt("UTC", { weekday: "long", day: "numeric", month: "long" }).format(d);
  if (key === today) return { title: "Today", sub: long };
  if (key === addDays(today, 1)) return { title: "Tomorrow", sub: long };
  return { title: long, sub: "" };
}

export function longDate(key: string): string {
  return fmt("UTC", { weekday: "long", day: "numeric", month: "long" }).format(new Date(key + "T12:00:00Z"));
}

export type DueTone = "overdue" | "today" | "later";

export interface DueInfo {
  key: string;
  text: string;
  tone: DueTone;
  timed: boolean;
}

/** How a due date reads on a row. On the Today view a timed task shows only its time. */
export function dueInfo(due: string, dateOnly: boolean, tz: string, today: string, compactToday = false): DueInfo {
  const key = dayKey(new Date(due), tz);
  const tone: DueTone = key < today ? "overdue" : key === today ? "today" : "later";
  const day = dayWords(key, today);
  const text = dateOnly ? day : compactToday && key === today ? timeOf(due, tz) : `${day}, ${timeOf(due, tz)}`;
  return { key, text, tone, timed: !dateOnly };
}

/** "5 Jun", "5 Jun 2025": for created and completed lines. */
export function shortDate(iso: string, tz: string, now = new Date()): string {
  const d = new Date(iso);
  const sameYear = localParts(d, tz).year === localParts(now, tz).year;
  return fmt(tz, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** Relative time for comments and activity: "just now", "5 min ago", "Yesterday", "3 Nov". */
export function ago(iso: string, tz: string, now = new Date()): string {
  const s = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const today = dayKey(now, tz);
  const key = dayKey(new Date(iso), tz);
  if (key === today) return `Today, ${timeOf(iso, tz)}`;
  if (key === addDays(today, -1)) return `Yesterday, ${timeOf(iso, tz)}`;
  return shortDate(iso, tz, now);
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function allTimezones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = f ? f("timeZone") : [];
  return list.includes("UTC") ? list : ["UTC", ...list];
}
