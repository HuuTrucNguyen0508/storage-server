import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createShare, gotoFolder, isPhone, row, seed } from "./helpers";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { webDir } from "./paths";

interface Failure {
  text: string;
  fg: string;
  bg: string;
  ratio: number;
}

async function contrastFailures(page: Page): Promise<Failure[]> {
  await page.waitForTimeout(250); // buttons fade between states, and a mid-fade colour is not a real pair
  return page.evaluate(() => {
    const canvas = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
    const rgba = (css: string): [number, number, number, number] => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = "#000";
      canvas.fillStyle = css;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return [r ?? 0, g ?? 0, b ?? 0, (a ?? 0) / 255];
    };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => (top[i] ?? 0) * (top[3] ?? 1) + (under[i] ?? 0) * (1 - (top[3] ?? 1)));
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0);
    };
    const backdrop = (el: Element | null): number[] => {
      const layers: number[][] = [];
      for (let at = el; at !== null; at = at.parentElement) {
        const c = rgba(getComputedStyle(at).backgroundColor);
        const alpha = c[3];
        if (getComputedStyle(at).backgroundColor !== "rgba(0, 0, 0, 0)") layers.push(c);
        if (alpha === 1) break;
      }
      return layers.reduceRight((under, top) => over(top, under), [255, 255, 255]);
    };
    const failures: Failure[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      const el = node.parentElement;
      if (text === "" || el === null || el.closest(".sr, :disabled, [hidden]") !== null) continue;
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      if (el.checkVisibility?.() === false || el.getClientRects().length === 0) continue;
      const style = getComputedStyle(el);
      const bg = backdrop(el);
      const fg = over(rgba(style.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      const ratio = (hi + 0.05) / (lo + 0.05);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.push({ text: text.slice(0, 40), fg: fg.join(","), bg: bg.join(","), ratio: Math.round(ratio * 100) / 100 });
    }
    return failures;
  });
}

