// Headless check of Grafana behind Authelia, through the real ingress:
//   - admin signs in at Authelia, lands in Grafana without Grafana's own login form, and is
//     a Grafana server admin with the org role Admin;
//   - alice (group users only) signs in and Authelia refuses Grafana (403);
//   - screenshots of the lab dashboards.
// Run: pnpm install && pnpm check   (from this folder)
// Env: DOMAIN (lab.localhost), OUT (screenshot folder), DASHBOARDS (comma-separated uids).
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const DOMAIN = process.env.DOMAIN ?? 'lab.localhost';
const OUT = process.env.OUT ?? join(ROOT, '.local', 'observability', 'screenshots');
const DASHBOARDS = (process.env.DASHBOARDS ?? 'lab-overview').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });

const creds = Object.fromEntries(
  readFileSync(join(ROOT, '.local', 'credentials.env'), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const GRAFANA = `https://grafana.${DOMAIN}/`;
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

async function signIn(context, user, password) {
  const page = await context.newPage();
  await page.goto(GRAFANA, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((u) => u.hostname === `auth.${DOMAIN}`, { timeout: 30000 });
  await page.locator('#username-textfield').fill(user);
  await page.locator('#password-textfield').fill(password);
  const nav = page.waitForURL((u) => u.hostname === `grafana.${DOMAIN}`, { timeout: 30000 }).catch(() => null);
  await page.locator('#sign-in-button').click();
  await nav;
  return page;
}

const browser = await chromium.launch({ headless: true });
try {
  // --- admin ---------------------------------------------------------------
  const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await signIn(admin, creds.ADMIN_USER ?? 'admin', creds.ADMIN_PASSWORD);
  await page.waitForLoadState('networkidle').catch(() => {});
  check(new URL(page.url()).hostname === `grafana.${DOMAIN}`, `admin lands on Grafana (${page.url()})`);
  check(await page.locator('input[name="user"], input[name="password"]').count() === 0, 'no Grafana login form');
  const user = await page.evaluate(async () => (await fetch('/api/user')).json());
  const orgs = await page.evaluate(async () => (await fetch('/api/user/orgs')).json());
  console.log(`  /api/user: login=${user.login} email=${user.email} isGrafanaAdmin=${user.isGrafanaAdmin}; orgs=${JSON.stringify(orgs)}`);
  check(user.login === (creds.ADMIN_USER ?? 'admin'), 'signed in as the Authelia user');
  check(user.isGrafanaAdmin === true, 'admin is a Grafana server admin');
  check(Array.isArray(orgs) && orgs.some((o) => o.role === 'Admin'), 'admin has org role Admin');
  await page.screenshot({ path: join(OUT, 'grafana-home-admin.png') });

  // Grafana only queries panels inside the viewport: make it tall enough for whole dashboards.
  await page.setViewportSize({ width: 1600, height: 4200 });
  for (const uid of DASHBOARDS) {
    await page.goto(`${GRAFANA}d/${uid}?orgId=1&kiosk`, { waitUntil: 'networkidle' }).catch(() => {});
    // Let panels finish their queries.
    await page.waitForTimeout(6000);
    const errors = await page.locator('[data-testid="data-testid Panel status error"]').count();
    check(errors === 0, `dashboard ${uid} renders with no panel errors (${errors})`);
    await page.screenshot({ path: join(OUT, `dashboard-${uid}.png`), fullPage: false });
  }
  await admin.close();

  // --- alice: not in group admins ---------------------------------------------
  const friend = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const fpage = await signIn(friend, 'alice', creds.ALICE_PASSWORD);
  const resp = await fpage.goto(GRAFANA, { waitUntil: 'domcontentloaded' });
  const body = await fpage.locator('body').innerText().catch(() => '');
  console.log(`  alice: GET ${GRAFANA} -> ${resp?.status()} at ${fpage.url()}; body: ${body.slice(0, 80).replace(/\s+/g, ' ')}`);
  check(resp?.status() === 403, 'Authelia refuses Grafana to alice (403)');
  const api = await fpage.evaluate(async () => { try { const r = await fetch('/api/user'); return r.status; } catch (e) { return String(e); } });
  check(api === 403, `alice gets no Grafana API either (${api})`);
  await fpage.screenshot({ path: join(OUT, 'grafana-alice-refused.png') });
  await friend.close();
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : `all checks passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
