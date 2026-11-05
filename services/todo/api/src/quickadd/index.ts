/** Dependency-free parser and calendar arithmetic shared with the web app. Weekdays use JS numbering: Sunday=0. */
export type Rule = {
  kind: "days" | "weeks" | "months" | "years" | "weekdays" | "weekly";
  interval: number;
  days?: number[];
  day?: number;
  from: "due" | "completion";
};
export function localParts(date: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}
export function localInstant(
  p: ReturnType<typeof localParts>,
  tz: string,
): Date {
  const wanted = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  let ms = wanted;
  for (let i = 0; i < 4; i++) {
    const q = localParts(new Date(ms), tz);
    const diff =
      wanted - Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
    if (!diff) break;
    ms += diff;
  }
  return new Date(ms);
}
export function dayKey(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function nextOccurrence(
  rule: Rule,
  due: Date,
  completion: Date,
  tz: string,
): Date {
  const p = localParts(rule.from === "completion" ? completion : due, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  const original = p.day;
  if (rule.kind === "months" || rule.kind === "years") {
    d.setUTCDate(1);
    if (rule.kind === "months") d.setUTCMonth(d.getUTCMonth() + rule.interval);
    else d.setUTCFullYear(d.getUTCFullYear() + rule.interval);
    const last = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(rule.day ?? original, last));
  } else if (rule.kind === "weekdays" || rule.kind === "weekly") {
    do {
      d.setUTCDate(d.getUTCDate() + 1);
    } while (
      rule.kind === "weekdays"
        ? [0, 6].includes(d.getUTCDay())
        : !rule.days?.includes(d.getUTCDay())
    );
    if (
      rule.kind === "weekly" &&
      rule.interval > 1 &&
      d.getUTCDay() < new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
    )
      d.setUTCDate(d.getUTCDate() + 7 * (rule.interval - 1));
  } else
    d.setUTCDate(
      d.getUTCDate() + rule.interval * (rule.kind === "weeks" ? 7 : 1),
    );
  return localInstant(
    {
      ...p,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    },
    tz,
  );
}
const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
export function parseQuickAdd(
  text: string,
  options: { now?: Date; timezone?: string } = {},
): {
  title: string;
  priority: number;
  project: string | null;
  labels: string[];
  due: string | null;
  dateOnly: boolean;
  recurrence: Rule | null;
} {
  const tz = options.timezone ?? "UTC";
  const now = options.now ?? new Date();
  const p = localParts(now, tz);
  let title = text;
  let priority = 4;
  let project: string | null = null;
  const labels: string[] = [];
  let recurrence: Rule | null = null;
  let date: Date | null = null;
  let hour = 0,
    minute = 0;
  let timed = false;
  title = title.replace(/(?:^|\s)p([1-4])\b/gi, (_, v: string) => {
    priority = Number(v);
    return " ";
  });
  title = title
    .replace(/(?:^|\s)#([^\s]+)/g, (_, v: string) => {
      project = v;
      return " ";
    })
    .replace(/(?:^|\s)@([^\s]+)/g, (_, v: string) => {
      labels.push(v);
      return " ";
    });
  title = title.replace(
    /\bevery\s+(?:(\d+)\s+)?weeks?\s+on\s+((?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:(?:,\s*|\s+and\s+)(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))*)/gi,
    (_, n: string | undefined, days: string) => {
      recurrence = {
        kind: "weekly",
        interval: Number(n ?? 1),
        days: days
          .toLowerCase()
          .split(/,\s*|\s+and\s+/)
          .map((d) => weekdays.indexOf(d)),
        from: "due",
      };
      return " ";
    },
  );
  title = title.replace(
    /\b(daily|weekly|monthly|yearly)\b/gi,
    (_, unit: string) => {
      recurrence = {
        kind:
          unit.toLowerCase() === "daily"
            ? "days"
            : unit.toLowerCase() === "weekly"
              ? "weeks"
              : unit.toLowerCase() === "monthly"
                ? "months"
                : "years",
        interval: 1,
        from: "due",
      };
      return " ";
    },
  );
  title = title.replace(
    /\bevery\s+(?:(\d+)\s+)?(weekdays?|days?|weeks?|months?|years?|sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+on\s+(\d{1,2}))?\b/gi,
    (_, n: string | undefined, u: string, day: string | undefined) => {
      u = u.toLowerCase();
      const index = weekdays.indexOf(u);
      recurrence = {
        kind:
          index >= 0
            ? "weekly"
            : u.startsWith("weekday")
              ? "weekdays"
              : u.startsWith("day")
                ? "days"
                : u.startsWith("week")
                  ? "weeks"
                  : u.startsWith("month")
                    ? "months"
                    : "years",
        interval: Number(n ?? 1),
        from: "due",
        ...(index >= 0 ? { days: [index] } : {}),
        ...(day ? { day: Number(day) } : {}),
      };
      return " ";
    },
  );
  title = title.replace(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi,
    (
      _,
      h: string | undefined,
      m: string | undefined,
      ap: string | undefined,
      h24: string | undefined,
      m24: string | undefined,
    ) => {
      hour = h24
        ? Number(h24)
        : (Number(h) % 12) + (ap?.toLowerCase() === "pm" ? 12 : 0);
      minute = Number(m24 ?? m ?? 0);
      timed = true;
      return " ";
    },
  );
  title = title.replace(
    /\b(today|tomorrow|(?:next\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|\d{4}-\d{2}-\d{2})\b/gi,
    (_, s: string) => {
      s = s.toLowerCase();
      date = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
      if (s === "tomorrow") date.setUTCDate(date.getUTCDate() + 1);
      else if (/^\d{4}/.test(s)) {
        date = new Date(s + "T12:00:00Z");
      } else if (s !== "today") {
        const wd = weekdays.indexOf(s.replace("next ", ""));
        let delta = (wd - date.getUTCDay() + 7) % 7;
        if (!delta || s.startsWith("next ")) delta = delta || 7;
        date.setUTCDate(date.getUTCDate() + delta);
      }
      return " ";
    },
  );
  if (!date && (timed || recurrence))
    date = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  const chosen: Date | null = date;
  return {
    title: title.replace(/\s+/g, " ").trim(),
    priority,
    project,
    labels,
    due: chosen
      ? localInstant(
          {
            ...p,
            year: chosen.getUTCFullYear(),
            month: chosen.getUTCMonth() + 1,
            day: chosen.getUTCDate(),
            hour,
            minute,
            second: 0,
          },
          tz,
        ).toISOString()
      : null,
    dateOnly: !timed,
    recurrence,
  };
}
