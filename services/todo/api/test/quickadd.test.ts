import { describe, it, expect } from "vitest";
import {
  parseQuickAdd,
  nextOccurrence,
  dayKey,
} from "../src/quickadd/index.js";
const now = new Date("2026-03-27T12:00:00Z");
describe("quick add", () => {
  it.each([
    ["today", "2026-03-27"],
    ["tomorrow", "2026-03-28"],
    ["monday", "2026-03-30"],
    ["next friday", "2026-04-03"],
    ["2026-12-25", "2026-12-25"],
  ])("parses %s", (token, date) => {
    const r = parseQuickAdd("Task " + token, { now, timezone: "Europe/Paris" });
    expect(dayKey(new Date(r.due ?? ""), "Europe/Paris")).toBe(date);
    expect(r.title).toBe("Task");
  });
  it("extracts the complete example", () => {
    expect(
      parseQuickAdd("Pay rent tomorrow 9am p1 #Home @bills every month", {
        now,
        timezone: "Europe/Paris",
      }),
    ).toEqual({
      title: "Pay rent",
      priority: 1,
      project: "Home",
      labels: ["bills"],
      due: "2026-03-28T08:00:00.000Z",
      dateOnly: false,
      recurrence: { kind: "months", interval: 1, from: "due" },
    });
  });
  it.each([
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["9pm", "21:00"],
    ["14:35", "14:35"],
  ])("parses %s", (s, t) =>
    expect(parseQuickAdd("x today " + s, { now }).due).toContain(t),
  );
  it.each(["days", "weeks", "months", "years"])("parses interval %s", (kind) =>
    expect(
      parseQuickAdd(`task every 3 ${kind}`, { now }).recurrence,
    ).toMatchObject({ kind, interval: 3 }),
  );
  it("parses weekdays and specific day", () => {
    expect(parseQuickAdd("x every weekdays", { now }).recurrence?.kind).toBe(
      "weekdays",
    );
    expect(parseQuickAdd("x every monday", { now }).recurrence?.days).toEqual([
      1,
    ]);
  });
  it("crosses DST without shifting wall time", () => {
    expect(
      nextOccurrence(
        { kind: "days", interval: 1, from: "due" },
        new Date("2026-03-28T08:00:00Z"),
        now,
        "Europe/Paris",
      ).toISOString(),
    ).toBe("2026-03-29T07:00:00.000Z");
  });
  it("clamps monthly day and yearly leap day", () => {
    expect(
      nextOccurrence(
        { kind: "months", interval: 1, from: "due" },
        new Date("2026-01-31T09:00Z"),
        now,
        "UTC",
      ).toISOString(),
    ).toBe("2026-02-28T09:00:00.000Z");
    expect(
      nextOccurrence(
        { kind: "years", interval: 1, from: "due" },
        new Date("2024-02-29T09:00Z"),
        now,
        "UTC",
      ).toISOString(),
    ).toBe("2025-02-28T09:00:00.000Z");
  });
  it("supports completion-relative and chosen weekdays", () => {
    expect(
      nextOccurrence(
        { kind: "days", interval: 2, from: "completion" },
        new Date("2020-01-01"),
        now,
        "UTC",
      ).toISOString(),
    ).toBe("2026-03-29T12:00:00.000Z");
    expect(
      nextOccurrence(
        { kind: "weekly", interval: 1, days: [1, 3], from: "due" },
        now,
        now,
        "UTC",
      ).getUTCDay(),
    ).toBe(1);
  });
});
it("uses the local day near UTC midnight and multiple labels", () => {
  const result = parseQuickAdd("Read today 9am @books @home", {
    now: new Date("2026-01-01T01:00:00Z"),
    timezone: "America/Los_Angeles",
  });
  expect(result.due).toBe("2025-12-31T17:00:00.000Z");
  expect(result.labels).toEqual(["books", "home"]);
});
it("keeps local time across autumn DST and weekend recurrence", () => {
  expect(
    nextOccurrence(
      { kind: "days", interval: 1, from: "due" },
      new Date("2026-10-24T07:00Z"),
      now,
      "Europe/Paris",
    ).toISOString(),
  ).toBe("2026-10-25T08:00:00.000Z");
  expect(
    nextOccurrence(
      { kind: "weekdays", interval: 1, from: "due" },
      now,
      now,
      "UTC",
    ).toISOString(),
  ).toBe("2026-03-30T12:00:00.000Z");
});
it("parses a chosen weekday set and common recurrence shorthand", () => {
  expect(
    parseQuickAdd("Gym every 2 weeks on monday,wednesday and friday", { now })
      .recurrence,
  ).toEqual({ kind: "weekly", interval: 2, days: [1, 3, 5], from: "due" });
  expect(parseQuickAdd("Read daily", { now }).recurrence?.kind).toBe("days");
});
it("waits the full interval when a weekly rule returns to the same weekday", () => {
  expect(
    nextOccurrence(
      { kind: "weekly", interval: 2, days: [1], from: "due" },
      new Date("2026-03-02T09:00Z"),
      now,
      "UTC",
    ).toISOString(),
  ).toBe("2026-03-16T09:00:00.000Z");
});
