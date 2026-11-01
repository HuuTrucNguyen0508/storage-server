import { expect, test } from "./fixtures";
import { createShare, diskFile, fixtureFile, gotoFolder, minimalPdf, row, rowMenu, seed } from "./helpers";
import type { Browser, BrowserContext, Page } from "@playwright/test";

/** A stranger's browser: no owner cookie, and a record of everything it asked for. */
async function guestPage(browser: Browser, like: BrowserContext): Promise<{ page: Page; asked: string[] }> {
  const viewport = like.pages()[0]?.viewportSize() ?? null;
  const context = await browser.newContext({ viewport, hasTouch: (viewport?.width ?? 1280) <= 720 });
  const page = await context.newPage();
  const asked: string[] = [];
  page.on("response", (res) => {
    const url = new URL(res.url());
    asked.push(`${res.status()} ${res.request().method()} ${url.pathname}`);
  });
  return { page, asked };
}

function ownerRoutes(asked: string[]): string[] {
  return asked.filter((line) => {
    const path = line.split(" ")[2] ?? "";
    return (path.startsWith("/api/") && !path.startsWith("/api/public/")) || line.startsWith("404");
  });
}

test("a link with a password: create it, open it as a guest, then revoke it", async ({ ownerPage: page, server, folder, request, browser, context }) => {
  await seed(request, server, `${folder}/trip/notes.txt`, "guest can read this");
  await seed(request, server, `${folder}/trip/inside/deep.txt`, "deeper");
  await gotoFolder(page, server, folder);

  await rowMenu(page, "trip", "Share");
  const sheet = page.getByRole("dialog", { name: "New link" });
  await expect(sheet.getByText("Limit to N downloads")).toBeVisible();
  await sheet.getByLabel("Password").fill("opensesame");
  await sheet.getByRole("button", { name: "30 days" }).click();
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = (await sheet.getByTestId("share-url").textContent()) ?? "";
  expect(url.startsWith(`${server.guest}/s/`)).toBe(true);
  await sheet.getByRole("button", { name: "Done" }).click();

  const { page: guest, asked } = await guestPage(browser, context);
  await guest.goto(url);
  await expect(guest.getByRole("heading", { level: 1, name: "trip" })).toBeVisible();
  await guest.getByLabel("Password").fill("wrong password");
  await guest.getByRole("button", { name: "Open" }).click();
  await expect(guest.getByRole("alert")).toHaveText("That password is not right");
  await expect(guest.getByLabel("Password")).toHaveValue("wrong password");

  await guest.getByLabel("Password").fill("opensesame");
  await guest.getByRole("button", { name: "Open" }).click();
  await expect(guest.getByText(/2 items, .*Shared with you\. This link stops working in \d+ days\./)).toBeVisible();

  await guest.getByRole("button", { name: "notes.txt" }).click();
  await expect(guest.getByRole("dialog", { name: "Preview of notes.txt" }).locator(".doc pre")).toHaveText("guest can read this");
  await guest.keyboard.press("Escape");

  await guest.getByRole("button", { name: "inside", exact: true }).click();
  await expect(guest.getByRole("heading", { level: 1, name: "inside" })).toBeVisible();
  await expect(guest).toHaveURL(/\?path=inside$/);
  await guest.reload();
  await expect(guest.getByRole("button", { name: "deep.txt" })).toBeVisible();

  const download = guest.waitForEvent("download");
  await guest.getByRole("link", { name: "Download deep.txt" }).click();
  expect((await download).suggestedFilename()).toBe("deep.txt");

  await page.goto(`${server.owner}/links`);
  const link = page.locator(`.row[data-link="${folder}/trip"]`);
  await expect(link).toContainText("Live, password");
  await expect(link).toContainText("2 downloads");
  await link.getByRole("button", { name: "Revoke link for trip" }).click();
  await page.getByRole("dialog", { name: "Revoke this link?" }).getByRole("button", { name: "Revoke link" }).click();
  await expect(link).toHaveCount(0);

  await guest.reload();
  await expect(guest.getByRole("heading", { name: "This link no longer works" })).toBeVisible();

  expect(ownerRoutes(asked.filter((l) => !/\/api\/public\/[^ ]+$/.test(l)))).toEqual([]);
});

