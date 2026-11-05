import { expect, test } from "@playwright/test";
import { asUser, signInThroughForm } from "../lib/auth";
import { domain, origin } from "../lib/env";

test.describe("portal", () => {
  test("lab.localhost sends a stranger to sign-in, then to Home", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(origin());
    await expect(page).toHaveURL((u) => u.hostname === `auth.${domain}`);
    await ctx.close();

    const real = await browser.newContext();
    const p2 = await real.newPage();
    await signInThroughForm(p2, "alice", origin());
    await expect(p2).toHaveURL((u) => u.hostname === `home.${domain}`);
    await expect(p2.locator("#me-name")).toHaveText("Alice");
    await expect(p2.getByRole("heading", { name: "Lab", level: 1 })).toBeVisible();
    await real.close();
  });

  test("admin sees the admin links, alice does not", async ({ browser }) => {
    const admin = await asUser(browser, "admin");
    await admin.page.goto(origin("home") + "/");
    await expect(admin.page.locator("#me-name")).toHaveText("Admin");
    for (const name of ["Prometheus", "Alertmanager", "Traefik"]) {
      await expect(admin.page.locator(".admin__link", { hasText: name })).toBeVisible();
    }
    await expect(admin.page.locator(".door--grafana")).toBeVisible();
    await expect(admin.page.locator(".door--storage")).toBeVisible();
    await admin.ctx.close();

    const alice = await asUser(browser, "alice");
    await alice.page.goto(origin("home") + "/");
    await expect(alice.page.locator("#me-name")).toHaveText("Alice");
    for (const door of ["storage", "todo", "pdf"]) await expect(alice.page.locator(`.door--${door}`)).toBeVisible();
    await expect(alice.page.locator(".door--grafana")).toBeHidden();
    await expect(alice.page.locator(".admin__link")).toHaveCount(3);
    for (const link of await alice.page.locator(".admin__link").all()) await expect(link).toBeHidden();
    await expect(alice.page.locator(".admin")).toBeHidden();
    await alice.ctx.close();
  });

  test("signing out of Home signs the user out of every app", async ({ browser }) => {
    // A session of its own: signing out ends the session, and the shared ones must survive.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInThroughForm(page, "bob");
    await page.goto(origin("home") + "/");
    for (const app of ["storage", "todo", "pdf"]) {
      const res = await page.request.get(origin(app) + "/", { maxRedirects: 0 });
      expect(res.status(), `${app} before sign-out`).toBe(200);
    }
    await page.getByRole("link", { name: "Sign out" }).click();
    // Authelia's logout returns to Home, and Home sends the signed-out browser to the form.
    await expect(page.locator("#username-textfield")).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).hostname).toBe(`auth.${domain}`);
    for (const app of ["home", "storage", "todo", "pdf"]) {
      const res = await page.request.get(origin(app) + "/", { maxRedirects: 0 });
      expect(res.status(), `${app} after sign-out`).toBe(302);
      expect(res.headers()["location"]).toContain(`auth.${domain}`);
    }
    await ctx.close();
  });
});
