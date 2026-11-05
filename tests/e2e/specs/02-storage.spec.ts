import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { asUser, mutating } from "../lib/auth";
import { origin, runId } from "../lib/env";
import { makePdf, makePng } from "../lib/files";

// Storage journeys. The per-app suites (services/storage/web/e2e) cover every viewer
// and edge case; this checks the whole path: SSO, upload, viewer, sharing, public link.
const base = origin("storage");
const folder = `e2e-${runId}`;
const linkPassword = `pw-${runId}-bled`;
let shareUrl = "";

test.describe.configure({ mode: "serial" });

async function rowFor(page: Page, name: string) {
  return page.locator("tbody tr", { hasText: name }).first();
}
async function openFile(page: Page, name: string) {
  await (await rowFor(page, name)).dblclick();
  await expect(page.locator(".viewer .viewer__title")).toContainText(name);
}
async function removeFolder(api: APIRequestContext) {
  const me = (await (await api.get(`${base}/api/me`)).json()) as { user: { rootId: string } };
  const list = (await (await api.get(`${base}/api/nodes/${me.user.rootId}/children`)).json()) as { items: { id: string; name: string }[] };
  for (const node of list.items.filter((n) => n.name === folder)) {
    await api.delete(`${base}/api/nodes/${node.id}`, { headers: mutating });
    await api.delete(`${base}/api/trash/${node.id}`, { headers: mutating });
  }
}

test.afterAll(async ({ browser }) => {
  const alice = await asUser(browser, "alice");
  await removeFolder(alice.ctx.request);
  await alice.ctx.close();
});

test("alice uploads an image, a PDF and a Markdown file and opens each in the viewer", async ({ browser }) => {
  const { ctx, page } = await asUser(browser, "alice");
  await page.goto(base + "/");
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill(folder);
  await page.getByRole("button", { name: "Create folder" }).click();
  await (await rowFor(page, folder)).locator("a").click();
  await expect(page.locator("h1.crumbs__here")).toHaveText(folder);

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: "picture.png", mimeType: "image/png", buffer: makePng(96, 64) },
    { name: "report.pdf", mimeType: "application/pdf", buffer: makePdf("Quarterly report page one", "Page two of the report") },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# E2E notes\n\nSome *emphasis* and a <script>alert(1)</script> that must stay inert.\n") },
  ]);
  await expect(page.locator(".tray")).toContainText(/Uploaded 3 files/, { timeout: 60_000 });
  await expect(page.locator("tbody tr")).toHaveCount(3);

  await openFile(page, "picture.png");
  await expect.poll(() => page.locator(".viewer img.viewer-img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(96);
  await page.keyboard.press("Escape");

  await openFile(page, "report.pdf");
  await expect(page.locator(".pdf-pager")).toContainText("of 2");
  await expect(page.locator(".viewer .pdf-page canvas").first()).toBeVisible();
  await expect(page.locator(".textLayer").first()).toContainText("Quarterly report");
  await page.keyboard.press("Escape");

  await openFile(page, "notes.md");
  await expect(page.locator(".viewer article.prose h1")).toHaveText("E2E notes");
  expect(await page.locator(".viewer article.prose script").count()).toBe(0);
  await page.keyboard.press("Escape");
  await ctx.close();
});

test("alice shares the folder with bob (read) and makes a password link", async ({ browser }) => {
  const { ctx, page } = await asUser(browser, "alice");
  await page.goto(base + "/");
  await (await rowFor(page, folder)).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dlg = page.getByRole("dialog", { name: new RegExp(`Share ${folder}`) });
  await dlg.getByPlaceholder("Username, for example bob").fill("bob");
  await dlg.getByRole("button", { name: "Add" }).click();
  await expect(dlg.getByRole("list", { name: "People with access" })).toContainText("bob");
  await dlg.getByRole("button", { name: "Done" }).click();
  await expect(await rowFor(page, folder)).toContainText("Bob can view");

  await (await rowFor(page, folder)).locator("a").click();
  await (await rowFor(page, "picture.png")).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share" }).click();
  const link = page.getByRole("dialog", { name: /Share picture\.png/ });
  await link.getByLabel("Password").fill(linkPassword);
  await link.getByRole("button", { name: "Create link" }).click();
  shareUrl = await link.getByLabel("New link").inputValue();
  expect(shareUrl).toMatch(new RegExp(`^${base.replace(/\./g, "\\.")}/s/[A-Za-z0-9_-]{43}$`));
  await link.getByRole("button", { name: "Done" }).click();
  await ctx.close();
});

test("bob sees it under Shared with me and cannot delete", async ({ browser }) => {
  const { ctx, page } = await asUser(browser, "bob");
  await page.goto(base + "/");
  await page.getByRole("link", { name: "Shared with me" }).first().click();
  const row = await rowFor(page, folder);
  await expect(row).toContainText("alice, you can view");
  await row.locator("a").click();
  await expect(page.locator(".crumbs-badge")).toContainText("you can view");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "New folder" })).toHaveCount(0);

  await (await rowFor(page, "notes.md")).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Download");
  await expect(menu).not.toContainText("Move to trash");
  await expect(menu).not.toContainText("Rename");
  await page.keyboard.press("Escape");

  // A hand-made request is refused by the server too, and bob can still read the file.
  const id = await (await rowFor(page, "notes.md")).getAttribute("data-row");
  const del = await page.request.delete(`${base}/api/nodes/${id}`, { headers: mutating, maxRedirects: 0 });
  expect(del.status()).toBe(403);
  await openFile(page, "notes.md");
  await expect(page.locator(".viewer article.prose h1")).toHaveText("E2E notes");
  await ctx.close();
});

test("a password public link works for an anonymous visitor and refuses a wrong password", async ({ browser }) => {
  expect(shareUrl, "the previous test creates the link").not.toBe("");
  const ctx = await browser.newContext(); // no cookies: nobody is signed in
  const guest = await ctx.newPage();
  await guest.goto(shareUrl);
  await expect(guest).toHaveURL(shareUrl); // no redirect to sign-in
  await expect(guest.getByRole("heading", { name: "This link has a password" })).toBeVisible();
  await guest.getByLabel("Password").fill("not-the-password");
  await guest.getByRole("button", { name: "Open" }).click();
  await expect(guest.locator(".field__error")).toContainText("didn't match");
  await guest.getByLabel("Password").fill(linkPassword);
  await guest.getByRole("button", { name: "Open" }).click();
  await expect(guest.getByRole("heading", { name: "picture.png" })).toBeVisible();
  await expect.poll(() => guest.locator(".guest__preview img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(96);
  // The same link answers an API caller without the unlock cookie with 401.
  const token = shareUrl.split("/s/")[1];
  const fresh = await browser.newContext();
  const info = await fresh.request.get(`${base}/api/public/${token}`);
  expect(info.status()).toBe(200);
  expect(((await info.json()) as { link: { requiresPassword: boolean; unlocked: boolean } }).link).toMatchObject({ requiresPassword: true, unlocked: false });
  await fresh.close();
  await ctx.close();
});
