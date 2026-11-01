import { expect, test } from "./fixtures";
import { OWNER_PASSWORD } from "./server";
import { diskFile, fixtureFile } from "./helpers";

test("uploads work on a non-local plain HTTP origin", async ({ browser, server, folder }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const origin = "http://storage.test";
    await page.route(origin + "/**", async (route) => {
      const response = await route.fetch({ url: route.request().url().replace(origin, server.owner), headers: { ...route.request().headers(), origin: server.owner } });
      await route.fulfill({ response });
    });
    await page.goto(origin + "/login");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    await page.getByLabel("Password", { exact: true }).fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto(origin + "/files/" + folder);
    await page.getByLabel("Files to upload").setInputFiles(fixtureFile("lan.txt", "LAN upload bytes"));
    await expect(page.locator('.row[data-path$="lan.txt"]')).toBeVisible();
    expect(diskFile(server, folder + "/lan.txt").toString()).toBe("LAN upload bytes");
  } finally {
    await context.close();
  }
});
