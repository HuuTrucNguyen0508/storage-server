import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { domain, origin, statePath, type UserName, users } from "./env";

/** Signs in through Authelia's real form. Leaves `page` on the app the sign-in returned to. */
export async function signInThroughForm(page: Page, user: UserName, startAt = origin("home") + "/"): Promise<void> {
  await page.goto(startAt);
  await expect(page).toHaveURL((u) => u.hostname === `auth.${domain}`);
  await page.locator("#username-textfield").fill(users[user].name);
  await page.locator("#password-textfield").fill(users[user].password);
  await page.locator("#sign-in-button").click();
  await expect(page).not.toHaveURL((u) => u.hostname === `auth.${domain}`, { timeout: 30_000 });
}

/** A new browser context already signed in as `user` (the storage state saved by setup). */
export async function asUser(browser: Browser, user: UserName, opts: Parameters<Browser["newContext"]>[0] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ storageState: statePath(user), ...opts });
  return { ctx, page: await ctx.newPage() };
}

/** Headers every mutating call to an app needs (see docs/architecture.md, "Request forgery"). */
export const mutating = { "X-Requested-With": "fetch" } as const;
