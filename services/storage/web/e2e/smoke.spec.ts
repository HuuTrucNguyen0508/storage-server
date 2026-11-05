import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Smoke test of the browser and viewer against a locally running binary in
// AUTH_MODE=dev (signed in as DEV_USER). FIXTURES is the folder made by
// e2e/fixtures.py; SHOTS (optional) is where screenshots go.
const fixtures = process.env.FIXTURES ?? "";
const shots = process.env.SHOTS ?? "";
if (shots) mkdirSync(shots, { recursive: true });

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function openFile(page: Page, name: string) {
  await page.locator("tr", { hasText: name }).first().dblclick();
  await expect(page.locator(".viewer .viewer__title")).toContainText(name);
}

test.describe.configure({ mode: "serial" });

test("upload a folder and open every kind of file in the viewer", async ({ page }) => {
  test.skip(!fixtures, "set FIXTURES to the folder made by e2e/fixtures.py");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  await page.locator("input[webkitdirectory]").setInputFiles(path.join(fixtures, "Trip notes"));
  await expect(page.locator(".tray")).toContainText(/Uploaded 9 files/, { timeout: 60_000 });
  await page.locator("tr", { hasText: "Trip notes" }).locator("a").click();
  await expect(page.locator("h1.crumbs__here")).toHaveText("Trip notes");
  await expect(page.locator("tbody tr")).toHaveCount(9);

  await openFile(page, "lake.jpg");
  const img = page.locator(".viewer img.viewer-img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1600);
  await page.keyboard.press("+");
  await expect(img).toHaveClass(/is-zoomed/);
  await page.keyboard.press("0");

  // Next and previous follow the folder's order.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".viewer .viewer__title")).toContainText("maps.zip");
  await expect(page.locator(".viewer")).toContainText("maps/bled.txt");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".viewer .viewer__title")).toContainText("lake.jpg");
  await page.keyboard.press("Escape");
  await expect(page.locator(".viewer")).toHaveCount(0);

  await openFile(page, "itinerary.pdf");
  await expect(page.locator(".pdf-page canvas")).toBeVisible();
  await expect(page.locator(".pdf-pager")).toContainText("of 2");
  await page.getByLabel("Find in document").fill("Bohinj");
  await page.getByLabel("Find in document").press("Enter");
  await expect(page.getByLabel("Page number")).toHaveValue("2");
  await expect(page.locator(".textLayer span.is-match").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await openFile(page, "packing list.md");
  await expect(page.locator(".viewer article.prose h1")).toHaveText("Packing list");
  await expect(page.locator(".viewer article.prose")).toContainText('<script>alert("this stays text")</script>');
  expect(await page.locator(".viewer article.prose script").count()).toBe(0);
  await expect(page.locator(".viewer article.prose table")).toContainText("Stove");
  await page.keyboard.press("Escape");

  await openFile(page, "budget.go");
  await expect(page.locator(".code__body")).toContainText("func Budget(nights int");
  await expect(page.locator(".code__body .hljs-keyword").first()).toBeVisible();
  await expect(page.locator(".code__gutter")).toContainText("9");
  await page.keyboard.press("Escape");

  await openFile(page, "drone.mp4");
  const video = page.locator(".viewer video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v: HTMLVideoElement) => Math.round(v.duration))).toBe(4);
  // Seeking needs Range requests.
  await video.evaluate((v: HTMLVideoElement) => (v.currentTime = 3));
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(2.5);
  await page.keyboard.press("Escape");

  await openFile(page, "expenses.csv");
  await expect(page.locator(".viewer table")).toContainText("hostel");
  await page.keyboard.press("Escape");

  await openFile(page, "route.json");
  await expect(page.locator(".code__body")).toContainText('"stops": [');
  await page.keyboard.press("Escape");

  await openFile(page, "thank you letter.docx");
  // Converted through Stirling PDF in the cluster; without it, the download fallback.
  await expect(page.locator(".viewer .pdf-page canvas, .viewer .viewer-fallback")).toBeVisible({ timeout: 90_000 });
  await page.keyboard.press("Escape");

  expect(errors).toEqual([]);
});

test("a password link works for a guest without an account", async ({ page, browser }) => {
  test.skip(!fixtures, "needs the uploaded folder");
  await page.goto("/");
  await page.locator("tr", { hasText: "Trip notes" }).locator("a").click();
  await page.locator("tr", { hasText: "lake.jpg" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: /Share lake.jpg/ });
  await dialog.getByLabel("Password").fill("bled-2026");
  await dialog.getByRole("button", { name: "Create link" }).click();
  const url = await dialog.getByLabel("New link").inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole("button", { name: "Done" }).click();

  const guest = await browser.newContext();
  const g = await guest.newPage();
  await g.goto(new URL(url).pathname);
  await expect(g.getByRole("heading", { name: "This link has a password" })).toBeVisible();
  await g.getByLabel("Password").fill("wrong");
  await g.getByRole("button", { name: "Open" }).click();
  await expect(g.locator(".field__error")).toContainText("didn't match");
  await g.getByLabel("Password").fill("bled-2026");
  await g.getByRole("button", { name: "Open" }).click();
  await expect(g.getByRole("heading", { name: "lake.jpg" })).toBeVisible();
  await expect(g.locator(".guest__preview img")).toBeVisible();
  await guest.close();
});

const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;

for (const scheme of ["light", "dark"] as const) {
  for (const [device, viewport] of Object.entries(sizes)) {
    test(`screenshots ${device} ${scheme}`, async ({ browser }) => {
      test.skip(!fixtures || !shots, "set FIXTURES and SHOTS");
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: device === "phone" ? 2 : 1 });
      const page = await ctx.newPage();
      await page.goto("/");
      await page.locator("tr", { hasText: "Trip notes" }).locator("a").click();
      await expect(page.locator("tbody tr")).toHaveCount(9);
      await shot(page, `local-browser-${device}-${scheme}`);
      await openFile(page, "lake.jpg");
      await expect(page.locator(".viewer img.viewer-img")).toBeVisible();
      await shot(page, `local-viewer-image-${device}-${scheme}`);
      await page.keyboard.press("Escape");
      await openFile(page, "packing list.md");
      await expect(page.locator(".viewer article.prose h1")).toBeVisible();
      await shot(page, `local-viewer-markdown-${device}-${scheme}`);
      await ctx.close();
    });
  }
}
