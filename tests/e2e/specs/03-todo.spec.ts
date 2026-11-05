import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { asUser, mutating } from "../lib/auth";
import { origin, runId } from "../lib/env";

// Todo journeys through SSO. The todo app's own suites cover the whole feature set; this
// follows one person's day and one shared project.
const base = origin("todo");
const project = `E2E${runId}`;
const label = `e2e${runId}`;
const chore = `Water the plants ${runId}`;
const keys = `Return the keys ${runId}`;
let projectPath = "";

test.describe.configure({ mode: "serial" });

const row = (page: Page, title: string) => page.locator("li.task", { has: page.locator(".task__title", { hasText: title }) }).first();
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

async function quickAdd(page: Page, text: string, preview: string[] = []) {
  const qa = page.getByRole("textbox", { name: "Add a task" }).first();
  await qa.fill(text);
  for (const p of preview) await expect(page.getByRole("list", { name: "Recognized" })).toContainText(p);
  await qa.press("Enter");
  await expect(qa).toHaveValue("");
}

async function cleanUp(api: APIRequestContext) {
  const projects = (await (await api.get(`${base}/api/projects`)).json()) as { id: string; inbox: boolean; data: { name: string } }[];
  for (const p of projects.filter((p) => !p.inbox && p.data.name === project)) await api.delete(`${base}/api/projects/${p.id}`, { headers: mutating });
  const labels = (await (await api.get(`${base}/api/labels`)).json()) as { id: string; data: { name: string } }[];
  for (const l of labels.filter((l) => l.data.name === label)) await api.delete(`${base}/api/labels/${l.id}`, { headers: mutating });
}

test.afterAll(async ({ browser }) => {
  const alice = await asUser(browser, "alice");
  await cleanUp(alice.ctx.request); // deleting the project removes its tasks, comments and member rows
  await alice.ctx.close();
});

test("alice quick-adds a task, finds it in Today and completes it; the next one appears", async ({ browser }) => {
  const { ctx, page } = await asUser(browser, "alice", { timezoneId: "Europe/Paris" });
  await page.goto(base + "/");
  await expect(page).toHaveURL(new RegExp("^" + base.replace(/\./g, "\\.") + "/today"));
  await expect(page.getByRole("heading", { level: 1, name: /^Today/ })).toBeVisible();

  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill(project);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: project })).toBeVisible();
  projectPath = new URL(page.url()).pathname;

  // Inline syntax: a date and time, a priority, a project, a label and a repeat.
  await quickAdd(page, `${chore} today 9am p1 #${project} @${label} every day`, ["Today, 09:00", "Daily", "Priority 1", project]);
  await expect(row(page, chore).locator(".task__meta")).toContainText("Today, 09:00");

  await page.getByRole("link", { name: /^Today/ }).click();
  await expect(row(page, chore)).toBeVisible();

  await row(page, chore).getByRole("checkbox", { name: `Complete ${chore}` }).click();
  await expect(toast(page, "Next one is set")).toBeVisible();
  await expect(row(page, chore)).toHaveCount(0, { timeout: 5000 });
  await page.getByRole("link", { name: /^Upcoming/ }).click();
  const tomorrow = page.locator("section.group", { has: page.getByRole("heading", { name: /^Tomorrow/ }) });
  await expect(tomorrow).toContainText(chore);
  await expect(row(page, chore).locator(".task__meta")).toContainText("Tomorrow, 09:00");
  await page.getByRole("link", { name: /^Completed/ }).click();
  await expect(row(page, chore)).toBeVisible();
  await ctx.close();
});

test("alice shares the project with bob as editor and bob's open page follows her changes live", async ({ browser }) => {
  expect(projectPath, "the previous test creates the project").not.toBe("");
  const alice = await asUser(browser, "alice", { timezoneId: "Europe/Paris" });
  const a = alice.page;
  await a.goto(base + projectPath);
  await a.getByRole("button", { name: "Share project" }).click();
  const dlg = a.getByRole("dialog");
  await dlg.getByPlaceholder("Username").fill("bob");
  await dlg.getByLabel("Role").selectOption("editor");
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dlg.getByRole("list", { name: "Members" })).toContainText("bob");
  await dlg.getByRole("button", { name: "Done" }).click();

  const bob = await asUser(browser, "bob", { timezoneId: "Europe/Paris" });
  const b = bob.page;
  await b.goto(base + projectPath);
  await expect(b.getByRole("heading", { name: project })).toBeVisible();
  await expect(row(b, chore)).toBeVisible(); // the next occurrence from the previous test

  // Alice changes something; Bob's page, not reloaded, shows it through the live stream.
  await quickAdd(a, keys);
  await expect(row(b, keys)).toBeVisible({ timeout: 20_000 });
  await row(a, keys).getByRole("checkbox").click();
  await expect(row(b, keys)).toHaveCount(0, { timeout: 20_000 });

  // And as an editor, his change reaches her.
  await quickAdd(b, `Bring the drill ${runId}`);
  await expect(row(a, `Bring the drill ${runId}`)).toBeVisible({ timeout: 20_000 });
  await alice.ctx.close();
  await bob.ctx.close();
});