async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("a, button, input:not(.sr), label.btn, .row .sel, [role=checkbox]")) {
      if (el.closest("[hidden], .sr") !== null || el.getClientRects().length === 0) continue;
      if (el.matches(".row button.t, .row a.t, .cb, .sel .cb")) continue;
      if (el.matches(".field input")) continue;
      const box = el.getBoundingClientRect();
      if (box.height < 43.5 || box.width < 43.5) out.push(`${el.tagName}.${el.className} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return out;
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`contrast passes AA on every screen, ${theme}`, async ({ ownerPage: page, server, folder, request, browser }) => {
    await seed(request, server, `${folder}/sub/a.txt`, "a");
    await seed(request, server, `${folder}/b.txt`, "b");
    await seed(request, server, `${folder}/trash-me.txt`, "t");
    await request.post(`${server.owner}/api/files/trash`, { data: { paths: [`${folder}/trash-me.txt`] } });
    const share = await createShare(request, server, { path: `${folder}/sub`, kind: "link" });
    const drop = await createShare(request, server, { path: `${folder}/sub`, kind: "drop" });
    await page.addInitScript((t) => localStorage.setItem("storage.theme", t), theme);

    await gotoFolder(page, server, folder);
    await (await row(page, "b.txt")).locator(".sel").click();
    await expect(page.getByRole("toolbar", { name: "Selection" })).toBeVisible();
    expect(await contrastFailures(page)).toEqual([]);
    await page.getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: "Share" }).click();
    await expect(page.getByRole("dialog", { name: "New link" })).toBeVisible();
    expect(await contrastFailures(page)).toEqual([]);
    await page.keyboard.press("Escape");

    await page.goto(`${server.owner}/links`);
    await expect(page.locator(".row").first()).toBeVisible();
    expect(await contrastFailures(page)).toEqual([]);

    await page.goto(`${server.owner}/trash`);
    await expect(page.locator(".row").first()).toBeVisible();
    expect(await contrastFailures(page)).toEqual([]);

    await page.goto(`${server.owner}/account`);
    await expect(page.locator(".row").first()).toBeVisible();
    expect(await contrastFailures(page)).toEqual([]);

    const guest = await (await browser.newContext({ colorScheme: theme })).newPage();
    await guest.goto(share.url);
    await expect(guest.getByRole("button", { name: "a.txt" })).toBeVisible();
    expect(await contrastFailures(guest)).toEqual([]);
    await guest.goto(drop.url);
    await expect(guest.getByRole("button", { name: "Choose files" })).toBeVisible();
    expect(await contrastFailures(guest)).toEqual([]);
    await guest.context().close();
  });
}

test("no stylesheet pairs --ink-3 with a hover or a surface-2 fill", () => {
  const dir = join(webDir, "src");
  const css = [join(dir, "styles.css"), join(dir, "owner/owner.css"), join(dir, "guest/guest.css")];
  const rules = css.flatMap((file) => readFileSync(file, "utf8").match(/[^{}]+\{[^{}]*\}/g) ?? []);
  const offenders = rules.filter((rule) => rule.includes("--ink-3") && (rule.split("{")[0]?.includes(":hover") || rule.includes("--surface-2")));
  const uses = rules.filter((rule) => rule.includes("--ink-3"));
  expect(uses.length).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
  expect(readdirSync(join(webDir, "e2e")).length).toBeGreaterThan(0);
});

test("phone touch targets are at least 44 px", async ({ ownerPage: page, server, folder, request, browser }) => {
  test.skip(!isPhone(page), "phone only");
  await seed(request, server, `${folder}/sub/a.txt`, "a");
  await seed(request, server, `${folder}/b.txt`, "b");
  const share = await createShare(request, server, { path: `${folder}/sub`, kind: "link" });
  await gotoFolder(page, server, folder);
  await expect(await smallTargets(page)).toEqual([]);

  await (await row(page, "b.txt")).locator(".sel").click();
  await expect(page.getByRole("toolbar", { name: "Selection" })).toBeVisible();
  await expect(await smallTargets(page)).toEqual([]);
  await page.getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("dialog", { name: "New link" })).toBeVisible();
  await expect(await smallTargets(page)).toEqual([]);
  await page.keyboard.press("Escape");

  await page.goto(`${server.owner}/links`);
  await expect(page.locator(".row").first()).toBeVisible();
  await expect(await smallTargets(page)).toEqual([]);

  const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  await guest.goto(share.url);
  await expect(guest.getByRole("button", { name: "a.txt" })).toBeVisible();
  expect(await smallTargets(guest)).toEqual([]);
  await guest.context().close();
});

test("reduced motion stops the stripes and the selection bar's rise", async ({ server, folder, request, browser }) => {
  await seed(request, server, `${folder}/b.txt`, "b");
  const context = await browser.newContext({ reducedMotion: "reduce" });
  await context.request.post(`${server.owner}/api/login`, { data: { password: "correct horse battery" } });
  const page = await context.newPage();
  await gotoFolder(page, server, folder);
  await (await row(page, "b.txt")).locator(".sel").click();
  const bar = page.getByRole("toolbar", { name: "Selection" });
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  const motion = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bar";
    probe.innerHTML = '<div class="flight"></div>';
    document.body.append(probe);
    const name = getComputedStyle(probe.firstElementChild as Element).animationName;
    probe.remove();
    return { stripes: name, base: getComputedStyle(document.documentElement).getPropertyValue("--dur-base").trim() };
  });
  expect(motion.stripes).toBe("none");
  expect(motion.base).toMatch(/^0m?s$/);
  await context.close();
});

test("the keyboard focus ring shows on a control", async ({ ownerPage: page, server, folder }) => {
  test.skip(isPhone(page), "a phone has no keyboard");
  await gotoFolder(page, server, folder);
  await page.getByLabel("Search by name").focus();
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow);
  expect(ring).toMatch(/rgb.* 0px 0px 0px 2px.*rgb.* 0px 0px 0px 4px/);
});

test("the guest bundle stays apart from the owner's", () => {
  const assets = readdirSync(join(webDir, "dist/assets")).filter((f) => f.endsWith(".js"));
  const named = (prefix: string) => assets.filter((f) => f.startsWith(prefix));
  expect(named("GuestApp-")).toHaveLength(1);
  expect(named("OwnerApp-")).toHaveLength(1);
  const guest = readFileSync(join(webDir, "dist/assets", named("GuestApp-")[0] as string), "utf8");
  expect(guest).not.toContain("Empty trash");
  expect(guest).toContain("This link no longer works");
});
