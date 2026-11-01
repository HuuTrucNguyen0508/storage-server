import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { gotoFolder, isPhone, minimalPdf, row, seed } from "./helpers";
import { webDir } from "./paths";

const asset = (name: string) => readFileSync(join(webDir, "e2e/assets", name));

async function open(page: import("@playwright/test").Page, name: string) {
  await (await row(page, name)).getByRole("button", { name, exact: true }).click();
  return page.getByRole("dialog", { name: `Preview of ${name}` });
}

test("an image shows with its size, and a thumbnail shows in the list", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/photo.jpg`, asset("photo.jpg"));
  await gotoFolder(page, server, folder);
  const thumb = (await row(page, "photo.jpg")).locator("img.thumb");
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const dialog = await open(page, "photo.jpg");
  await expect(dialog.getByText("320 by 214")).toBeVisible();
  await expect.poll(() => dialog.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
});

test("a video plays through native controls and seeks by range", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/clip.webm`, asset("clip.webm"));
  await gotoFolder(page, server, folder);
  const dialog = await open(page, "clip.webm");
  await expect(dialog.getByText("160 by 120")).toBeVisible();
  const seeked = await dialog.locator("video").evaluate(
    (v: HTMLVideoElement) =>
      new Promise<number>((resolve) => {
        v.addEventListener("seeked", () => resolve(v.currentTime), { once: true });
        v.currentTime = 0.5;
      }),
  );
  expect(seeked).toBe(0.5);
  const ranged = await page.evaluate(async () => {
    const entry = performance.getEntriesByType("resource").find((e) => e.name.includes("clip.webm")) as PerformanceResourceTiming;
    const res = await fetch(entry.name, { headers: { Range: "bytes=10-19" } });
    return { status: res.status, length: (await res.arrayBuffer()).byteLength };
  });
  expect(ranged).toEqual({ status: 206, length: 10 });
});

test("audio plays through native controls", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/tone.wav`, asset("tone.wav"));
  await gotoFolder(page, server, folder);
  const dialog = await open(page, "tone.wav");
  await expect.poll(() => dialog.locator("audio").evaluate((a: HTMLAudioElement) => a.duration)).toBeCloseTo(1, 0);
});

test("a PDF draws on a canvas, never in a frame", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/route.pdf`, minimalPdf("Hello PDF"));
  await gotoFolder(page, server, folder);
  const dialog = await open(page, "route.pdf");
  await expect(dialog.getByText("1 page")).toBeVisible();
  const canvas = dialog.locator("canvas");
  await expect(canvas).toHaveCount(1);
  await expect
    .poll(() =>
      canvas.evaluate((c: HTMLCanvasElement) => {
        const ctx = c.getContext("2d");
        if (ctx === null || c.width === 0) return 0;
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 128 && (data[i + 3] ?? 0) > 128) dark += 1;
        return dark;
      }),
    )
    .toBeGreaterThan(100);
  await expect(page.locator("iframe:not(#download-frame), embed, object")).toHaveCount(0);
});

test("text shows as written", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/log.txt`, "line one\n<b>not bold</b>");
  await gotoFolder(page, server, folder);
  const dialog = await open(page, "log.txt");
  await expect(dialog.locator(".doc pre")).toHaveText("line one\n<b>not bold</b>");
  await expect(dialog.locator(".doc b")).toHaveCount(0);
});

test("Markdown renders, and raw HTML in it stays text", async ({ ownerPage: page, server, folder, request }) => {
  const source = "# Notes\n\nSome **bold** word.\n\n<script>window.__ran = 1</script>\n\n<img src=x onerror=\"window.__ran = 1\">\n\n[bad](javascript:window.__ran=1)\n";
  await seed(request, server, `${folder}/notes.md`, source);
  await gotoFolder(page, server, folder);
  const dialog = await open(page, "notes.md");
  await expect(dialog.getByRole("heading", { name: "Notes" })).toBeVisible();
  await expect(dialog.locator("strong")).toHaveText("bold");
  await expect(dialog.getByText("<script>window.__ran = 1</script>")).toBeVisible();
  await expect(dialog.locator("script, img")).toHaveCount(0);
  await expect(dialog.locator(".doc a")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBe(undefined);
});

test("moving through files, closing returns focus to the row", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/a.txt`, "first");
  await seed(request, server, `${folder}/b.txt`, "second");
  await seed(request, server, `${folder}/data.bin`, "skipped");
  await gotoFolder(page, server, folder);
  if (!isPhone(page)) await (await row(page, "a.txt")).focus();
  await (await row(page, "a.txt")).getByRole("button", { name: "a.txt", exact: true }).click();
  const a = page.getByRole("dialog", { name: "Preview of a.txt" });
  await expect(a.locator(".doc pre")).toHaveText("first");
  await expect(a.getByText("1 of 2")).toBeVisible();
  if (isPhone(page)) {
    const client = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) =>
      client.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: 500 }] });
    await touch("touchStart", 320);
    await touch("touchMove", 220);
    await touch("touchMove", 120);
    await touch("touchEnd", 120);
  } else {
    await page.keyboard.press("ArrowRight");
  }
  await expect(page.getByRole("dialog", { name: "Preview of b.txt" }).locator(".doc pre")).toHaveText("second");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  if (!isPhone(page)) await expect(page.locator(".row button.t", { hasText: "a.txt" })).toBeFocused();
});

test("a file with no preview downloads instead", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/data.bin`, "bytes");
  await gotoFolder(page, server, folder);
  const download = page.waitForEvent("download");
  await (await row(page, "data.bin")).getByRole("button", { name: "data.bin", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("data.bin");
});
