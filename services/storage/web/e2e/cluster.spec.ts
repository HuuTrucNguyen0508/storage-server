import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

// End-to-end proof in the lab cluster, through Traefik and real Authelia
// sign-in. Run with e2e/cluster-proof.sh, which sets:
//   CLUSTER=1 BASE_URL=https://storage.<domain> AUTH_URL=https://auth.<domain>
//   ALICE_PASSWORD BOB_PASSWORD FIXTURES SHOTS [BIG_FILE]
const on = !!process.env.CLUSTER;
const base = process.env.BASE_URL ?? "";
const fixtures = process.env.FIXTURES ?? "";
const shots = process.env.SHOTS ?? "";
const bigFile = process.env.BIG_FILE ?? "";
const run = `Proof ${new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h")}`;
if (shots) mkdirSync(shots, { recursive: true });

test.describe.configure({ mode: "serial" });
test.skip(!on, "set CLUSTER=1 (see e2e/cluster-proof.sh)");

async function signIn(browser: Browser, user: string, password: string, opts: Parameters<Browser["newContext"]>[0] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...opts });
  const page = await ctx.newPage();
  await page.goto(base + "/");
  // Authelia's sign-in page, then back to Storage.
  await expect(page).toHaveURL(/auth\./);
  await page.locator("#username-textfield").fill(user);
  await page.locator("#password-textfield").fill(password);
  await page.locator("#sign-in-button").click();
  await expect(page).toHaveURL(new RegExp("^" + base.replace(/\./g, "\\.")));
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  return { ctx, page };
}

const shot = (page: Page, name: string) => (shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }) : Promise.resolve());

async function openRow(page: Page, name: string) {
  await page.locator("tbody tr", { hasText: name }).first().locator("a").click();
}

async function openFile(page: Page, name: string) {
  await page.locator("tbody tr", { hasText: name }).first().dblclick();
  await expect(page.locator(".viewer .viewer__title")).toContainText(name);
}

let shareUrl = "";

