import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Label, Project } from "../api/types";
import { sanitizedHtml } from "../lib/markdown";
import { ChipRow, preview } from "./QuickAdd";
import { RecurrenceEditor } from "./RecurrenceEditor";

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({
  id,
  owner: "alice",
  role: "owner",
  memberCount: 1,
  inbox: false,
  data: { name, color: "ochre", emoji: "", archived: false, order: 0 },
  ...extra,
});
const label = (id: string, name: string): Label => ({ id, owner: "alice", data: { name, color: "red" } });

const ctx = {
  tz: "Europe/Paris",
  today: "2026-11-05",
  now: new Date("2026-11-05T08:00:00Z"),
  projects: [project("inbox", "Inbox", { inbox: true }), project("home", "Home"), project("shared", "Trip")],
  labels: [label("l1", "bills")],
  canEdit: (id: string) => id !== "shared",
};

describe("quick add preview", () => {
  it("recognizes every part of the brief's example", () => {
    const pv = preview("Pay rent tomorrow 9am p1 #Home @bills every month", ctx);
    expect(pv.title).toBe("Pay rent");
    expect(pv.project?.id).toBe("home");
    expect(pv.priority).toBe(1);
    expect(pv.due).toBe("2026-11-06T08:00:00.000Z"); // 09:00 in Paris
    expect(pv.dateOnly).toBe(false);
    expect(pv.recurrence).toMatchObject({ kind: "months", interval: 1 });
    expect(pv.labels).toEqual([{ name: "bills", existing: ctx.labels[0] }]);
    render(<ChipRow chips={pv.chips} />);
    const chips = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(chips).toEqual(["Home", "Tomorrow, 09:00", "Monthly", "Priority 1", "bills"]);
  });

  it("flags unknown and read-only projects, and new labels", () => {
    expect(preview("Book flights #Japan", ctx).chips[0]).toMatchObject({ text: "No project “Japan”", tone: "warn" });
    expect(preview("Book flights #Trip", ctx).projectMissing).toBe("Trip");
    expect(preview("Call @dentist", ctx).chips).toEqual([expect.objectContaining({ text: "New label dentist", tone: "new" })]);
  });

  it("shows nothing for plain text", () => {
    expect(preview("Water the plants", ctx).chips).toEqual([]);
  });
});

describe("recurrence editor", () => {
  it("builds a weekly rule on chosen days", async () => {
    const onSave = vi.fn();
    render(<RecurrenceEditor value={null} due="2026-11-05T08:00:00.000Z" tz="Europe/Paris" onSave={onSave} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "weekly");
    // Thursday (the due day) is preselected; add Monday.
    expect(screen.getByRole("button", { name: "Thursday" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Monday" }));
    expect(screen.getByTestId("recur-summary")).toHaveTextContent("Every Mon and Thu");
    await user.click(screen.getByRole("radio", { name: "From completion" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ kind: "weekly", interval: 1, days: [1, 4], from: "completion" });
  });

  it("refuses an empty week and an out-of-range interval", async () => {
    const onSave = vi.fn();
    render(<RecurrenceEditor value={{ kind: "weekly", interval: 1, days: [4], from: "due" }} due={null} tz="UTC" onSave={onSave} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Thursday" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick at least one day of the week.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "custom");
    const n = screen.getByRole("spinbutton", { name: "Interval" });
    await user.clear(n);
    await user.type(n, "1000");
    expect(screen.getByRole("alert")).toHaveTextContent("Repeat every 1 to 999.");
    await user.clear(n);
    await user.type(n, "3");
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "months");
    expect(screen.getByTestId("recur-summary")).toHaveTextContent(/Every 3 months on the \d+(st|nd|rd|th)/);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ kind: "months", interval: 3, from: "due" });
  });

  it("removes the repeat with Doesn't repeat", async () => {
    const onSave = vi.fn();
    render(<RecurrenceEditor value={{ kind: "days", interval: 1, from: "due" }} due={null} tz="UTC" onSave={onSave} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "none");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});

describe("markdown", () => {
  it("renders Markdown, drops raw HTML, and makes links safe", () => {
    const { __html } = sanitizedHtml('**hi** <script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.org)');
    expect(__html).toContain("<strong>hi</strong>");
    expect(__html).not.toContain("<script");
    expect(__html).not.toContain("<img");
    expect(__html).not.toContain('href="javascript');
    expect(__html).toContain('rel="noopener noreferrer"');
  });
});
