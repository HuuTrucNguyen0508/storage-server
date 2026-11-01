import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatWhen, plural, untilPhrase } from "./format";

const now = new Date(2026, 10, 1, 15, 0);

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [6 * 1024, "6 KB"],
    [12.3 * 1024 ** 2, "12.3 MB"],
    [184 * 1024 ** 2, "184 MB"],
    [3.8 * 1024 ** 3, "3.8 GB"],
  ])("%d is %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("formatWhen", () => {
  it("names today and yesterday with the time", () => {
    expect(formatWhen(new Date(2026, 10, 1, 9, 51), now)).toBe("Today 09:51");
    expect(formatWhen(new Date(2026, 9, 31, 22, 14), now)).toBe("Yesterday 22:14");
  });
  it("names a weekday within the week, then a date", () => {
    expect(formatWhen(new Date(2026, 9, 27, 18, 22), now)).toBe("Tue 18:22");
    expect(formatWhen(new Date(2026, 8, 12, 8, 0), now)).toBe("12 Sep");
    expect(formatWhen(new Date(2025, 8, 12, 8, 0), now)).toBe("12 Sep 2025");
  });
});

describe("untilPhrase", () => {
  it("counts calendar days, not 24 hour blocks", () => {
    expect(untilPhrase(new Date(2026, 10, 1, 23, 0), now)).toBe("today");
    expect(untilPhrase(new Date(2026, 10, 2, 1, 0), now)).toBe("tomorrow");
    expect(untilPhrase(new Date(2026, 10, 7, 1, 0), now)).toBe("in 6 days");
  });
});

describe("words", () => {
  it("pluralises", () => {
    expect(plural(1, "item")).toBe("1 item");
    expect(plural(13, "item")).toBe("13 items");
  });
  it("prints a duration", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
