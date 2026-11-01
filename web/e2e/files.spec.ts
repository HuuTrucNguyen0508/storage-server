import { expect, test } from "./fixtures";
import { diskFile, fixtureFile, gotoFolder, isPhone, row, rowMenu, seed } from "./helpers";
import { existsSync } from "node:fs";
import { join } from "node:path";

test("upload a file with the button and browse into a folder", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/inner/already.txt`, "kept");
  await gotoFolder(page, server, folder);
  await page.getByLabel("Files to upload").setInputFiles(fixtureFile("hello there.txt", "hello"));
  await expect(await row(page, "hello there.txt")).toBeVisible();
  await expect(page.getByTestId("folder-meta")).toHaveText("2 items, 5 B");
  expect(diskFile(server, `${folder}/hello there.txt`).toString()).toBe("hello");

  await (await row(page, "inner")).getByRole("link", { name: "inner" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "inner" })).toBeVisible();
  await expect(await row(page, "already.txt")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
});

test("create, rename and move", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/draft.txt`, "words");
  await gotoFolder(page, server, folder);

  await page.getByRole("button", { name: "New folder" }).first().click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("archive");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(await row(page, "archive")).toBeVisible();

  await rowMenu(page, "draft.txt", "Rename");
  const input = page.getByLabel("New name for draft.txt");
  await input.fill("final.txt");
  await input.press("Enter");
  await expect(await row(page, "final.txt")).toBeVisible();
  expect(existsSync(join(server.root, folder, "draft.txt"))).toBe(false);

  await rowMenu(page, "final.txt", "Move");
  const sheet = page.getByRole("dialog", { name: "Move" });
  await sheet.getByRole("button", { name: "archive" }).click();
  await sheet.getByRole("button", { name: "Move here" }).click();
  await expect(await row(page, "final.txt")).toHaveCount(0);
  expect(diskFile(server, `${folder}/archive/final.txt`).toString()).toBe("words");
});

test("trash, undo, restore and delete forever", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/a.txt`, "a");
  await seed(request, server, `${folder}/b.txt`, "b");
  await gotoFolder(page, server, folder);

  await rowMenu(page, "a.txt", "Trash");
  await expect(await row(page, "a.txt")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(await row(page, "a.txt")).toBeVisible();
  expect(diskFile(server, `${folder}/a.txt`).toString()).toBe("a");

  await rowMenu(page, "a.txt", "Trash");
  await expect(await row(page, "a.txt")).toHaveCount(0);
  await rowMenu(page, "b.txt", "Trash");
  await expect(await row(page, "b.txt")).toHaveCount(0);

  await page.goto(`${server.owner}/trash`);
  await page.getByRole("button", { name: "Restore a.txt" }).click();
  await expect(page.locator('.row[data-trash="a.txt"]')).toHaveCount(0);
  expect(diskFile(server, `${folder}/a.txt`).toString()).toBe("a");

  await page.getByRole("button", { name: "Delete b.txt forever" }).click();
  await page.getByRole("dialog", { name: "Delete forever?" }).getByRole("button", { name: "Delete forever" }).click();
  await expect(page.locator('.row[data-trash="b.txt"]')).toHaveCount(0);
  expect(existsSync(join(server.root, folder, "b.txt"))).toBe(false);
});

test("select several and download them as a zip", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/one.txt`, "1");
  await seed(request, server, `${folder}/two.txt`, "2");
  await gotoFolder(page, server, folder);
  const check = async (name: string) => (await row(page, name)).locator(".sel").click();
  await check("one.txt");
  await check("two.txt");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toContainText("2 selected");
  const started = page.waitForResponse((r) => r.url().endsWith("/api/files/zip"));
  await page.getByRole("button", { name: "Download zip" }).click();
  const res = await started;
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/zip");
});

test("the selection bar is opaque, and Share needs one item", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/one.txt`, "1");
  await seed(request, server, `${folder}/two.txt`, "2");
  await gotoFolder(page, server, folder);
  await (await row(page, "one.txt")).locator(".sel").click();
  await (await row(page, "two.txt")).locator(".sel").click();
  const bar = page.getByRole("toolbar", { name: "Selection" });
  await expect(bar.getByRole("button", { name: "Share" })).toBeDisabled();
  const paint = await bar.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, opacity: style.opacity };
  });
  expect(paint.opacity).toBe("1");
  expect(paint.background).toMatch(/^rgb\(/);
});

test("a long press selects on touch, a tap then toggles, and back leaves", async ({ ownerPage: page, server, folder, request }) => {
  test.skip(!isPhone(page), "touch only");
  await seed(request, server, `${folder}/one.txt`, "1");
  await seed(request, server, `${folder}/two.txt`, "2");
  await seed(request, server, `${folder}/three.txt`, "3");
  await gotoFolder(page, server, folder);

  const box = await (await row(page, "one.txt")).boundingBox();
  if (box === null) throw new Error("no row");
  const client = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(600);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  const bar = page.getByRole("toolbar", { name: "Selection" });
  await expect(bar).toContainText("1 selected");
  expect((await (await row(page, "one.txt")).boundingBox())?.y).toBe(box.y);
  await expect(page.locator(".tabs")).toBeHidden();
  await expect(page.getByRole("button", { name: "Select all" })).toBeVisible();

  await (await row(page, "two.txt")).locator(".name").tap();
  await expect(bar).toContainText("2 selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Select all" }).tap();
  await expect(bar).toContainText("3 selected");

  await page.goBack();
  await expect(bar).toHaveCount(0);
  await expect(page.locator(".tabs")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
});
