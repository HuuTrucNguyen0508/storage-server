import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "./fixtures";
import { cacheDir } from "./paths";
import type { Server } from "./server";

export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) <= 720;
}

export async function gotoFolder(page: Page, server: Server, path: string): Promise<void> {
  await page.goto(`${server.owner}/files/${path.split("/").map(encodeURIComponent).join("/")}`);
  await expect(page.getByRole("heading", { level: 1, name: path.split("/").at(-1) ?? "Files" })).toBeVisible();
}

export function diskFile(server: Server, path: string): Buffer {
  return readFileSync(join(server.root, path));
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function pseudoRandom(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    if (i + 4 <= size) out.writeUInt32LE(x, i);
    else for (let j = i; j < size; j++) out[j] = (x >>> (8 * (j - i))) & 0xff;
  }
  return out;
}

export function fixtureFile(name: string, data: Buffer | string): string {
  const path = join(cacheDir, "fixtures", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

/** Puts a file on the server through the real tus API, for a test about something else. */
export async function seed(request: APIRequestContext, server: Server, path: string, data: Buffer | string): Promise<void> {
  const body = Buffer.from(data);
  const created = await request.post(`${server.owner}/api/uploads`, {
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(body.length),
      "Upload-Metadata": `path ${Buffer.from(path).toString("base64")}`,
    },
  });
  expect(created.status()).toBe(201);
  if (body.length === 0) return;
  const patched = await request.patch(`${server.owner}${created.headers().location}`, {
    headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
    data: body,
  });
  expect(patched.status()).toBe(204);
}

export async function createShare(request: APIRequestContext, server: Server, body: object): Promise<{ url: string; id: string }> {
  const res = await request.post(`${server.owner}/api/shares`, { data: body });
  expect(res.status()).toBe(201);
  return (await res.json()) as { url: string; id: string };
}

export async function row(page: Page, name: string) {
  return page.locator(`.row[data-path$="${name}"]`);
}

/** Taps or clicks a row's menu and picks an item, the way each device would. */
export async function rowMenu(page: Page, name: string, item: string): Promise<void> {
  const r = await row(page, name);
  await r.hover().catch(() => {});
  await r.getByRole("button", { name: `More for ${name}` }).click();
  await page.locator(".menu:popover-open").getByRole("button", { name: item }).click();
}

export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export function minimalPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 30 100 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