test("alice uploads a folder and opens every kind of file", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "alice", process.env.ALICE_PASSWORD!, { viewport: { width: 1440, height: 900 } });
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill(run);
  await page.getByRole("button", { name: "Create folder" }).click();
  await openRow(page, run);
  await expect(page.locator("h1.crumbs__here")).toHaveText(run);
  await page.locator("input[webkitdirectory]").setInputFiles(path.join(fixtures, "Trip notes"));
  await expect(page.locator(".tray")).toContainText(/Uploaded 9 files/, { timeout: 120_000 });
  await openRow(page, "Trip notes");
  await expect(page.locator("tbody tr")).toHaveCount(9);
  await shot(page, "cluster-browser-desktop-light");

  await openFile(page, "lake.jpg");
  await expect.poll(() => page.locator(".viewer img.viewer-img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1600);
  await shot(page, "viewer-image");
  await page.keyboard.press("Escape");

  await openFile(page, "itinerary.pdf");
  await expect(page.locator(".pdf-pager")).toContainText("of 2");
  await page.getByLabel("Find in document").fill("Bohinj");
  await page.getByLabel("Find in document").press("Enter");
  await expect(page.getByLabel("Page number")).toHaveValue("2");
  await expect(page.locator(".textLayer span.is-match").first()).toBeVisible();
  await shot(page, "viewer-pdf");
  await page.keyboard.press("Escape");

  await openFile(page, "packing list.md");
  await expect(page.locator(".viewer article.prose h1")).toHaveText("Packing list");
  expect(await page.locator(".viewer article.prose script").count()).toBe(0);
  await shot(page, "viewer-markdown");
  await page.keyboard.press("Escape");

  await openFile(page, "budget.go");
  await expect(page.locator(".code__body .hljs-keyword").first()).toBeVisible();
  await shot(page, "viewer-code");
  await page.keyboard.press("Escape");

  await openFile(page, "drone.mp4");
  const video = page.locator(".viewer video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => (v.currentTime = 2));
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.5);
  await shot(page, "viewer-video");
  await page.keyboard.press("Escape");

  // Office documents go through Stirling PDF and come back as a PDF.
  await openFile(page, "thank you letter.docx");
  await expect(page.locator(".viewer .pdf-page canvas")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".textLayer")).toContainText("Thanks for organising", { timeout: 30_000 });
  await shot(page, "viewer-office");
  await page.keyboard.press("Escape");

  await openFile(page, "expenses.csv");
  await expect(page.locator(".viewer table")).toContainText("hostel");
  await shot(page, "viewer-csv");
  await page.keyboard.press("Escape");
  await openFile(page, "route.json");
  await expect(page.locator(".code__body")).toContainText('"stops": [');
  await page.keyboard.press("Escape");
  await openFile(page, "maps.zip");
  await expect(page.locator(".viewer")).toContainText("maps/bohinj.txt");
  await shot(page, "viewer-zip");
  await page.keyboard.press("Escape");

  // Share the folder with bob, read only.
  await page.getByRole("link", { name: run }).click();
  await page.locator("tbody tr", { hasText: "Trip notes" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dlg = page.getByRole("dialog", { name: /Share Trip notes/ });
  await dlg.getByPlaceholder("Username, for example bob").fill("bob");
  await dlg.getByRole("button", { name: "Add" }).click();
  await expect(dlg.getByRole("list", { name: "People with access" })).toContainText("bob");
  await shot(page, "share-dialog");
  await dlg.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("tbody tr", { hasText: "Trip notes" })).toContainText("Bob can view");

  // A password link to the photo.
  await openRow(page, "Trip notes");
  await page.locator("tbody tr", { hasText: "lake.jpg" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dlg2 = page.getByRole("dialog", { name: /Share lake.jpg/ });
  await dlg2.getByLabel("Password").fill("bled-2026");
  await dlg2.getByLabel("Download limit").fill("5");
  await dlg2.getByRole("button", { name: "Create link" }).click();
  shareUrl = await dlg2.getByLabel("New link").inputValue();
  expect(shareUrl).toMatch(new RegExp(`^${base.replace(/\./g, "\\.")}/s/[A-Za-z0-9_-]{43}$`));
  await dlg2.getByRole("button", { name: "Done" }).click();
  await ctx.close();
});

test("bob sees the read-only share and cannot delete", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "bob", process.env.BOB_PASSWORD!, { viewport: { width: 1440, height: 900 } });
  await page.getByRole("link", { name: "Shared with me" }).first().click();
  const row = page.locator("tbody tr", { hasText: "Trip notes" }).first();
  await expect(row).toContainText("alice, you can view");
  await row.locator("a").click();
  await expect(page.locator(".crumbs-badge")).toContainText("you can view");
  await expect(page.locator("tbody tr")).toHaveCount(9);
  await expect(page.getByRole("button", { name: "New folder" })).toHaveCount(0);
  await page.locator("tbody tr", { hasText: "budget.go" }).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Download");
  await expect(menu).not.toContainText("Move to trash");
  await expect(menu).not.toContainText("Rename");
  await shot(page, "bob-shared-readonly");
  await page.keyboard.press("Escape");
  // Even a hand-made request is refused by the server.
  const id = await page.locator("tbody tr", { hasText: "budget.go" }).getAttribute("data-row");
  const res = await page.request.delete(`${base}/api/nodes/${id}`, { headers: { "X-Requested-With": "fetch" }, maxRedirects: 0 });
  expect(res.status()).toBe(403);
  const ren = await page.request.patch(`${base}/api/nodes/${id}`, { headers: { "X-Requested-With": "fetch" }, data: { name: "x.go" }, maxRedirects: 0 });
  expect(ren.status()).toBe(403);
  // Bob can still read it.
  await openFile(page, "budget.go");
  await expect(page.locator(".code__body")).toContainText("func Budget");
  await ctx.close();
});

