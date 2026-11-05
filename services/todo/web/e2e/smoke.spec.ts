// Local smoke test against a real API (AUTH_MODE=dev). Run with e2e/run-local.sh:
// alice is served on BASE_URL, bob on BOB_URL, both on one database.

import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";

const ALICE = process.env.BASE_URL ?? "http://127.0.0.1:18090";
const BOB = process.env.BOB_URL ?? "http://127.0.0.1:18091";
const run = Date.now().toString(36).slice(-4);
const projectName = `Flat${run}`;

function watchConsole(page: Page, errors: string[]) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
}

async function open(browser: Browser, base: string, errors: string[]) {
  const ctx = await browser.newContext({ baseURL: base, timezoneId: "Europe/Paris", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watchConsole(page, errors);
  return page;
}

async function quickAdd(page: Page, text: string) {
  const qa = page.getByRole("textbox", { name: "Add a task" }).first();
  await qa.fill(text);
  await qa.press("Enter");
  await expect(qa).toHaveValue("");
}

async function dragTo(page: Page, source: Locator, target: Locator) {
  await source.hover();
  const grip = source.locator("button.task__grip");
  const a = (await grip.boundingBox())!;
  const b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 - 8, { steps: 4 });
  await page.mouse.move(b.x + 60, b.y + 6, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

const row = (page: Page, title: string) => page.locator("li.task", { has: page.locator(".task__title", { hasText: title }) }).first();

test("alice plans, shares, and bob sees changes live; viewers are read-only", async ({ browser }) => {
  const errors: string[] = [];
  const alice = await open(browser, ALICE, errors);
  await alice.goto("/");
  await expect(alice).toHaveURL(/\/today$/);
  await expect(alice.getByRole("heading", { name: /Today/ })).toBeVisible();

  // A project through the dialog.
  await alice.getByRole("button", { name: "New project" }).click();
  await alice.getByRole("dialog").getByLabel("Name").fill(projectName);
  await alice.getByRole("button", { name: "Create project" }).click();
  await expect(alice).toHaveURL(/\/p\/[0-9a-f-]{36}$/);
  const projectUrl = new URL(alice.url()).pathname;
  await expect(alice.getByRole("heading", { name: projectName })).toBeVisible();

  // Quick add with the inline syntax: the preview shows what was understood.
  const qa = alice.getByRole("textbox", { name: "Add a task" }).first();
  await qa.fill(`Pay rent tomorrow 9am p1 #${projectName} @bills every month`);
  const chips = alice.getByRole("list", { name: "Recognized" });
  await expect(chips).toContainText("Tomorrow, 09:00");
  await expect(chips).toContainText("Monthly");
  await expect(chips).toContainText("Priority 1");
  await expect(chips).toContainText(projectName);
  await expect(chips).toContainText("New label bills");
  await qa.press("Enter");
  const rent = row(alice, "Pay rent");
  await expect(rent).toBeVisible();
  await expect(rent.locator(".task__meta")).toContainText("Tomorrow, 09:00");
  await expect(rent.locator(".task__meta")).toContainText("Monthly");
  await expect(rent.locator(".task__meta")).toContainText("bills");
  await expect(alice.getByRole("navigation", { name: "Labels" })).toContainText("bills");

  await quickAdd(alice, "Take vitamins today every day p2");
  await quickAdd(alice, "Call the agent today 18:00");

  // Today and Upcoming.
  await alice.getByRole("link", { name: /^Today/ }).click();
  await expect(row(alice, "Call the agent")).toBeVisible();
  await expect(row(alice, "Take vitamins")).toBeVisible();
  await expect(row(alice, "Call the agent").locator(".task__meta")).toContainText("18:00");
  await alice.getByRole("link", { name: /^Upcoming/ }).click();
  const tomorrow = alice.locator("section.group", { has: alice.getByRole("heading", { name: /^Tomorrow/ }) });
  await expect(tomorrow).toContainText("Pay rent");

  // Completing a repeating task creates the next one.
  await alice.getByRole("link", { name: /^Today/ }).click();
  await row(alice, "Take vitamins").getByRole("checkbox", { name: "Complete Take vitamins" }).click();
  await expect(alice.getByRole("status").filter({ hasText: "Next one is set" })).toBeVisible();
  await expect(row(alice, "Take vitamins")).toHaveCount(0, { timeout: 5000 });
  await alice.getByRole("link", { name: /^Upcoming/ }).click();
  await expect(tomorrow).toContainText("Take vitamins");

  // Detail panel: title, Markdown notes (sanitized), subtask, comment.
  await alice.goto(projectUrl);
  await row(alice, "Call the agent").locator(".task__open").click();
  const panel = alice.locator("aside.detail");
  await panel.getByRole("textbox", { name: "Title" }).fill("Call the letting agent");
  await panel.getByRole("textbox", { name: "Title" }).press("Enter");
  await expect(row(alice, "Call the letting agent")).toBeVisible();
  await panel.getByRole("button", { name: "Add notes" }).click();
  await panel.getByRole("textbox", { name: /Notes/ }).fill("Ask about **the deposit**.\n\n<img src=x onerror=alert(1)>");
  await panel.getByRole("button", { name: "Save notes" }).click();
  await expect(panel.locator(".detail__prose strong")).toHaveText("the deposit");
  await expect(panel.locator(".detail__prose img")).toHaveCount(0);
  await panel.getByRole("textbox", { name: "Add a subtask" }).fill("Find the lease number");
  await panel.getByRole("textbox", { name: "Add a subtask" }).press("Enter");
  await expect(panel.getByRole("button", { name: "Find the lease number" })).toBeVisible();
  await panel.getByRole("textbox", { name: "Write a comment" }).fill("Office opens at 9.");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.locator(".comment").filter({ hasText: "Office opens at 9." })).toBeVisible();
  await alice.keyboard.press("Escape");
  await expect(alice.locator("aside.detail")).toHaveCount(0);
  await expect(alice).not.toHaveURL(/task=/);

  // Delete with undo.
  await row(alice, "Pay rent").getByRole("button", { name: "More for Pay rent" }).click();
  await alice.getByRole("menuitem", { name: "Delete" }).click();
  await expect(row(alice, "Pay rent")).toHaveCount(0);
  await alice.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(row(alice, "Pay rent")).toBeVisible();

  // Share with bob as an editor.
  await alice.getByRole("button", { name: "Share project" }).click();
  const dlg = alice.getByRole("dialog");
  await dlg.getByPlaceholder("Username").fill("bob");
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dlg.getByRole("list", { name: "Members" })).toContainText("bob");
  await dlg.getByRole("button", { name: "Done" }).click();

  // Bob sees alice's next change without reloading.
  const bob = await open(browser, BOB, errors);
  await bob.goto(projectUrl);
  await expect(bob.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(row(bob, "Pay rent")).toBeVisible();
  await quickAdd(alice, "Book the van p2");
  await expect(row(bob, "Book the van")).toBeVisible({ timeout: 10_000 });
  await row(alice, "Book the van").getByRole("checkbox").click();
  await expect(row(bob, "Book the van")).toHaveCount(0, { timeout: 10_000 });

  // Bob, an editor, changes something; alice sees it.
  await quickAdd(bob, "Measure the kitchen");
  await expect(row(alice, "Measure the kitchen")).toBeVisible({ timeout: 10_000 });

  // Drag to reorder within the section, and the order survives a reload.
  const firstTitle = () => alice.locator("section.group").first().locator(".task__title").first().textContent();
  await dragTo(alice, row(alice, "Measure the kitchen"), row(alice, "Pay rent"));
  await expect.poll(firstTitle).toBe("Measure the kitchen");
  await alice.reload();
  await expect.poll(firstTitle).toBe("Measure the kitchen");

  // Drop a task on another project in the sidebar to move it there.
  await alice.getByRole("button", { name: "New project" }).click();
  await alice.getByRole("dialog").getByLabel("Name").fill(`Errands${run}`);
  await alice.getByRole("button", { name: "Create project" }).click();
  await expect(alice.getByRole("heading", { name: `Errands${run}` })).toBeVisible();
  await alice.goto(projectUrl);
  await dragTo(alice, row(alice, "Measure the kitchen"), alice.locator(".nav__row", { hasText: `Errands${run}` }));
  await expect(alice.getByRole("status").filter({ hasText: `Moved “Measure the kitchen” to Errands${run}` })).toBeVisible();
  await expect(row(alice, "Measure the kitchen")).toHaveCount(0);
  await alice.locator(".nav__row", { hasText: `Errands${run}` }).getByRole("link").click();
  await expect(row(alice, "Measure the kitchen")).toBeVisible();
  await alice.goto(projectUrl);

  // Make bob a viewer: no edit controls, and writes are refused.
  await alice.getByRole("button", { name: "2 members" }).click();
  await alice.getByRole("dialog").getByLabel("bob's role").selectOption("viewer");
  await expect(alice.getByRole("status").filter({ hasText: "bob can view" })).toBeVisible();
  await alice.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(bob.getByText("View only")).toBeVisible({ timeout: 10_000 });
  await expect(bob.getByRole("textbox", { name: "Add a task" })).toHaveCount(0);
  await expect(row(bob, "Pay rent").getByRole("checkbox")).toBeDisabled();
  await expect(row(bob, "Pay rent").getByRole("button", { name: /^More for/ })).toHaveCount(0);
  await row(bob, "Pay rent").locator(".task__open").click();
  const bobPanel = bob.locator("aside.detail");
  await expect(bobPanel.getByText("You can view this project")).toBeVisible();
  await expect(bobPanel.getByRole("textbox", { name: "Title" })).toHaveCount(0);
  const projectId = projectUrl.split("/").pop();
  const status = await bob.evaluate(async (pid) => {
    const r = await fetch(`/api/projects/${pid}/tasks`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ title: "sneaky" }) });
    return r.status;
  }, projectId);
  expect(status).toBe(403);

  // Keyboard: q focuses quick add, ? shows the shortcuts, j/x complete.
  await alice.locator("body").click({ position: { x: 700, y: 850 } });
  await alice.keyboard.press("q");
  await expect(alice.getByRole("textbox", { name: "Add a task" }).first()).toBeFocused();
  await alice.keyboard.press("Escape");
  await alice.keyboard.press("?");
  await expect(alice.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await alice.keyboard.press("Escape");

  // Due date editor in the panel.
  await row(alice, "Call the letting agent").locator(".task__open").click();
  const ap = alice.locator("aside.detail");
  await ap.getByRole("button", { name: /^Due .*Change$/ }).click();
  await ap.getByRole("form", { name: "Due date" }).getByRole("button", { name: "Tomorrow" }).click();
  await ap.getByRole("form", { name: "Due date" }).getByLabel("Time").fill("");
  await ap.getByRole("form", { name: "Due date" }).getByRole("button", { name: "Save" }).click();
  await expect(row(alice, "Call the letting agent").locator(".task__meta")).toContainText("Tomorrow");
  await expect(row(alice, "Call the letting agent").locator(".task__meta")).not.toContainText(":");
  await alice.keyboard.press("Escape");

  // Search from the sidebar.
  await alice.getByRole("searchbox", { name: "Search tasks" }).fill("letting");
  await alice.getByRole("searchbox", { name: "Search tasks" }).press("Enter");
  await expect(alice).toHaveURL(/\/search\?q=letting/);
  await expect(row(alice, "Call the letting agent")).toBeVisible();

  // Settings: export, then import the export back.
  await alice.goto("/settings");
  await expect(alice.getByRole("combobox", { name: "Your timezone" })).toHaveValue("Europe/Paris");
  const exported = await alice.evaluate(async () => (await fetch("/api/export?format=json")).text());
  expect(JSON.parse(exported).format).toBe(1);
  await alice.locator('input[type="file"]').setInputFiles({ name: "todo.json", mimeType: "application/json", buffer: Buffer.from(exported) });
  await expect(alice.getByRole("status").filter({ hasText: /Imported \d+ projects? and \d+ tasks?/ })).toBeVisible();

  // Losing the connection shows a calm reconnecting line; it clears on its own.
  await alice.route("**/api/events", (r) => r.abort("connectionreset"));
  await alice.goto("/today");
  await expect(alice.locator(".live-status__text")).toContainText("Reconnecting", { timeout: 15_000 });
  await alice.unroute("**/api/events");
  await expect(alice.locator(".live-status__text")).toHaveCount(0, { timeout: 40_000 });
  // Changes made while away arrive after the reconnect's resync.
  await quickAdd(alice, "After the reconnect");
  await expect(row(alice, "After the reconnect")).toBeVisible();

  // A reminder arrives over the stream as a toast.
  await quickAdd(alice, "Ping the landlord");
  const pingId = await row(alice, "Ping the landlord").getAttribute("data-task-id");
  await alice.evaluate(async (id) => {
    const t = await (await fetch(`/api/tasks/${id}`)).json();
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ version: t.version, reminderAt: new Date(Date.now() + 1500).toISOString() }),
    });
  }, pingId);
  await expect(alice.getByRole("status").filter({ hasText: "Reminder: “Ping the landlord”" })).toBeVisible({ timeout: 15_000 });

  // j moves the selection, x completes the selected task.
  await alice.goto("/today");
  await alice.locator("body").click({ position: { x: 700, y: 880 } });
  const before = await alice.locator("li.task .task__title").allTextContents();
  await alice.keyboard.press("j");
  await expect(alice.locator("li.task.is-selected .task__title")).toHaveText(before[0]!);
  await alice.keyboard.press("x");
  await expect(alice.getByRole("status").filter({ hasText: `Completed “${before[0]}”` })).toBeVisible();

  expect(errors.filter((e) => !/Failed to load resource/i.test(e))).toEqual([]);
});
