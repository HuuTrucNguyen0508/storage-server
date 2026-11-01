import { expect, test } from "./fixtures";
import { OWNER_PASSWORD, startServer, type Server } from "./server";

let fresh: Server;

test.beforeAll(async () => {
  fresh = await startServer();
  await fetch(`${fresh.owner}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: fresh.owner },
    body: JSON.stringify({ code: await fresh.setupCode(), password: OWNER_PASSWORD }),
  });
});

test.afterAll(async () => {
  await fresh.stop();
});

test("sessions can be listed and revoked, and changing the password signs out the rest", async ({ browser, page, context }) => {
  await context.request.post(`${fresh.owner}/api/login`, { data: { password: OWNER_PASSWORD } });
  const other = await browser.newContext();
  const third = await browser.newContext();
  const login = { password: OWNER_PASSWORD };
  await other.request.post(`${fresh.owner}/api/login`, { data: login, headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) Chrome/140.0.0.0 Mobile" } });
  await third.request.post(`${fresh.owner}/api/login`, { data: login, headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0" } });

  await page.goto(`${fresh.owner}/account`);
  await expect(page.locator('.row[data-session="current"]')).toContainText("this device");
  await expect(page.getByText("Chrome on Android")).toBeVisible();

  await page.getByRole("button", { name: "Sign out Chrome on Android" }).click();
  await page.getByRole("dialog", { name: "Sign out this device?" }).getByRole("button", { name: "Sign out device" }).click();
  await expect(page.getByText("Chrome on Android")).toHaveCount(0);
  expect((await other.request.get(`${fresh.owner}/api/files`)).status()).toBe(401);

  await page.getByLabel("Current password").fill("not it at all");
  await page.getByLabel("New password").fill("a new good password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toHaveText("That password is not right");

  await page.getByLabel("Current password").fill(OWNER_PASSWORD);
  await page.getByLabel("New password").fill("short");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toHaveText("Use at least 8 characters");

  await page.getByLabel("New password").fill("a new good password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toContainText("Password changed");
  await expect(page.getByText("Firefox on Linux")).toHaveCount(0);
  expect((await third.request.get(`${fresh.owner}/api/files`)).status()).toBe(401);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await context.request.post(`${fresh.owner}/api/account/password`, { data: { current: "a new good password", new: OWNER_PASSWORD } });
  await other.close();
  await third.close();
});
