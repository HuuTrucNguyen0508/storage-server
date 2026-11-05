// @vitest-environment node
// The image builds from services/todo/web alone, so ui/ is a copy of
// packages/ui. This fails when the copy drifts; run `pnpm sync-ui` to fix it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const shared = fileURLToPath(new URL("../../../../packages/ui/", import.meta.url));
const copy = fileURLToPath(new URL("../ui/", import.meta.url));

describe.runIf(existsSync(shared))("ui copy", () => {
  it("matches packages/ui", () => {
    const files = ["tokens.css", "base.css", ...readdirSync(shared + "fonts").map((f) => "fonts/" + f)];
    for (const f of files) expect(readFileSync(copy + f).equals(readFileSync(shared + f)), `${f} differs; run pnpm sync-ui`).toBe(true);
  });
});
