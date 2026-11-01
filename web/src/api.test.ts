import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, contentKind, guest, owner, readNdjson, setUnauthenticatedHandler, WireError } from "./api";

function respond(status: number, body: unknown, headers: Record<string, string> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status, headers })),
  );
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthenticatedHandler(() => {});
});

describe("listing", () => {
  it("parses entries and turns an empty preview into null", async () => {
    respond(200, {
      path: "a",
      entries: [
        { name: "b.jpg", kind: "file", size: 12, modTime: "2026-10-31T21:40:00Z", preview: "image" },
        { name: "c", kind: "dir", size: 0, modTime: "2026-10-31T21:40:00Z", preview: "" },
      ],
    });
    await expect(owner.list("a")).resolves.toEqual({
      path: "a",
      entries: [
        { name: "b.jpg", kind: "file", size: 12, modTime: new Date("2026-10-31T21:40:00Z"), preview: "image" },
        { name: "c", kind: "dir", size: 0, modTime: new Date("2026-10-31T21:40:00Z"), preview: null },
      ],
    });
  });

  it("escapes the path in the query", async () => {
    respond(200, { path: "", entries: [] });
    await owner.list("a b&c");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/files?path=a+b%26c");
  });

  it("refuses a kind the contract does not name", async () => {
    respond(200, { path: "", entries: [{ name: "x", kind: "socket", size: 0, modTime: "2026-01-01T00:00:00Z", preview: "" }] });
    await expect(owner.list("")).rejects.toThrow(new WireError('kind is "socket"'));
  });

  it("refuses a time that is not a time", async () => {
    respond(200, { path: "", entries: [{ name: "x", kind: "file", size: 0, modTime: "soon", preview: "" }] });
    await expect(owner.list("")).rejects.toThrow(new WireError("modTime is not a time"));
  });
});

describe("errors", () => {
  it("carries the code, the message and Retry-After", async () => {
    respond(429, { error: { code: "rate_limited", message: "slow down" } }, { "Retry-After": "30" });
    const err = await owner.login("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: "rate_limited", message: "slow down", retryAfter: 30 });
  });

  it("survives an error body that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502, statusText: "Bad Gateway" })));
    await expect(owner.list("")).rejects.toMatchObject({ status: 502, code: "unknown", message: "Bad Gateway" });
  });

  it("tells the app when the session is gone", async () => {
    const seen: string[] = [];
    setUnauthenticatedHandler(() => seen.push("signed out"));
    respond(401, { error: { code: "unauthenticated", message: "no" } });
    await expect(owner.list("")).rejects.toMatchObject({ code: "unauthenticated" });
    expect(seen).toEqual(["signed out"]);
  });

  it("leaves a wrong password to the form", async () => {
    const seen: string[] = [];
    setUnauthenticatedHandler(() => seen.push("signed out"));
    respond(401, { error: { code: "bad_credentials", message: "no" } });
    await expect(owner.login("x")).rejects.toMatchObject({ code: "bad_credentials" });
    expect(seen).toEqual([]);
  });
});

describe("shares", () => {
  const wire = {
    id: "1",
    kind: "link",
    url: "http://h/s/t",
    path: "a",
    state: "active",
    uses: 2,
    maxUses: null,
    expiresAt: "2026-11-08T00:00:00Z",
    hasPassword: false,
    createdAt: "2026-11-01T00:00:00Z",
  };

  it("keeps nulls as null and parses times", async () => {
    respond(200, [wire]);
    const [share] = await owner.shares();
    expect(share?.maxUses).toBe(null);
    expect(share?.expiresAt).toEqual(new Date("2026-11-08T00:00:00Z"));
  });

  it("sends an expiry as RFC 3339", async () => {
    respond(201, wire);
    await owner.createShare({ path: "a", kind: "link", expiresAt: new Date("2026-11-08T00:00:00Z"), maxUses: 3 });
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ path: "a", kind: "link", expiresAt: "2026-11-08T00:00:00.000Z", maxUses: 3 });
  });
});

describe("per-item results", () => {
  it("keeps successes and failures apart", async () => {
    respond(200, { results: [{ path: "a", newPath: "b/a" }, { path: "c", error: "exists" }] });
    await expect(owner.move(["a", "c"], "b")).resolves.toEqual([
      { path: "a", ok: "b/a" },
      { path: "c", error: "exists" },
    ]);
  });
});

describe("search", () => {
  it("hands over hits as they stream and reports truncation", async () => {
    const hit = { preview: "text", path: "a/b", name: "b", kind: "file", size: 1, modTime: "2026-01-01T00:00:00Z" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const text = `${JSON.stringify(hit)}\n${JSON.stringify({ done: true, truncated: true })}\n`;
        return new Response(stream(text.slice(0, 10), text.slice(10)), { status: 200 });
      }),
    );
    const hits: string[] = [];
    const end = await owner.search("b", "", (h) => hits.push(h.path), new AbortController().signal);
    expect(hits).toEqual(["a/b"]);
    expect(end).toEqual({ truncated: true });
  });

  it("calls a stream with no last line a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream(""), { status: 200 })));
    await expect(owner.search("b", "", () => {}, new AbortController().signal)).rejects.toThrow(
      new WireError("search stream ended without a last line"),
    );
  });
});

describe("readNdjson", () => {
  it("joins a line split across chunks and a character split across bytes", async () => {
    const bytes = new TextEncoder().encode('{"a":"é"}\n{"b":2}\n');
    const split = 7; // inside the two bytes of é
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, split));
        c.enqueue(bytes.slice(split));
        c.close();
      },
    });
    const seen: unknown[] = [];
    await readNdjson(body, (v) => seen.push(v));
    expect(seen).toEqual([{ a: "é" }, { b: 2 }]);
  });
});

describe("guest", () => {
  it("speaks only under the public path of its token", async () => {
    respond(200, { preview: "", kind: "link", name: "x", isFolder: true, size: null, passwordRequired: false, expiresAt: null });
    const api = guest("to/ken");
    await expect(api.facts()).resolves.toEqual({ preview: null, kind: "link", name: "x", isFolder: true, size: null, passwordRequired: false, expiresAt: null });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/public/to%2Fken");
    expect(api.source.contentUrl("a b")).toBe("/api/public/to%2Fken/content?path=a+b");
    expect(api.source.downloadUrl("a")).toBe("/api/public/to%2Fken/content?path=a&download");
    expect(api.zipUrl).toBe("/api/public/to%2Fken/zip");
  });
});

describe("contentKind", () => {
  it.each([
    ["image/svg+xml", "image"],
    ["video/mp4", "video"],
    ["audio/ogg", "audio"],
    ["application/pdf", "pdf"],
    ["text/plain; charset=utf-8", "text"],
    ["application/octet-stream", null],
    [null, null],
  ])("%s is %s", (type, kind) => {
    expect(contentKind(type)).toBe(kind);
  });
});
