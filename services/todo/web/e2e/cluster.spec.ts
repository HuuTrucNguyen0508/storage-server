// Proof in the lab cluster, through Traefik and real Authelia sign-in.
// Run with e2e/cluster-proof.sh, which sets CLUSTER=1, BASE_URL, ALICE_PASSWORD,
// BOB_PASSWORD and SHOTS.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

const on = !!process.env.CLUSTER;
const base = process.env.BASE_URL ?? "";
const shots = process.env.SHOTS ?? "";
const run = new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "");
const projectName = `Move${run}`;
if (shots) mkdirSync(shots, { recursive: true });

test.describe.configure({ mode: "serial" });
test.skip(!on, "set CLUSTER=1 (see e2e/cluster-proof.sh)");

type Opts = Parameters<Browser["newContext"]>[0];

async function signIn(browser: Browser, user: string, password: string, opts: Opts = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; memberRequests: string[] }> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: "Europe/Paris", viewport: { width: 1440, height: 900 }, ...opts });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const memberRequests: string[] = [];
  page.on("request", (r) => { if (/\/api\/projects\/[^/]+\/members$/.test(r.url())) memberRequests.push(r.url()); });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await expect(page).toHaveURL(/auth\./);
  await page.locator("#username-textfield").fill(user);
  await page.locator("#password-textfield").fill(password);
  await page.locator("#sign-in-button").click();
  await expect(page).toHaveURL(new RegExp("^" + base.replace(/\./g, "\\.") + "/today"));
  await expect(page.getByRole("heading", { level: 1, name: /^Today/ })).toBeVisible();
  return { ctx, page, errors, memberRequests };
}

const row = (page: Page, title: string) => page.locator("li.task", { has: page.locator(".task__title", { hasText: title }) }).first();
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

