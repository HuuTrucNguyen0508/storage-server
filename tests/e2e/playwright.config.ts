import { defineConfig, devices } from "@playwright/test";

// Headless Chromium only. Specs run in file order on one worker: they share the live
// cluster and a few of them (storage sharing, todo sharing) build on each other's setup.
// The platform CA is name-constrained to the lab domain and Chromium keeps its own trust
// store, so TLS errors are ignored instead of importing the CA.
export default defineConfig({
  testDir: "./specs",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "journeys", testMatch: /\.spec\.ts$/, dependencies: ["setup"], use: { ...devices["Desktop Chrome"], headless: true, viewport: { width: 1440, height: 900 } } },
  ],
});
