// Recurrence rules as people say them, and the editor's model of a rule.

import type { Recurrence } from "../api/types";

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

const UNIT: Record<"days" | "weeks" | "months" | "years", [string, string]> = {
  days: ["Daily", "days"],
  weeks: ["Weekly", "weeks"],
  months: ["Monthly", "months"],
  years: ["Yearly", "years"],
};

/** "Daily", "Every 2 weeks", "Monthly on the 5th", "Every Mon, Wed and Fri", "Every weekday". */
export function describeRecurrence(r: Recurrence): string {
  let s: string;
  const n = r.interval || 1;
  if (r.kind === "weekdays") s = "Every weekday";
  else if (r.kind === "weekly") {
    const days = [...(r.days ?? [])].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d]!);
    const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}` : (days[0] ?? "");
    s = n === 1 ? `Every ${list}` : `Every ${n} weeks on ${list}`;
  } else {
    const [one, many] = UNIT[r.kind];
    s = n === 1 ? one : `Every ${n} ${many}`;
    if (r.kind === "months" && r.day) s += ` on the ${ordinal(r.day)}`;
  }
  if (r.from === "completion") s += ", counted from completion";
  return s;
}

/** Short form for a task row. */
export function shortRecurrence(r: Recurrence): string {
  const n = r.interval || 1;
  if (r.kind === "weekdays") return "Weekdays";
  if (r.kind === "weekly") return n === 1 ? (r.days ?? []).map((d) => WEEKDAY_SHORT[d]).join(", ") : `Every ${n} weeks`;
  const [one, many] = UNIT[r.kind];
  return n === 1 ? one : `Every ${n} ${many}`;
}

/** The editor picks one of these presets, then fine-tunes. */
export type Preset = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly" | "custom";

export function presetOf(r: Recurrence | null): Preset {
  if (!r) return "none";
  if (r.interval !== 1) return "custom";
  if (r.kind === "days") return "daily";
  if (r.kind === "weekdays") return "weekdays";
  if (r.kind === "weekly" || r.kind === "weeks") return "weekly";
  if (r.kind === "months") return "monthly";
  return "yearly";
}

/**
 * The rule a preset means for a task due on `dueWeekday` / `dueDay` (local).
 * Weekly keeps the weekdays already chosen; monthly pins the day of the month.
 */
export function ruleForPreset(p: Preset, prev: Recurrence | null, dueWeekday: number, dueDay: number): Recurrence | null {
  const from = prev?.from ?? "due";
  switch (p) {
    case "none":
      return null;
    case "daily":
      return { kind: "days", interval: 1, from };
    case "weekdays":
      return { kind: "weekdays", interval: 1, from };
    case "weekly":
      return { kind: "weekly", interval: 1, days: prev?.kind === "weekly" && prev.days?.length ? prev.days : [dueWeekday], from };
    case "monthly":
      return { kind: "months", interval: 1, day: prev?.kind === "months" && prev.day ? prev.day : dueDay, from };
    case "yearly":
      return { kind: "years", interval: 1, from };
    case "custom":
      return prev && prev.interval !== 1 ? prev : { kind: "days", interval: 2, from };
  }
}

/** Checks a rule the way the API's schema does; returns the problem in words, or null. */
export function recurrenceProblem(r: Recurrence | null): string | null {
  if (!r) return null;
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 999) return "Repeat every 1 to 999.";
  if (r.kind === "weekly" && !r.days?.length) return "Pick at least one day of the week.";
  if (r.day !== undefined && (r.day < 1 || r.day > 31)) return "Pick a day of the month from 1 to 31.";
  return null;
}