async function quickAdd(page: Page, text: string, preview?: string[]) {
  const qa = page.getByRole("textbox", { name: "Add a task" }).first();
  await qa.fill(text);
  for (const p of preview ?? []) await expect(page.getByRole("list", { name: "Recognized" })).toContainText(p);
  await qa.press("Enter");
  await expect(qa).toHaveValue("");
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function themed(page: Page, name: string, go: () => Promise<void>) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await go();
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

let projectPath = "";
let rentId = "";

test("alice plans a project with quick add, Today and Upcoming, and a repeating task", async ({ browser }) => {
  const { ctx, page, errors } = await signIn(browser, "alice", process.env.ALICE_PASSWORD!);
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill(projectName);
  await page.getByRole("dialog").getByRole("radio", { name: "Cobalt" }).check({ force: true });
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  projectPath = new URL(page.url()).pathname;

  await quickAdd(page, `Pay rent tomorrow 9am p1 #${projectName} @bills every month`, ["Tomorrow, 09:00", "Monthly", "Priority 1", projectName]);
  await quickAdd(page, "Take vitamins today 8am every day p2", ["Today, 08:00", "Daily"]);
  await quickAdd(page, "Call the letting agent today 17:30 p3 @calls");
  await quickAdd(page, "Book the van friday p2 @errand");
  await quickAdd(page, "Measure the new kitchen");
  await expect(row(page, "Pay rent").locator(".task__meta")).toContainText("Tomorrow, 09:00");
  rentId = (await row(page, "Pay rent").getAttribute("data-task-id"))!;

  await page.getByRole("link", { name: /^Today/ }).click();
  await expect(row(page, "Take vitamins")).toBeVisible();
  await expect(row(page, "Call the letting agent").locator(".task__meta")).toContainText("17:30");
  await page.getByRole("link", { name: /^Upcoming/ }).click();
  const tomorrow = page.locator("section.group", { has: page.getByRole("heading", { name: /^Tomorrow/ }) });
  await expect(tomorrow).toContainText("Pay rent");

  // Completing the daily task creates tomorrow's occurrence.
  await page.getByRole("link", { name: /^Today/ }).click();
  await row(page, "Take vitamins").getByRole("checkbox", { name: "Complete Take vitamins" }).click();
  await expect(toast(page, "Next one is set")).toBeVisible();
  await expect(row(page, "Take vitamins")).toHaveCount(0, { timeout: 5000 });
  await page.getByRole("link", { name: /^Upcoming/ }).click();
  await expect(tomorrow).toContainText("Take vitamins");
  await expect(row(page, "Take vitamins").locator(".task__meta")).toContainText("Tomorrow, 08:00");
  await page.getByRole("link", { name: /^Completed/ }).click();
  await expect(row(page, "Take vitamins")).toBeVisible();

  // Details: notes, a subtask, a comment; screenshots of the main screens.
  await page.goto(`${base}${projectPath}?task=${rentId}`);
  const panel = page.locator("aside.detail");
  await panel.getByRole("button", { name: "Add notes" }).click();
  await panel.getByRole("textbox", { name: /Notes/ }).fill("Standing order goes out at **09:00**.\n\n- Check it landed\n- File the receipt in Storage");
  await panel.getByRole("button", { name: "Save notes" }).click();
  await expect(panel.locator(".detail__prose strong")).toHaveText("09:00");
  await panel.getByRole("textbox", { name: "Add a subtask" }).fill("Check the amount");
  await panel.getByRole("textbox", { name: "Add a subtask" }).press("Enter");
  await expect(panel.getByRole("button", { name: "Check the amount" })).toBeVisible();
  await panel.getByRole("textbox", { name: "Write a comment" }).fill("Landlord confirmed the account number.");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.locator(".comment")).toContainText("Landlord confirmed");

  await themed(page, "desktop-project-detail", async () => {
    await page.goto(`${base}${projectPath}?task=${rentId}`);
    await expect(page.locator("aside.detail .detail__prose")).toBeVisible();
  });
  await themed(page, "desktop-today", async () => {
    await page.goto(`${base}/today`);
    await expect(page.locator("li.task").first()).toBeVisible();
  });
  await themed(page, "desktop-upcoming", async () => {
    await page.goto(`${base}/upcoming`);
    await expect(page.locator("li.task").first()).toBeVisible();
  });
  await themed(page, "desktop-completed", async () => {
    await page.goto(`${base}/completed`);
    await expect(page.locator("li.task").first()).toBeVisible();
  });
  await themed(page, "desktop-settings", async () => {
    await page.goto(`${base}/settings`);
    await expect(page.getByRole("combobox", { name: "Your timezone" })).toBeVisible();
  });
  await page.goto(`${base}/today`);
  await page.getByRole("textbox", { name: "Add a task" }).fill(`Renew the lease next monday 10am p1 #${projectName} @admin every year`);
  await shot(page, "desktop-quickadd-preview-light");
  await page.getByRole("textbox", { name: "Add a task" }).fill("");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("alice shares with bob, who sees changes live; as a viewer he can't write", async ({ browser }) => {
  const alice = await signIn(browser, "alice", process.env.ALICE_PASSWORD!);
  const a = alice.page;
  await a.goto(base + projectPath);
  await a.getByRole("button", { name: "Share project" }).click();
  const dlg = a.getByRole("dialog");
  await dlg.getByPlaceholder("Username").fill("bob");
  await dlg.getByLabel("Role").selectOption("editor");
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dlg.getByRole("list", { name: "Members" })).toContainText("bob");
  await shot(a, "desktop-members-light");
  await dlg.getByRole("button", { name: "Done" }).click();

  const bob = await signIn(browser, "bob", process.env.BOB_PASSWORD!);
  const b = bob.page;
  await b.goto(base + projectPath);
  await expect(b.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(row(b, "Pay rent")).toBeVisible();

  // Alice's changes reach bob without a reload, through Traefik's SSE route.
  await quickAdd(a, "Return the old keys saturday p2");
  await expect(row(b, "Return the old keys")).toBeVisible({ timeout: 15_000 });
  await row(a, "Book the van").getByRole("checkbox").click();
  await expect(row(b, "Book the van")).toHaveCount(0, { timeout: 15_000 });
  await a.goto(`${base}${projectPath}?task=${rentId}`);
  await a.locator("aside.detail").getByRole("textbox", { name: "Title" }).fill("Pay November rent");
  await a.locator("aside.detail").getByRole("textbox", { name: "Title" }).press("Enter");
  await expect(row(b, "Pay November rent")).toBeVisible({ timeout: 15_000 });

  // Bob as an editor: his change reaches alice.
  await quickAdd(b, "Bring the drill");
  await expect(row(a, "Bring the drill")).toBeVisible({ timeout: 15_000 });

  // Bob becomes a viewer: no edit controls, and the API refuses his writes.
  await a.getByRole("button", { name: "2 members" }).click();
  await a.getByRole("dialog").getByLabel("bob's role").selectOption("viewer");
  await expect(toast(a, "bob can view")).toBeVisible();
  await a.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(b.getByText("View only")).toBeVisible({ timeout: 15_000 });
  await expect(b.getByRole("textbox", { name: "Add a task" })).toHaveCount(0);
  await expect(row(b, "Bring the drill").getByRole("checkbox")).toBeDisabled();
  await expect(b.locator("button.task__grip")).toHaveCount(0);
  await row(b, "Pay November rent").locator(".task__open").click();
  await expect(b.locator("aside.detail").getByText("You can view this project")).toBeVisible();
  await expect(b.locator("aside.detail").getByRole("textbox", { name: "Title" })).toHaveCount(0);
  await expect(b.locator("aside.detail").getByRole("textbox", { name: "Write a comment" })).toHaveCount(0);
  const pid = projectPath.split("/").pop();
  const statuses = await b.evaluate(
    async ({ pid, tid }) => {
      const h = { "Content-Type": "application/json", "X-Requested-With": "fetch" };
      const create = await fetch(`/api/projects/${pid}/tasks`, { method: "POST", headers: h, body: JSON.stringify({ title: "sneaky" }) });
      const comment = await fetch(`/api/tasks/${tid}/comments`, { method: "POST", headers: h, body: JSON.stringify({ body: "sneaky" }) });
      return [create.status, comment.status];
    },
    { pid, tid: rentId },
  );
  expect(statuses).toEqual([403, 403]);
  await themed(b, "desktop-viewer", async () => {
    await b.goto(`${base}${projectPath}?task=${rentId}`);
    await expect(b.getByText("View only")).toBeVisible();
  });
  expect(alice.errors).toEqual([]);
  expect(bob.errors.filter((e) => !/403/.test(e))).toEqual([]);
  await alice.ctx.close();
  await bob.ctx.close();
});

test("phone layout: drawer, list and detail at 390 px, light and dark", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "alice", process.env.ALICE_PASSWORD!, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const noOverflow = async (p: Page) => expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await themed(page, "phone-today", async () => {
    await page.goto(`${base}/today`);
    await expect(page.locator("li.task").first()).toBeVisible();
    await noOverflow(page);
  });
  await themed(page, "phone-project", async () => {
    await page.goto(base + projectPath);
    await expect(page.locator("li.task").first()).toBeVisible();
    await noOverflow(page);
  });
  await themed(page, "phone-detail", async () => {
    await page.goto(`${base}${projectPath}?task=${rentId}`);
    await expect(page.locator("aside.detail .detail__prose")).toBeVisible();
  });
  await themed(page, "phone-drawer", async () => {
    await page.goto(`${base}/today`);
    await page.getByRole("button", { name: "Lists" }).click();
    await expect(page.locator(".sidebar.is-open")).toBeVisible();
  });
  // Quick add from the action bar.
  await page.goto(`${base}/today`);
  await page.getByRole("button", { name: "Add task" }).last().click();
  await expect(page.getByRole("textbox", { name: "Add a task" }).first()).toBeFocused();
  await ctx.close();
});




test("initial project list provides access without membership fan-out and stream checkpoints history", async ({ browser }) => {
  const {ctx, page, memberRequests} = await signIn(browser, "alice", process.env.ALICE_PASSWORD!);
  await page.getByRole("heading", {level: 1, name: /^Today/}).waitFor();
  expect(memberRequests).toEqual([]);
  const projects = await (await ctx.request.get(base + "/api/projects")).json();
  expect(projects.length).toBeGreaterThan(0);
  for (const p of projects) {
    expect(["owner", "editor", "viewer"]).toContain(p.role);
    expect(p.memberCount).toBeGreaterThanOrEqual(1);
  }
  const initial = await page.evaluate(async () => {
    const response = await fetch("/api/events");
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(chunk.value);
  });
  expect(initial).toMatch(/^id: \d+\nevent: resync\ndata: {}\n\n/);
  await ctx.close();
});
