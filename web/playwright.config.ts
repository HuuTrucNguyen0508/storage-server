import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Regenerates docs/design/ui/production-shots, so it runs only on request.
  testIgnore: process.env.SHOTS ? [] : ["**/production-shots.spec.ts"],
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 2,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    headless: true,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
});
