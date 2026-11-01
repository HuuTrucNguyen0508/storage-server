import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createShare, gotoFolder, row, seed } from "./helpers";

const SCRIPT = `
  localStorage.setItem("pwned", location.origin);
  document.title = "PWNED";
  fetch("/api/files/trash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: ["victim.txt"] }) });
`;
const HTML = `<!doctype html><html><head><title>evil</title></head><body><h1 id="evil">evil</h1><script>${SCRIPT}</script><img src=x onerror="localStorage.setItem('pwned', 'img')"></body></html>`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>${SCRIPT}</script><rect width="40" height="40" fill="red" onload="localStorage.setItem('pwned', 'svg')"/></svg>`;

async function pwned(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("pwned"));
}

test("the payloads really run when nothing protects them", async ({ page, server }) => {
  await page.route("**/control-case.html", (route) => route.fulfill({ contentType: "text/html", body: HTML.replace('fetch("/api/files/trash"', 'void ("/api/files/trash"') }));
  await page.goto(`${server.guest}/s/control`);
  await page.goto(`${server.guest}/control-case.html`);
  await expect.poll(() => pwned(page)).not.toBe(null);
  await page.evaluate(() => localStorage.clear());
});

test("a hostile HTML and SVG upload never script the app origin as the owner", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/evil.html`, HTML);
  await seed(request, server, `${folder}/evil.svg`, SVG);
  await seed(request, server, `${folder}/victim.txt`, "still here");
  await gotoFolder(page, server, folder);

  await (await row(page, "evil.html")).getByRole("button", { name: "evil.html", exact: true }).click();
  const html = page.getByRole("dialog", { name: "Preview of evil.html" });
  await expect(html.locator(".doc pre")).toContainText("<script>");
  await expect(html.locator("h1#evil, script")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await (await row(page, "evil.svg")).getByRole("button", { name: "evil.svg", exact: true }).click();
  const svg = page.getByRole("dialog", { name: "Preview of evil.svg" });
  await expect.poll(() => svg.locator("img").evaluate((img: HTMLImageElement) => img.complete)).toBe(true);
  await page.keyboard.press("Escape");

  expect(await pwned(page)).toBe(null);
  await expect(page).not.toHaveTitle("PWNED");

  for (const name of ["evil.html", "evil.svg"]) {
    const url = `${server.owner}/api/files/content?path=${encodeURIComponent(`${folder}/${name}`)}`;
    const res = await page.goto(url).catch(() => null);
    if (res !== null) {
      expect(res.headers()["content-security-policy"]).toContain("sandbox");
      expect(await page.title()).not.toBe("PWNED");
    }
    await page.waitForTimeout(150);
  }

  await page.goto(`${server.owner}/files/${folder}`);
  await expect(await row(page, "victim.txt")).toBeVisible();
  expect(await pwned(page)).toBe(null);
});

test("the same files stay inert for a guest on the guest origin", async ({ server, folder, request, page }) => {
  await seed(request, server, `${folder}/box/evil.html`, HTML);
  await seed(request, server, `${folder}/box/evil.svg`, SVG);
  const share = await createShare(request, server, { path: `${folder}/box`, kind: "link" });
  await page.goto(share.url);
  await page.getByRole("button", { name: "evil.html" }).click();
  await expect(page.getByRole("dialog", { name: "Preview of evil.html" }).locator(".doc pre")).toContainText("<script>");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "evil.svg" }).click();
  await expect.poll(() => page.locator("dialog img").evaluate((img: HTMLImageElement) => img.complete)).toBe(true);
  await page.keyboard.press("Escape");
  expect(await pwned(page)).toBe(null);
  await page.reload();
  expect(await pwned(page)).toBe(null);
});
