import { expect, test } from "./fixtures";
import { gotoFolder, isPhone, row, rowMenu, seed } from "./helpers";

test("search streams results and opens one", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/deep/down/red fox.txt`, "the fox");
  await seed(request, server, `${folder}/red hen.txt`, "the hen");
  await seed(request, server, `${folder}/blue fox.txt`, "other");
  await gotoFolder(page, server, folder);

  await page.getByLabel("Search by name").fill("red");
  await expect(page.getByRole("heading", { level: 1, name: "Results for red" })).toBeVisible();
  await expect(page).toHaveURL(/\?q=red$/);
  await expect(await row(page, "red fox.txt")).toBeVisible();
  await expect(await row(page, "red hen.txt")).toBeVisible();
  await expect(await row(page, "blue fox.txt")).toHaveCount(0);
  await expect(page.getByTestId("folder-meta")).toContainText("2 results");

  await page.getByLabel("Search by name").fill("red fox");
  await expect(await row(page, "red hen.txt")).toHaveCount(0);
  await expect(await row(page, "red fox.txt")).toContainText(isPhone(page) ? "deep/down" : `${folder}/deep/down`);

  await (await row(page, "red fox.txt")).getByRole("button", { name: "red fox.txt", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Preview of red fox.txt" }).locator(".doc pre")).toHaveText("the fox");
});

test("acting on a result updates the results", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/gone-soon.txt`, "x");
  await seed(request, server, `${folder}/gone-later.txt`, "y");
  await page.goto(`${server.owner}/files/${folder}?q=gone`);
  await expect(await row(page, "gone-soon.txt")).toBeVisible();
  await rowMenu(page, "gone-soon.txt", "Trash");
  await expect(await row(page, "gone-soon.txt")).toHaveCount(0);
  await expect(await row(page, "gone-later.txt")).toBeVisible();
});

test("a search with no match says what search looks at", async ({ ownerPage: page, server, folder }) => {
  await gotoFolder(page, server, folder);
  await page.getByLabel("Search by name").fill("zzqq");
  await expect(page.getByRole("heading", { level: 2, name: "No names match zzqq" })).toBeVisible();
});

test("clearing search returns to the folder", async ({ ownerPage: page, server, folder, request }) => {
  await seed(request, server, `${folder}/keep.txt`, "k");
  await page.goto(`${server.owner}/files/${folder}?q=keep`);
  await expect(await row(page, "keep.txt")).toBeVisible();
  await page.getByLabel("Search by name").clear();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
  await expect(page).not.toHaveURL(/\?q=/);
});
