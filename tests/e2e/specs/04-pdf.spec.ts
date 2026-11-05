import { expect, test } from "@playwright/test";
import { asUser } from "../lib/auth";
import { origin } from "../lib/env";
import { makePdf } from "../lib/files";

const pdf = origin("pdf");

test.describe("pdf", () => {
  test("Stirling PDF opens for alice", async ({ browser }) => {
    const { ctx, page } = await asUser(browser, "alice");
    const res = await page.goto(pdf + "/");
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).hostname).toBe(new URL(pdf).hostname); // no redirect to sign-in
    await expect(page).toHaveTitle(/Stirling/i);
    // The app's own shell renders (it is a single-page app, so wait for its root to fill).
    await expect(page.locator("body")).not.toBeEmpty();
    await expect.poll(async () => (await page.locator("#root, body").first().innerText()).trim().length, { timeout: 30_000 }).toBeGreaterThan(20);
    const status = await page.request.get(pdf + "/api/v1/info/status");
    expect(await status.json()).toMatchObject({ status: "UP" });
    await ctx.close();
  });

  test("merging two PDFs through the ingress returns one PDF", async ({ browser }) => {
    const { ctx } = await asUser(browser, "alice");
    const one = makePdf("First document");
    const two = makePdf("Second document", "with two pages");
    const form = new FormData();
    form.append("fileInput", new Blob([new Uint8Array(one)], { type: "application/pdf" }), "one.pdf");
    form.append("fileInput", new Blob([new Uint8Array(two)], { type: "application/pdf" }), "two.pdf");
    form.append("sortType", "orderProvided");
    form.append("removeCertSign", "true");
    const res = await ctx.request.post(pdf + "/api/v1/general/merge-pdfs", { multipart: form, timeout: 120_000 });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    const body = await res.body();
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(one.length);

    // Compress the merged document: still a PDF.
    const compressForm = new FormData();
    compressForm.append("fileInput", new Blob([new Uint8Array(body)], { type: "application/pdf" }), "merged.pdf");
    for (const [k, v] of Object.entries({ optimizeLevel: "1", expectedOutputSize: "25KB", linearize: "false", normalize: "false", grayscale: "false" })) compressForm.append(k, v);
    const small = await ctx.request.post(pdf + "/api/v1/misc/compress-pdf", { multipart: compressForm, timeout: 120_000 });
    expect(small.status()).toBe(200);
    expect(small.headers()["content-type"]).toContain("application/pdf");
    expect((await small.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    await ctx.close();
  });

  test("an anonymous caller never reaches Stirling PDF", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    const get = await anon.get(pdf + "/api/v1/info/status", { maxRedirects: 0 });
    expect(get.status()).toBe(302);
    const form = new FormData();
    form.append("fileInput", new Blob([new Uint8Array(makePdf("x"))], { type: "application/pdf" }), "x.pdf");
    const post = await anon.post(pdf + "/api/v1/general/merge-pdfs", { multipart: form, maxRedirects: 0 });
    expect(post.status()).toBe(303);
    await anon.dispose();
  });
});
