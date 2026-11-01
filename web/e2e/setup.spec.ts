import { expect, test } from "./fixtures";
import { OWNER_PASSWORD, startServer, type Server } from "./server";

let fresh: Server;

test.beforeAll(async () => {
  fresh = await startServer();
});

test.afterAll(async () => {
  await fresh.stop();
});

test("first run asks for the code from the log, then signing in works", async ({ page }) => {
  await page.goto(`${fresh.owner}/`);
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up this server" })).toBeVisible();

  await page.getByLabel("Setup code").fill("WRONGCODE");
  await page.getByLabel("Owner password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("alert")).toHaveText("That setup code is not right");

  await page.getByLabel("Setup code").fill(await fresh.setupCode());
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/files\/$/);
  await expect(page.getByRole("heading", { level: 2, name: "Nothing in Files yet" })).toBeVisible();

  await page.goto(`${fresh.owner}/account`);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("That password is not right");

  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/files\/$/);
});

test("an owner page without a session goes to sign in", async ({ page }) => {
  await page.goto(`${fresh.owner}/trash`);
  await expect(page).toHaveURL(/\/login$/);
});
