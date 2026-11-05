import { expect, test } from "@playwright/test";
import { asUser } from "../lib/auth";
import { origin } from "../lib/env";

const grafana = origin("grafana");

test.describe("observability", () => {
  test("admin opens Grafana without a Grafana login and Lab overview shows live data", async ({ browser }) => {
    // Grafana only queries panels inside the viewport, so make the window tall.
    const { ctx, page } = await asUser(browser, "admin", { viewport: { width: 1600, height: 3200 } });
    await page.goto(grafana + "/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL((u) => u.hostname === new URL(grafana).hostname);
    await expect(page.locator('input[name="user"], input[name="password"]')).toHaveCount(0);
    const me = await page.evaluate(async () => (await fetch("/api/user")).json());
    expect(me).toMatchObject({ login: "admin" });

    await page.goto(`${grafana}/d/lab-overview?orgId=1&kiosk`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/Lab overview/);
    await expect(page.locator('[data-testid="data-testid Panel header Host memory"]')).toBeVisible({ timeout: 30_000 });
    // Stat panels fill in after their queries return: a number, not "No data".
    await expect(page.locator("body")).toContainText(/Host memory\s*[\d.]+%/, { timeout: 60_000 });
    await expect(page.locator("body")).toContainText(/Requests\/s\s*[\d.]+\s*req\/s/, { timeout: 60_000 });
    await expect(page.locator('[data-testid="data-testid Panel status error"]')).toHaveCount(0);

    // Prometheus behind Grafana answers with samples for the scrape targets.
    const frames = await page.evaluate(async () => {
      const res = await fetch("/api/ds/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: [{ refId: "A", datasource: { uid: "prometheus" }, expr: "count(up == 1)", instant: true }], from: "now-5m", to: "now" }),
      });
      return (await res.json()) as { results: { A: { status: number; frames: { data: { values: number[][] } }[] } } };
    });
    expect(frames.results.A.status).toBe(200);
    expect(frames.results.A.frames[0]?.data.values[1]?.[0]).toBeGreaterThan(5);
    await ctx.close();
  });

  test("alice is refused Grafana", async ({ browser }) => {
    const { ctx, page } = await asUser(browser, "alice");
    const res = await page.goto(grafana + "/", { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(403);
    const api = await page.request.get(grafana + "/api/user", { maxRedirects: 0 });
    expect(api.status()).toBe(403);
    await ctx.close();
  });
});
