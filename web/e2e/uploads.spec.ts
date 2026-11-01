import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { diskFile, fixtureFile, gotoFolder, isPhone, pseudoRandom, row, sha256 } from "./helpers";
import { cacheDir } from "./paths";

const CHUNK = 64 * 1024 * 1024;
const big = pseudoRandom(CHUNK + 6 * 1024 * 1024);
const bigHash = sha256(big);

function tray(page: import("@playwright/test").Page) {
  return page.locator(".up").first();
}

async function showTray(page: import("@playwright/test").Page) {
  if (isPhone(page)) await page.locator(".uptray-phone").click();
}

test("an upload resumes from the server's offset after a page reload", async ({ ownerPage: page, server, folder }) => {
  const name = `resume-${folder}.bin`;
  const path = fixtureFile(name, big);
  const offsets: string[] = [];
  let stall = true;
  await page.route("**/api/uploads/*", async (route) => {
    const req = route.request();
    if (req.method() !== "PATCH") return route.continue();
    offsets.push(req.headers()["upload-offset"] ?? "");
    if (stall && Number(req.headers()["upload-offset"]) >= CHUNK) return route.abort("connectionreset");
    return route.continue();
  });

  await gotoFolder(page, server, folder);
  await page.getByLabel("Files to upload").setInputFiles(path);
  await showTray(page);
  await expect(page.locator(`.up[data-state="reconnecting"]`)).toBeVisible({ timeout: 30_000 });
  await expect(tray(page).locator(".s")).toHaveText("Paused at 64.0 MB of 70.0 MB, reconnecting");
  await expect(page.getByRole("progressbar", { name: `${name} stored` }).first()).toHaveAttribute("aria-valuenow", String(CHUNK));

  stall = false;
  await page.unroute("**/api/uploads/*");
  await page.route("**/api/uploads/*", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") offsets.push(req.headers()["upload-offset"] ?? "");
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();

  await showTray(page);
  await expect(page.locator(`.up[data-state="needs-file"]`)).toBeVisible();
  await expect(tray(page).locator(".s")).toHaveText("Pick the file again to continue from 64.0 MB");
  await expect(page.locator(`.row.ghost[data-ghost$="${name}"]`)).toHaveCount(1);

  if (!isPhone(page)) {
    const pick = await page.locator(".btn.pick").boundingBox();
    const rail = await page.locator(".rail").boundingBox();
    if (pick === null || rail === null) throw new Error("no tray");
    expect(pick.x + pick.width).toBeLessThanOrEqual(rail.x + rail.width);
  }

  offsets.length = 0;
  await page.getByLabel(`Pick the file for ${name}`).setInputFiles(path);
  await expect.poll(() => offsets[0], { timeout: 30_000 }).toBe(String(CHUNK));
  if (isPhone(page)) await page.getByRole("button", { name: "Close" }).click();
  await expect(await row(page, name)).toBeVisible({ timeout: 30_000 });
  expect(sha256(diskFile(server, `${folder}/${name}`))).toBe(bigHash);
});

test("picking a different file starts a new upload and says so", async ({ ownerPage: page, server, folder }) => {
  const name = `different-${folder}.bin`;
  const path = fixtureFile(name, big);
  await page.route("**/api/uploads/*", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH" && Number(req.headers()["upload-offset"]) >= CHUNK) return route.abort("connectionreset");
    return route.continue();
  });
  await gotoFolder(page, server, folder);
  await page.getByLabel("Files to upload").setInputFiles(path);
  await showTray(page);
  await expect(page.locator(`.up[data-state="reconnecting"]`)).toBeVisible({ timeout: 30_000 });
  await page.unroute("**/api/uploads/*");
  await page.reload();
  await showTray(page);
  await expect(page.locator(`.up[data-state="needs-file"]`)).toBeVisible();

  const other = fixtureFile("other-file.txt", "a different file");
  await page.getByLabel(`Pick the file for ${name}`).setInputFiles(other);
  if (isPhone(page)) await page.getByRole("button", { name: "Close" }).click();
  await expect(await row(page, "other-file.txt")).toBeVisible();
  expect(diskFile(server, `${folder}/other-file.txt`).toString()).toBe("a different file");
  await expect(await row(page, name)).toHaveCount(0);
});

