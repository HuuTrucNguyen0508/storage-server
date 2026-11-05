// Copies packages/ui (tokens, base styles, fonts) into ./ui. The todo image
// builds from services/todo/web alone, so it carries its own copy, like Home.
// src/ui-sync.test.ts fails when the copy drifts from packages/ui.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../../packages/ui/", import.meta.url));
const to = fileURLToPath(new URL("../ui/", import.meta.url));
rmSync(to, { recursive: true, force: true });
for (const f of ["tokens.css", "base.css", "fonts"]) cpSync(from + f, to + f, { recursive: true });
console.log(`copied ${from} to ${to}`);
