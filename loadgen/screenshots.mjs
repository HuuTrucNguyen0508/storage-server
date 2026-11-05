#!/usr/bin/env node
// Screenshots of the k6 dashboard and the Apps HTTP RED dashboard for one run, through the
// real ingress, signed in as admin through Authelia, in headless Chromium. It never opens
// a visible browser.
//
//   node loadgen/screenshots.mjs <testid> <from-epoch-seconds> <to-epoch-seconds> [out-dir]
//
// Uses playwright-core from platform/observability/tests/ui (run `pnpm install` there once).
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const [testid, fromS, toS, outArg] = process.argv.slice(2);
if (!testid || !fromS || !toS) {
  console.error("usage: screenshots.mjs <testid> <from-epoch-s> <to-epoch-s> [out-dir]");
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(join(ROOT, "platform/observability/tests/ui/node_modules/playwright-core/index.mjs")).href);
const DOMAIN = process.env.DOMAIN ?? "lab.localhost";
const OUT = outArg ?? join(ROOT, ".local", "loadgen", "screenshots");
mkdirSync(OUT, { recursive: true });
const creds = Object.fromEntries(
  readFileSync(join(ROOT, ".local", "credentials.env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const from = Number(fromS) * 1000;
const to = Number(toS) * 1000;

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 2200 } });
  const page = await context.newPage();
  await page.goto(`https://grafana.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.hostname === `auth.${DOMAIN}`, { timeout: 30000 });
  await page.locator("#username-textfield").fill(creds.ADMIN_USER ?? "admin");
  await page.locator("#password-textfield").fill(creds.ADMIN_PASSWORD);
  const nav = page.waitForURL((u) => u.hostname === `grafana.${DOMAIN}`, { timeout: 30000 });
  await page.locator("#sign-in-button").click();
  await nav;

  const shots = [
    ["k6", `/d/k6?orgId=1&from=${from}&to=${to}&var-testid=${encodeURIComponent(testid)}&refresh=`, "k6-dashboard.png"],
    ["apps-http-red", `/d/apps-http-red?orgId=1&from=${from}&to=${to}&refresh=`, "apps-http-red.png"],
  ];
  for (const [, path, file] of shots) {
    await page.goto(`https://grafana.${DOMAIN}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(8000); // panels render after their queries return
    await page.screenshot({ path: join(OUT, file), fullPage: true });
    console.log(`${join(OUT, file)} (${page.url().split("?")[0]})`);
  }
} finally {
  await browser.close();
}