test("pause and resume keep the stored bytes", async ({ ownerPage: page, server, folder }) => {
  const name = `pause-${folder}.bin`;
  const path = fixtureFile(name, big);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/uploads/*", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH" && Number(req.headers()["upload-offset"]) >= CHUNK) await held;
    await route.continue().catch(() => {});
  });
  await gotoFolder(page, server, folder);
  await page.getByLabel("Files to upload").setInputFiles(path);
  await showTray(page);
  const item = tray(page);
  await expect(item.locator(".s")).toHaveText(/ of 70\.0 MB$/);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("storage.uploads")?.includes('"stored":67108864') ?? false), { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: `Pause ${name}` }).click();
  await expect(item.locator(".s")).toHaveText("Paused at 64.0 MB of 70.0 MB");
  release();
  await page.getByRole("button", { name: `Resume ${name}` }).click();
  if (isPhone(page)) await page.getByRole("button", { name: "Close" }).click();
  await expect(await row(page, name)).toBeVisible({ timeout: 30_000 });
  expect(sha256(diskFile(server, `${folder}/${name}`))).toBe(bigHash);
});

test("a drop link's upload resumes after a reload too", async ({ server, folder, request, browser, page: first }) => {
  void first;
  const name = `guest-${folder}.bin`;
  const path = fixtureFile(name, big);
  await request.post(`${server.owner}/api/files/folder`, { data: { path: `${folder}/inbox` } });
  const res = await request.post(`${server.owner}/api/shares`, { data: { path: `${folder}/inbox`, kind: "drop" } });
  const { url } = (await res.json()) as { url: string };

  const guest = await (await browser.newContext()).newPage();
  const offsets: string[] = [];
  await guest.route("**/api/public/*/uploads/*", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH" && Number(req.headers()["upload-offset"]) >= CHUNK) return route.abort("connectionreset");
    return route.continue();
  });
  await guest.goto(url);
  await guest.getByLabel("Files to send").setInputFiles(path);
  await expect(guest.locator('.row[data-state="reconnecting"]')).toBeVisible({ timeout: 30_000 });

  await guest.unroute("**/api/public/*/uploads/*");
  await guest.route("**/api/public/*/uploads/*", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") offsets.push(req.headers()["upload-offset"] ?? "");
    await route.continue();
  });
  await guest.reload();
  await expect(guest.locator('.row[data-state="needs-file"]')).toContainText("Pick again, 64.0 MB kept");
  await guest.getByLabel(`Pick the file for ${name}`).setInputFiles(path);
  await expect(guest.locator('.row[data-state="done"]')).toBeVisible({ timeout: 30_000 });
  expect(offsets[0]).toBe(String(CHUNK));
  expect(sha256(diskFile(server, `${folder}/inbox/${name}`))).toBe(bigHash);
  await guest.context().close();
});

test("a dropped folder keeps its structure, including an empty folder", async ({ ownerPage: page, server, folder }) => {
  test.skip(isPhone(page), "a phone has no drag source");
  const source = join(cacheDir, `drop-${folder}`);
  rmSync(source, { recursive: true, force: true });
  mkdirSync(join(source, "album", "day 1"), { recursive: true });
  mkdirSync(join(source, "album", "empty"), { recursive: true });
  writeFileSync(join(source, "album", "cover.txt"), "cover");
  writeFileSync(join(source, "album", "day 1", "photo.txt"), "photo");

  await gotoFolder(page, server, folder);
  await expect(page.getByRole("heading", { level: 2, name: `Nothing in ${folder} yet` })).toBeVisible();
  const client = await page.context().newCDPSession(page);
  const data = { items: [], files: [join(source, "album")], dragOperationsMask: 1 };
  const at = { x: 700, y: 400 };
  await client.send("Input.dispatchDragEvent", { type: "dragEnter", ...at, data });
  await client.send("Input.dispatchDragEvent", { type: "dragOver", ...at, data });
  await expect(page.locator(".dropring")).toHaveText(`Drop to upload into ${folder}`);
  await page.screenshot({ path: join(cacheDir, "drop-ring.png") });
  await client.send("Input.dispatchDragEvent", { type: "drop", ...at, data });

  await expect(await row(page, "album")).toBeVisible();
  await expect.poll(() => (existsSync(join(server.root, `${folder}/album/day 1/photo.txt`)) ? diskFile(server, `${folder}/album/day 1/photo.txt`).toString() : ""), { timeout: 10_000 }).toBe("photo");
  expect(diskFile(server, `${folder}/album/cover.txt`).toString()).toBe("cover");
  await (await row(page, "album")).getByRole("link", { name: "album" }).click();
  await expect(await row(page, "empty")).toBeVisible();
  rmSync(source, { recursive: true, force: true });
});
