import { test as base, expect, type Page } from "@playwright/test";
import { OWNER_PASSWORD, startServer, type Server } from "./server";

interface WorkerFixtures {
  server: Server;
}

interface TestFixtures {
  pageRules: void;
  folder: string;
  ownerPage: Page;
}

async function claim(server: Server): Promise<void> {
  const res = await fetch(`${server.owner}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.owner },
    body: JSON.stringify({ code: await server.setupCode(), password: OWNER_PASSWORD }),
  });
  expect(res.status).toBe(201);
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    async ({}, use) => {
      const server = await startServer();
      await claim(server);
      await use(server);
      await server.stop();
    },
    { scope: "worker" },
  ],
  pageRules: [
    async ({ page }, use) => {
      const broken: string[] = [];
      page.on("console", (msg) => {
        if (/content security policy/i.test(msg.text())) broken.push(msg.text());
      });
      page.on("request", (req) => {
        const url = new URL(req.url());
        if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1") broken.push(`third party: ${req.url()}`);
      });
      await use();
      expect(broken).toEqual([]);
    },
    { auto: true },
  ],
  folder: async ({ server, request }, use, info) => {
    const name = `t${info.testId.replace(/-/g, "").slice(-12)}${info.retry}`;
    await request.post(`${server.owner}/api/login`, { data: { password: OWNER_PASSWORD } });
    const res = await request.post(`${server.owner}/api/files/folder`, { data: { path: name } });
    expect(res.status()).toBe(201);
    await use(name);
  },
  ownerPage: async ({ server, page, context }, use) => {
    const res = await context.request.post(`${server.owner}/api/login`, { data: { password: OWNER_PASSWORD } });
    expect(res.status()).toBe(204);
    await use(page);
  },
});

export { expect };
