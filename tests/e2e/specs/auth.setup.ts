import { mkdirSync } from "node:fs";
import { test as setup } from "@playwright/test";
import { signInThroughForm } from "../lib/auth";
import { authDir, statePath, type UserName } from "../lib/env";

// Each user signs in once through the real Authelia form; every journey reuses the
// saved session cookie (valid on every app host).
mkdirSync(authDir, { recursive: true });
for (const user of ["admin", "alice", "bob"] as UserName[]) {
  setup(`sign in ${user} through the Authelia form`, async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInThroughForm(page, user);
    await ctx.storageState({ path: statePath(user) });
    await ctx.close();
  });
}
