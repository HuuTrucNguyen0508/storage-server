import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { binaryPath, cacheDir, repoRoot, webDir } from "./paths";

export default function globalSetup(): () => void {
  mkdirSync(cacheDir, { recursive: true });
  execFileSync("pnpm", ["exec", "vite", "build"], { cwd: webDir, stdio: "inherit" });
  execFileSync("go", ["build", "-o", binaryPath, "./cmd/storage-server"], { cwd: repoRoot, stdio: "inherit" });
  return () => rmSync(join(cacheDir, "fixtures"), { recursive: true, force: true });
}