test("a guest opens the password link in a fresh anonymous browser", async ({ browser }) => {
  expect(shareUrl).not.toBe("");
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const g = await ctx.newPage();
  await g.goto(shareUrl);
  await expect(g).toHaveURL(shareUrl); // no sign-in redirect
  await expect(g.getByRole("heading", { name: "This link has a password" })).toBeVisible();
  await g.getByLabel("Password").fill("not-it");
  await g.getByRole("button", { name: "Open" }).click();
  await expect(g.locator(".field__error")).toContainText("didn't match");
  await shot(g, "guest-wrong-password");
  await g.getByLabel("Password").fill("bled-2026");
  await g.getByRole("button", { name: "Open" }).click();
  await expect(g.getByRole("heading", { name: "lake.jpg" })).toBeVisible();
  await expect.poll(() => g.locator(".guest__preview img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1600);
  await expect(g.locator(".guest__foot")).toContainText("5 downloads left");
  await shot(g, "guest-viewer");
  // The guest page sends no Referer anywhere.
  const resp = await g.request.get(shareUrl);
  expect(resp.headers()["referrer-policy"]).toBe("no-referrer");
  await ctx.close();
});

const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;
for (const scheme of ["light", "dark"] as const) {
  for (const [device, viewport] of Object.entries(sizes)) {
    test(`screenshots ${device} ${scheme}`, async ({ browser }) => {
      test.skip(!shots);
      const { ctx, page } = await signIn(browser, "alice", process.env.ALICE_PASSWORD!, { viewport, colorScheme: scheme, deviceScaleFactor: device === "phone" ? 2 : 1 });
      await openRow(page, run);
      await openRow(page, "Trip notes");
      await expect(page.locator("tbody tr")).toHaveCount(9);
      await shot(page, `browser-${device}-${scheme}`);
      await page.getByRole("button", { name: "Grid" }).click();
      await expect(page.locator(".tile img").first()).toBeVisible();
      await shot(page, `grid-${device}-${scheme}`);
      await page.getByRole("button", { name: "List" }).click();
      await openFile(page, "lake.jpg");
      await expect(page.locator(".viewer img.viewer-img")).toBeVisible();
      await shot(page, `viewer-image-${device}-${scheme}`);
      await page.keyboard.press("Escape");
      await openFile(page, "itinerary.pdf");
      await expect(page.locator(".pdf-page canvas")).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, `viewer-pdf-${device}-${scheme}`);
      await page.keyboard.press("Escape");
      await openFile(page, "budget.go");
      await expect(page.locator(".code__body")).toBeVisible();
      await shot(page, `viewer-code-${device}-${scheme}`);
      await ctx.close();
    });
  }
}

test("a 2 GiB file uploads through the ingress and downloads intact", async ({ browser }) => {
  test.skip(!bigFile, "set BIG_FILE");
  test.setTimeout(30 * 60_000);
  const size = statSync(bigFile).size;
  const want = await new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(bigFile).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
  const { ctx, page } = await signIn(browser, "alice", process.env.ALICE_PASSWORD!);
  await openRow(page, run);
  const done = page.waitForResponse((r) => r.url().includes("/api/uploads/") && r.request().method() === "PUT" && r.status() === 201, { timeout: 25 * 60_000 });
  const started = Date.now();
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(bigFile);
  const finished = await done;
  const secs = (Date.now() - started) / 1000;
  const body = (await finished.json()) as { node: { id: string; size: number }; sha256: string };
  expect(body.node.size).toBe(size);
  expect(body.sha256).toBe(want);
  console.log(`uploaded ${size} bytes in ${secs.toFixed(0)} s (${(size / secs / 1e6).toFixed(0)} MB/s); server sha256 ${body.sha256}`);
  await expect(page.locator(".tray")).toContainText(/Uploaded/, { timeout: 60_000 });
  // Hand the session cookie and the node id to the shell for a streamed download and checksum.
  const cookies = await ctx.cookies(base);
  const session = cookies.find((c) => c.name === "authelia_session");
  console.log(`BIG_NODE=${body.node.id}`);
  console.log(`BIG_SESSION=${session?.value}`);
  await ctx.close();
});
