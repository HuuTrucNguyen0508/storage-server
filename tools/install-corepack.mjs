// Installs a pinned, checksum-verified corepack into a Node image that no
// longer bundles it (Node 25+), then the caller runs `corepack enable`.
// Usage in a Dockerfile:
//   COPY tools/install-corepack.mjs /tmp/
//   RUN node /tmp/install-corepack.mjs && corepack enable
import { writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const url = "https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz";
const sha512 = "SiiJsBhZqdBiPHTEl6OT3sASrRrKIcYTQMsVGXx6EE/gM8WFMwYjeIX8Tt8RiU4Iv2J6LbT8KpGfCOsBpRWB/w==";
const dir = "/usr/local/lib/node_modules/corepack";

const res = await fetch(url);
if (!res.ok) throw new Error(`corepack download failed: ${res.status} ${res.statusText}`);
const body = Buffer.from(await res.arrayBuffer());
if (createHash("sha512").update(body).digest("base64") !== sha512) throw new Error("corepack checksum mismatch");
writeFileSync("/tmp/corepack.tgz", body);
mkdirSync(dir, { recursive: true });
execFileSync("tar", ["xzf", "/tmp/corepack.tgz", "--strip-components=1", "-C", dir]);
rmSync("/tmp/corepack.tgz");
symlinkSync(`${dir}/dist/corepack.js`, "/usr/local/bin/corepack");
