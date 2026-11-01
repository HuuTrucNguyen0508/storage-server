import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createShare, fixtureFile, isPhone, minimalPdf, pseudoRandom, row, seed } from "./helpers";
import { repoRoot } from "./paths";

const OUT = join(repoRoot, "docs/design/ui/production-shots");
const scene = (sky: string, ground: string, sun: string) => `
  <body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" width="600" height="400">
  <defs><linearGradient id="s" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="#dfe6e8"/></linearGradient></defs>
  <rect width="600" height="400" fill="url(#s)"/><circle cx="430" cy="90" r="36" fill="${sun}"/>
  <path d="M0 280 L170 170 L250 230 L330 130 L420 210 L490 170 L600 250 V400 H0Z" fill="${ground}"/></svg></body>`;

async function photo(browser: Browser, sky: string, ground: string, sun: string): Promise<Buffer> {
  const context = await browser.newContext({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  const page = await context.newPage();
  await page.setContent(scene(sky, ground, sun));
  const out = await page.screenshot({ type: "jpeg", quality: 82 });
  await context.close();
  return out;
}

for (const theme of ["light", "dark"] as const) {
  test(`every screen, ${theme}`, async ({ ownerPage: page, server, browser, context }, info) => {
    test.setTimeout(180_000);
    const { request } = context;
    mkdirSync(OUT, { recursive: true });
    const device = isPhone(page) ? "phone" : "desktop";
    const shot = async (p: Page, name: string) => {
      await p.waitForTimeout(350);
      await p.screenshot({ path: join(OUT, `${name}-${device}-${theme}.png`) });
    };
    await page.addInitScript((t) => localStorage.setItem("storage.theme", t), theme);

    const base = `${info.project.name}-${theme}/photos/2026/iceland`;
    const here = `/files/${base.split("/").map(encodeURIComponent).join("/")}`;
    const makers = [
      ["DSC_0401.jpg", "#5b7f99", "#2c3e46", "#f4eccd"],
      ["DSC_0402.jpg", "#a8bbb5", "#4f6a60", "#efe9d7"],
      ["DSC_0406.jpg", "#d8c8a8", "#6f5b45", "#fff2cf"],
      ["DSC_0412.jpg", "#8ca6bd", "#3e5968", "#f2ecd9"],
    ] as const;
    for (const [name, sky, ground, sun] of makers) await seed(request, server, `${base}/${name}`, await photo(browser, sky, ground, sun));
    await request.post(`${server.owner}/api/files/folder`, { data: { path: `${base}/raw` } });
    await request.post(`${server.owner}/api/files/folder`, { data: { path: `${base}/edits` } });
    await seed(request, server, `${base}/iceland-day2.webm`, pseudoRandom(180_000));
    await seed(request, server, `${base}/wind-at-vik.wav`, pseudoRandom(90_000));
    await seed(request, server, `${base}/route-and-permits.pdf`, minimalPdf("Route and permits"));
    await seed(request, server, `${base}/notes.md`, "# Iceland\n\nSkogafoss at **first light**.\n\n- Vik\n- Reynisfjara\n");
    await seed(request, server, `${base}/drone-logs.zip`, pseudoRandom(40_000));

    const empty = `${info.project.name}-${theme}/photos/2027`;
    await request.post(`${server.owner}/api/files/folder`, { data: { path: empty } });

    const folder = await createShare(request, server, { path: base, kind: "link", expiresAt: new Date(Date.now() + 6 * 86_400_000) });
    const secret = await createShare(request, server, { path: `${base}/route-and-permits.pdf`, kind: "link", password: "skogafoss-2026", maxUses: 10 });
    const drop = await createShare(request, server, { path: `${base}/edits`, kind: "drop" });
    await seed(request, server, `${base}/old-site-backup.tar`, pseudoRandom(30_000));
    await createShare(request, server, { path: `${base}/old-site-backup.tar`, kind: "link" });
    const trashed = await request.post(`${server.owner}/api/files/trash`, { data: { paths: [`${base}/old-site-backup.tar`] } });
    expect(trashed.status()).toBe(200);

    // A real in-flight upload held at its second chunk, so the ghost row and tray are the real thing.
    await page.route("**/api/uploads/*", async (route) => {
      const req = route.request();
      if (req.method() === "PATCH" && Number(req.headers()["upload-offset"]) > 0) return route.abort("connectionreset");
      return route.continue();
    });
    await page.goto(`${server.owner}${here}`);
    await expect(await row(page, "notes.md")).toBeVisible();
    await page.getByLabel("Files to upload").setInputFiles(fixtureFile(`${device}-${theme}/timelapse-glacier.webm`, pseudoRandom(70 * 1024 * 1024)));
    await expect.poll(() => page.locator(".row.ghost, .uptray-phone").count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForFunction(() => /"stored":67108864/.test(localStorage.getItem("storage.uploads") ?? ""), undefined, { timeout: 30_000 });
    for (const name of ["DSC_0402.jpg", "DSC_0406.jpg", "DSC_0412.jpg"]) await (await row(page, name)).locator(".sel").click();
    await expect(page.getByRole("toolbar", { name: "Selection" })).toBeVisible();
    await shot(page, "browser");

    await page.getByRole("button", { name: "Clear selection" }).click();
    if (device === "desktop") {
      const client = await context.newCDPSession(page);
      const data = { items: [], files: [fixtureFile(`${device}-${theme}/drop-example.txt`, "x")], dragOperationsMask: 1 };
      const at = { x: 700, y: 420 };
      await client.send("Input.dispatchDragEvent", { type: "dragEnter", ...at, data });
      await client.send("Input.dispatchDragEvent", { type: "dragOver", ...at, data });
      await expect(page.locator(".dropring")).toBeVisible();
      await shot(page, "browser-drop");
      await client.send("Input.dispatchDragEvent", { type: "dragCancel", ...at, data });
    }

    await page.reload();
    await expect(await row(page, "notes.md")).toBeVisible();
    await shot(page, "browser-resume");

    await (await row(page, "DSC_0402.jpg")).getByRole("button", { name: "DSC_0402.jpg", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /Preview/ }).getByText(/\d+ by \d+/)).toBeVisible();
    await shot(page, "preview-image");
    await page.keyboard.press("Escape");
    await (await row(page, "notes.md")).getByRole("button", { name: "notes.md", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Iceland" })).toBeVisible();
    await shot(page, "preview-markdown");
    await page.keyboard.press("Escape");
    await (await row(page, "route-and-permits.pdf")).getByRole("button", { name: "route-and-permits.pdf", exact: true }).click();
    await expect(page.getByText("1 page")).toBeVisible();
    await shot(page, "preview-pdf");
    await page.keyboard.press("Escape");

    await (await row(page, "edits")).hover().catch(() => {});
    await (await row(page, "edits")).getByRole("button", { name: "More for edits" }).click();
    await shot(page, "row-menu");
    await page.locator(".menu:popover-open").getByRole("button", { name: "Share" }).click();
    await expect(page.getByRole("dialog", { name: "New link" })).toBeVisible();
    await shot(page, "share-sheet");
    await page.getByRole("dialog", { name: "New link" }).getByRole("button", { name: "Create link" }).click();
    await expect(page.getByTestId("share-url")).toBeVisible();
    await shot(page, "share-created");
    await page.getByRole("button", { name: "Done" }).click();

    await page.goto(`${server.owner}/links`);
    await expect(page.locator(".row").first()).toBeVisible();
    await shot(page, "links");
    await page.goto(`${server.owner}/trash`);
    await expect(page.locator(".row").first()).toBeVisible();
    await shot(page, "trash");
    await page.goto(`${server.owner}/account`);
    await expect(page.locator(".row").first()).toBeVisible();
    await shot(page, "account");
    await page.goto(`${server.owner}/files/${empty.split("/").map(encodeURIComponent).join("/")}`);
    await expect(page.getByRole("heading", { level: 2, name: "Nothing in 2027 yet" })).toBeVisible();
    await shot(page, "empty-folder");
    await page.getByLabel("Search by name").fill("DSC");
    await page.goto(`${server.owner}/files/${base.split("/").slice(0, 1).join("/")}?q=DSC`);
    await expect(await row(page, "DSC_0412.jpg")).toBeVisible();
    await shot(page, "search");
    await page.unroute("**/api/uploads/*");

    const stranger = await browser.newContext({
      viewport: page.viewportSize(),
      deviceScaleFactor: device === "phone" ? 2 : 1,
      hasTouch: device === "phone",
      isMobile: device === "phone",
      colorScheme: theme,
    });
    const guest = await stranger.newPage();
    await guest.goto(folder.url);
    await expect(guest.getByRole("button", { name: "notes.md" })).toBeVisible();
    await shot(guest, "guest");
    await guest.getByRole("button", { name: "DSC_0406.jpg" }).click();
    await expect(guest.getByText(/\d+ by \d+/)).toBeVisible();
    await shot(guest, "guest-preview");
    await guest.keyboard.press("Escape");
    await expect(guest.getByRole("dialog")).toHaveCount(0);
    await guest.waitForTimeout(100); // closing pops a history entry, which a navigation must not race
    await guest.goto(secret.url);
    await guest.getByLabel("Password").fill("wrong");
    await guest.getByRole("button", { name: "Open" }).click();
    await expect(guest.getByRole("alert")).toBeVisible();
    await shot(guest, "guest-password");
    await guest.goto(drop.url);
    await expect(guest.getByRole("button", { name: "Choose files" })).toBeVisible();
    await shot(guest, "drop");
    await guest.getByLabel("Files to send").setInputFiles([fixtureFile(`${device}-${theme}/passport-scan.pdf`, minimalPdf("x")), fixtureFile(`${device}-${theme}/birth-certificate.jpg`, await photo(browser, "#ccc", "#555", "#eee"))]);
    await expect(guest.locator('.row[data-state="done"]')).toHaveCount(2);
    await shot(guest, "drop-sent");
    await guest.goto(`${server.guest}/s/7fQ2nK9vXw`);
    await expect(guest.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
    await shot(guest, "guest-broken");
    await stranger.close();
  });
}
