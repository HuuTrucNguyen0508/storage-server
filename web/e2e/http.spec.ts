import { networkInterfaces } from "node:os";
import { expect, test } from "./fixtures";
import { OWNER_PASSWORD, startServer } from "./server";
import { diskFile, fixtureFile } from "./helpers";

test("uploads work on a non-local plain HTTP origin", async ({ browser }) => {
  const address = Object.values(networkInterfaces()).flat().find((n) => n?.family === "IPv4" && !n.internal)?.address;
  if (address === undefined) throw new Error("a non-loopback IPv4 address is required for the LAN upload test");
  const server = await startServer(address);
  const context = await browser.newContext();
  try {
    const setup = await context.request.post(server.owner + "/api/setup", { data: { code: await server.setupCode(), password: OWNER_PASSWORD } });
    expect(setup.status()).toBe(201);
    const page = await context.newPage();
    await page.goto(server.owner + "/files/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    await page.getByLabel("Files to upload").setInputFiles(fixtureFile("lan.txt", "LAN upload bytes"));
    await expect(page.locator('.row[data-path$="lan.txt"]')).toBeVisible();
    expect(diskFile(server, "lan.txt").toString()).toBe("LAN upload bytes");
  } finally {
    await context.close();
    await server.stop();
  }
});
