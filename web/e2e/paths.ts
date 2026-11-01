import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const webDir = resolve(import.meta.dirname, "..");
export const repoRoot = resolve(webDir, "..");
export const cacheDir = join(homedir(), ".cache", "storage-server-web");
export const binaryPath = join(cacheDir, "storage-server");
