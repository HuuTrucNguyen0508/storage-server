import { expect, test } from "./fixtures";
import { createShare, gotoFolder, isPhone, row, seed } from "./helpers";

test.beforeEach(({ page }) => {
  test.skip(isPhone(page), "a phone has no keyboard");
});

test("/ focuses search, and the arrow keys drive the list", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/a.txt`, "a");
  await seed(request, server, `${folder}/b.txt`, "b");
  await seed(request, server, `${folder}/c.txt`, "c");
  await seed(request, server, `${folder}/sub/x.txt`, "x");
  await gotoFolder(page, server, folder);

  await page.keyboard.press("/");
  await expect(page.getByLabel("Search by name")).toBeFocused();

  await (await row(page, "a.txt")).focus();
  await page.keyboard.press("ArrowDown");
  await expect(await row(page, "b.txt")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(await row(page, "b.txt")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toContainText("2 selected");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toHaveCount(0);

  await page.keyboard.press("Control+a");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toContainText("4 selected");
  await page.keyboard.press("Escape");

  await page.keyboard.press("End");
  await expect(await row(page, "sub")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "sub" })).toBeVisible();
  await (await row(page, "x.txt")).focus();
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
});

test("the first Tab into the list lands on the first row", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/a.txt`, "a");
  await seed(request, server, `${folder}/b.txt`, "b");
  await gotoFolder(page, server, folder);
  await page.getByRole("button", { name: "Upload" }).first().focus();
  await page.keyboard.press("Tab");
  await expect(await row(page, "a.txt")).toBeFocused();
  const ring = await (await row(page, "a.txt")).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).toContain("inset");
});

test("F2 renames in place, and Delete offers undo", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/a.txt`, "a");
  await gotoFolder(page, server, folder);
  await (await row(page, "a.txt")).focus();
  await page.keyboard.press("F2");
  const input = page.getByLabel("New name for a.txt");
  await expect(input).toBeFocused();
  await input.fill("z.txt");
  await page.keyboard.press("Enter");
  await expect(await row(page, "z.txt")).toBeVisible();

  await (await row(page, "z.txt")).focus();
  await page.keyboard.press("Delete");
  await expect(await row(page, "z.txt")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(await row(page, "z.txt")).toBeVisible();
});

test("Ctrl-C copies the live link of the one selected item", async ({ ownerPage: page, server, folder, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.owner });
  await seed(request, server, `${folder}/a.txt`, "a");
  const share = await createShare(request, server, { path: `${folder}/a.txt`, kind: "link" });
  await gotoFolder(page, server, folder);
  await (await row(page, "a.txt")).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Control+c");
  await expect(page.getByRole("status")).toContainText("Link copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(share.url);
});

test("shift-click extends and ctrl-click toggles", async ({ ownerPage: page, server, folder, request }) => {
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) await seed(request, server, `${folder}/${name}`, name);
  await gotoFolder(page, server, folder);
  await (await row(page, "a.txt")).locator(".sel").click();
  await (await row(page, "c.txt")).locator(".sel").click({ modifiers: ["Shift"] });
  const bar = page.getByRole("toolbar", { name: "Selection" });
  await expect(bar).toContainText("3 selected");
  await (await row(page, "b.txt")).locator(".cell").first().click({ modifiers: ["Control"] });
  await expect(bar).toContainText("2 selected");
});

test("dragging a row onto a folder moves it", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/a.txt`, "a");
  await seed(request, server, `${folder}/box/keep.txt`, "k");
  await gotoFolder(page, server, folder);
  await (await row(page, "a.txt")).dragTo(await row(page, "box"));
  await expect(await row(page, "a.txt")).toHaveCount(0);
  await (await row(page, "box")).getByRole("link", { name: "box" }).click();
  await expect(await row(page, "a.txt")).toBeVisible();
});