test("a file link previews a PDF and downloads, and the limit ends it", async ({ ownerPage: page, server, folder, request, browser, context }) => {
  await seed(request, server, `${folder}/form.pdf`, minimalPdf("Guest PDF"));
  const share = await createShare(request, server, { path: `${folder}/form.pdf`, kind: "link", maxUses: 1 });
  void page;
  const { page: guest, asked } = await guestPage(browser, context);
  await guest.goto(share.url);
  await expect(guest.getByRole("heading", { level: 1, name: "form.pdf" })).toBeVisible();
  await guest.getByRole("button", { name: "Preview" }).click();
  const dialog = guest.getByRole("dialog", { name: "Preview of form.pdf" });
  await expect(dialog.locator("canvas")).toHaveCount(1);
  await expect(dialog.getByText("1 page")).toBeVisible();
  await guest.keyboard.press("Escape");

  const second = await guestPage(browser, context);
  await second.page.goto(share.url);
  await expect(second.page.getByRole("heading", { name: "This link no longer works" })).toBeVisible();

  expect(ownerRoutes(asked)).toEqual([]);
});

test("a broken link shows the one page guests need", async ({ server, page }) => {
  await page.goto(`${server.guest}/s/nosuchtoken`);
  await expect(page.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
  await expect(page.getByText("/s/nosuchtoken")).toBeVisible();
});

test("the guest listener serves the guest app and no owner page", async ({ server, request }) => {
  for (const path of ["/", "/files/", "/login"]) expect((await request.get(`${server.guest}${path}`)).status()).toBe(404);
  expect((await request.get(`${server.guest}/s/anything`)).status()).toBe(200);
});

test("a drop link takes files blind and flattens a folder", async ({ server, folder, request, browser, context, page: first }) => {
  await seed(request, server, `${folder}/inbox/secret.txt`, "the guest must not see this");
  const share = await createShare(request, server, { path: `${folder}/inbox`, kind: "drop" });
  void first;
  const { page: guest, asked } = await guestPage(browser, context);
  await guest.goto(share.url);
  await expect(guest.getByRole("heading", { level: 1, name: "inbox" })).toBeVisible();
  await expect(guest.getByText("secret.txt")).toHaveCount(0);

  await guest.getByLabel("Files to send").setInputFiles([fixtureFile("scan-1.txt", "scan one"), fixtureFile("scan-2.txt", "scan two")]);
  await expect(guest.locator('.row[data-state="done"]')).toHaveCount(2);
  await expect(guest.getByText("2 files sent. You can close this tab.")).toBeVisible();
  await expect(guest.getByRole("button", { name: "Add more files" })).toBeVisible();
  expect(diskFile(server, `${folder}/inbox/scan-1.txt`).toString()).toBe("scan one");
  expect(ownerRoutes(asked)).toEqual([]);

  if ((guest.viewportSize()?.width ?? 0) > 720) {
    const client = await guest.context().newCDPSession(guest);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const dir = join(dirname(fixtureFile("x", "")), `tree-${folder}`);
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "deep-file.txt"), "flattened");
    const data = { items: [], files: [dir], dragOperationsMask: 1 };
    const at = { x: 600, y: 300 };
    await client.send("Input.dispatchDragEvent", { type: "dragEnter", ...at, data });
    await client.send("Input.dispatchDragEvent", { type: "dragOver", ...at, data });
    await client.send("Input.dispatchDragEvent", { type: "drop", ...at, data });
    await expect(guest.locator('.row[data-state="done"]')).toHaveCount(3);
    expect(diskFile(server, `${folder}/inbox/deep-file.txt`).toString()).toBe("flattened");
  }
});

test("a link follows a rename, stops in the trash and returns on restore", async ({ ownerPage: page, server, folder, request, browser, context }) => {
  await seed(request, server, `${folder}/doc.txt`, "still here");
  const share = await createShare(request, server, { path: `${folder}/doc.txt`, kind: "link" });
  await gotoFolder(page, server, folder);
  await rowMenu(page, "doc.txt", "Rename");
  await page.getByLabel("New name for doc.txt").fill("renamed.txt");
  await page.getByLabel("New name for doc.txt").press("Enter");
  await expect(await row(page, "renamed.txt")).toBeVisible();

  const { page: guest } = await guestPage(browser, context);
  await guest.goto(share.url);
  await expect(guest.getByRole("heading", { level: 1, name: "renamed.txt" })).toBeVisible();

  await rowMenu(page, "renamed.txt", "Trash");
  await expect(await row(page, "renamed.txt")).toHaveCount(0);
  await page.goto(`${server.owner}/links`);
  await expect(page.locator(`.row[data-link="${folder}/renamed.txt"]`)).toContainText("In trash, link paused");
  await guest.reload();
  await expect(guest.getByRole("heading", { name: "This link no longer works" })).toBeVisible();

  await page.goto(`${server.owner}/trash`);
  await page.getByRole("button", { name: "Restore renamed.txt" }).click();
  await expect(page.locator('.row[data-trash="renamed.txt"]')).toHaveCount(0);
  await guest.reload();
  await expect(guest.getByRole("heading", { level: 1, name: "renamed.txt" })).toBeVisible();
});

