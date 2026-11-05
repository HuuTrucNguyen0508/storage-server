import { expect, test } from "@playwright/test";
import { asUser, mutating } from "../lib/auth";
import { origin, runId } from "../lib/env";

// Spot checks of the identity boundary. The full matrix lives in `make smoke`.
const forged = { "Remote-User": "admin", "Remote-Groups": "admins,users", "Remote-Email": "admin@lab.localhost", "Remote-Name": "Admin" };

test.describe("security spot checks", () => {
  test("a forged Remote-User header from alice's session is ignored by storage", async ({ browser }) => {
    const { ctx } = await asUser(browser, "alice");
    const me = await ctx.request.get(origin("storage") + "/api/me", { headers: forged });
    expect(me.status()).toBe(200);
    const body = (await me.json()) as { user: { username?: string; name?: string; isAdmin?: boolean; admin?: boolean } };
    expect(JSON.stringify(body.user)).toContain("alice");
    expect(JSON.stringify(body.user)).not.toMatch(/"admin"\s*:\s*true|"isAdmin"\s*:\s*true/);
    const admin = await ctx.request.get(origin("storage") + "/api/admin/users", { headers: forged });
    expect(admin.status()).toBe(403); // alice is not an admin, whatever the headers say
    await ctx.close();
  });

  test("a forged Remote-User header from alice's session is ignored by todo", async ({ browser }) => {
    const { ctx } = await asUser(browser, "alice");
    const me = await ctx.request.get(origin("todo") + "/api/me", { headers: forged });
    expect(me.status()).toBe(200);
    const body = (await me.json()) as { username: string; groups: string[] };
    expect(body.username).toBe("alice");
    expect(body.groups).not.toContain("admins");
    // A mutation made with the forged header lands in alice's space, not admin's.
    const project = await ctx.request.post(origin("todo") + "/api/projects", { headers: { ...forged, ...mutating, "Content-Type": "application/json" }, data: { name: `forged-${runId}` } });
    expect(project.status()).toBe(201);
    const created = (await project.json()) as { id: string; owner: string };
    expect(created.owner).toBe("alice");
    const del = await ctx.request.delete(`${origin("todo")}/api/projects/${created.id}`, { headers: mutating });
    expect(del.status()).toBe(200);
    await ctx.close();
  });

  for (const host of ["prometheus", "alertmanager", "traefik"]) {
    test(`alice gets 403 on ${host}`, async ({ browser }) => {
      const { ctx } = await asUser(browser, "alice");
      for (const p of host === "traefik" ? ["/dashboard/", "/api/version"] : ["/", "/api/v1/status/buildinfo"]) {
        const res = await ctx.request.get(origin(host) + p, { maxRedirects: 0 });
        expect(res.status(), `${host}${p}`).toBe(403);
      }
      await ctx.close();
    });
  }

  test("admin does reach the admin hosts", async ({ browser }) => {
    const { ctx } = await asUser(browser, "admin");
    for (const host of ["prometheus", "alertmanager", "traefik"]) {
      const res = await ctx.request.get(origin(host) + (host === "traefik" ? "/dashboard/" : "/"), { maxRedirects: 0 });
      expect(res.status(), host).toBeLessThan(400);
    }
    await ctx.close();
  });
});
