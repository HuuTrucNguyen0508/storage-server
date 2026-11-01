import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { binaryPath, cacheDir, repoRoot, webDir } from "./paths";

/** One command builds everything: the frontend, then the server that embeds it. */
export default function globalSetup(): void {
  mkdirSync(cacheDir, { recursive: true });
  execFileSync("pnpm", ["exec", "vite", "build"], { cwd: webDir, stdio: "inherit" });
  execFileSync("go", ["build", "-o", binaryPath, "./cmd/storage-server"], { cwd: repoRoot, stdio: "inherit" });
}
