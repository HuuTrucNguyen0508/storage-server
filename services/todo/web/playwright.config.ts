import { defineConfig, devices } from "@playwright/test";

// Headless only. BASE_URL points at a running todo API that serves dist/
// (AUTH_MODE=dev for the local smoke test; see e2e/run-local.sh).
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:18090",
    headless: true,
    ignoreHTTPSErrors: !!process.env.IGNORE_HTTPS_ERRORS,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], headless: true } }],
});
