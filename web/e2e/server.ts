import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { binaryPath, cacheDir } from "./paths";

export const OWNER_PASSWORD = "correct horse battery";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface Server {
  owner: string;
  guest: string;
  root: string;
  setupCode: () => Promise<string>;
  logs: () => string;
  stop: () => Promise<void>;
}

export async function startServer(): Promise<Server> {
  const dir = mkdtempSync(join(cacheDir, "run-"));
  const root = join(dir, "root");
  const state = join(dir, "state");
  mkdirSync(root);
  mkdirSync(state);
  const ports = { owner: await freePort(), guest: await freePort(), ops: await freePort() };
  const owner = `http://127.0.0.1:${ports.owner}`;
  const guest = `http://127.0.0.1:${ports.guest}`;
  const proc: ChildProcess = spawn(binaryPath, [], {
    env: {
      ...process.env,
      ROOT_DIR: root,
      STATE_DIR: state,
      OWNER_ADDR: `127.0.0.1:${ports.owner}`,
      GUEST_ADDR: `127.0.0.1:${ports.guest}`,
      OPS_ADDR: `127.0.0.1:${ports.ops}`,
      PUBLIC_URL: owner,
      SHARE_URL: guest,
      MIN_FREE_BYTES: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  proc.stdout?.on("data", (d: Buffer) => (logs += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (logs += d.toString()));

  const deadline = Date.now() + 20_000;
  for (;;) {
    const ok = await fetch(`${owner}/healthz`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`server did not start\n${logs}`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    owner,
    guest,
    root,
    logs: () => logs,
    async setupCode() {
      const until = Date.now() + 5_000;
      for (;;) {
        const code = /"msg":"setup_code","code":"([A-Z0-9]+)"/.exec(logs)?.[1];
        if (code !== undefined) return code;
        if (Date.now() > until) throw new Error(`no setup code in the log\n${logs}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async stop() {
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
