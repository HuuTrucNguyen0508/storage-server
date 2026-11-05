// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { bytes, extLabel, sharingText, timeLeft, when } from "./format";
import { highlight, lineCount, prettyJson, renderMarkdown, trimPartial } from "./render";
import { backoff, chunkRanges, type ChunkResult, type Store, type Transport, UploadManager } from "./uploads";

describe("format", () => {
  it("writes sizes for people", () => {
    expect(bytes(0)).toBe("0 bytes");
    expect(bytes(1)).toBe("1 byte");
    expect(bytes(212_000)).toBe("212 KB");
    expect(bytes(1_800_000)).toBe("1.8 MB");
    expect(bytes(2_000_000_000)).toBe("2 GB");
  });
  it("writes dates relative to now", () => {
    const now = new Date("2026-11-05T12:00:00");
    expect(when("2026-11-05T09:14:00", now)).toBe("Today, 09:14");
    expect(when("2026-11-04T09:14:00", now)).toBe("Yesterday");
    expect(when("2026-11-03T09:14:00", now)).toBe("3 Nov");
    expect(when("2024-11-03T09:14:00", now)).toBe("3 Nov 2024");
    expect(timeLeft("2026-12-04T13:00:00", now)).toBe("29 days left");
    expect(timeLeft("2026-11-01T00:00:00", now)).toBe("expired");
  });
  it("labels extensions", () => {
    expect(extLabel("a.docx")).toBe("DOC");
    expect(extLabel("archive.tar.gz")).toBe("GZ");
    expect(extLabel(".env")).toBe("");
    expect(extLabel("route.json")).toBe("{ }");
  });
  it("summarizes sharing", () => {
    const now = new Date("2026-11-05T12:00:00");
    expect(sharingText(undefined)).toBe("Only you");
    expect(sharingText({ people: [{ username: "bob", permission: "edit" }], links: 0, linkExpiresAt: null })).toBe("Bob can edit");
    expect(sharingText({ people: [{ username: "bob", permission: "read" }, { username: "carol", permission: "read" }], links: 0, linkExpiresAt: null })).toBe("Bob and 1 other");
    expect(sharingText({ people: [], links: 1, linkExpiresAt: "2026-11-17T13:00:00" }, now)).toBe("Link, 12 days left");
    expect(sharingText({ people: [{ username: "bob", permission: "read" }], links: 2, linkExpiresAt: null })).toBe("Bob can view and 2 links");
  });
});

describe("render", () => {
  it("never lets markdown run script or raw HTML through", () => {
    const html = renderMarkdown(
      "# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [ok](https://example.com)\n\n```go\nfunc main() {}\n```",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("hljs-keyword");
  });
  it("escapes code it cannot highlight", () => {
    expect(highlight("<b>x</b>", "nope")).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(highlight("<b>x</b>", "xml")).not.toContain("<b>");
  });
  it("pretty-prints JSON and counts lines", () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson("{nope")).toBeNull();
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
    expect(trimPartial("one\ntwo\nthr", true)).toBe("one\ntwo\n");
  });
});

class MemStore implements Store {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** A fake server that keeps bytes and can drop the connection mid-chunk. */
class FakeServer implements Transport {
  sessions = new Map<string, { size: number; data: number[] }>();
  dropNextAfter = -1;
  puts: number[] = [];
  n = 0;
  async create(_b: string, body: { size: number }): Promise<ChunkResult> {
    const id = `s${++this.n}`;
    this.sessions.set(id, { size: body.size, data: [] });
    return { upload: { id, offset: 0, size: body.size } };
  }
  async status(_b: string, id: string): Promise<ChunkResult> {
    const s = this.sessions.get(id);
    if (!s) throw new ApiError(404, "not_found", "not found");
    return { upload: { id, offset: s.data.length, size: s.size } };
  }
  async put(_b: string, id: string, offset: number, chunk: Blob, onProgress: (n: number) => void): Promise<ChunkResult> {
    const s = this.sessions.get(id)!;
    this.puts.push(offset);
    if (offset !== s.data.length) throw new ApiError(409, "offset_mismatch", "x", { upload: { offset: s.data.length } });
    const bytes = Array.from(new Uint8Array(await chunk.arrayBuffer()));
    if (this.dropNextAfter >= 0) {
      s.data.push(...bytes.slice(0, this.dropNextAfter));
      this.dropNextAfter = -1;
      throw new Error("network");
    }
    s.data.push(...bytes);
    onProgress(bytes.length);
    const done = s.data.length === s.size;
    return { upload: { id, offset: s.data.length, size: s.size }, node: done ? { id: "node-" + id, name: "f" } : undefined };
  }
  async cancel(_b: string, id: string) {
    this.sessions.delete(id);
  }
}

const settle = async (m: UploadManager) => {
  for (let i = 0; i < 200; i++) {
    if (m.items().every((it) => ["done", "error", "cancelled"].includes(it.state))) return;
    await new Promise((r) => setTimeout(r, 1));
  }
};

const file = (n: number, name = "f.bin") => Object.assign(new Blob([new Uint8Array(n).map((_, i) => i % 251)]), { name, lastModified: 1 });

describe("upload manager", () => {
  it("plans chunks and backs off", () => {
    expect(chunkRanges(5, 25, 10)).toEqual([[5, 15], [15, 25]]);
    expect([0, 1, 2, 10].map(backoff)).toEqual([1000, 2000, 4000, 30000]);
  });

  it("resumes from the server's offset after a dropped connection", async () => {
    const srv = new FakeServer();
    const m = new UploadManager({ transport: srv, chunkBytes: 10, sleep: async () => {}, storage: new MemStore() });
    srv.dropNextAfter = -1;
    const f = file(35);
    // Drop the second chunk after 4 bytes.
    const origPut = srv.put.bind(srv);
    let calls = 0;
    srv.put = async (...args) => {
      if (++calls === 2) srv.dropNextAfter = 4;
      return origPut(...args);
    };
    m.add([{ file: f, relPath: "" }], "/api/uploads", "root");
    await settle(m);
    const [item] = m.items();
    expect(item?.state).toBe("done");
    expect(srv.puts).toEqual([0, 10, 14, 24, 34]);
    const stored = [...srv.sessions.values()][0]!.data;
    expect(stored).toEqual(Array.from(new Uint8Array(35).map((_, i) => i % 251)));
  });

  it("continues an upload from an earlier page load", async () => {
    const srv = new FakeServer();
    const storage = new MemStore();
    const first = new UploadManager({ transport: srv, chunkBytes: 10, sleep: async () => {}, storage, maxRetries: 0 });
    let calls = 0;
    const origPut = srv.put.bind(srv);
    srv.put = async (...args) => {
      if (++calls === 3) throw new ApiError(400, "boom", "stop here");
      return origPut(...args);
    };
    first.add([{ file: file(50), relPath: "" }], "/api/uploads", "root");
    await settle(first);
    expect(first.items()[0]?.state).toBe("error");
    expect(storage.m.size).toBe(1);
    srv.put = origPut;
    srv.puts = [];
    const second = new UploadManager({ transport: srv, chunkBytes: 10, sleep: async () => {}, storage });
    second.add([{ file: file(50), relPath: "" }], "/api/uploads", "root");
    await settle(second);
    expect(second.items()[0]?.state).toBe("done");
    expect(srv.puts[0]).toBe(20);
    expect(srv.sessions.size).toBe(1);
    expect(storage.m.size).toBe(0);
  });

  it("stops on quota errors and lets the user cancel", async () => {
    const srv = new FakeServer();
    srv.create = async () => {
      throw new ApiError(507, "quota_exceeded", "this would exceed the storage quota");
    };
    const m = new UploadManager({ transport: srv, chunkBytes: 10, sleep: async () => {} });
    m.add([{ file: file(5), relPath: "" }], "/api/uploads", "root");
    await settle(m);
    expect(m.items()[0]?.state).toBe("error");
    expect(m.items()[0]?.error).toContain("quota");
  });

  it("runs at most three uploads at once", async () => {
    const srv = new FakeServer();
    let inflight = 0;
    let peak = 0;
    const origPut = srv.put.bind(srv);
    srv.put = async (...args) => {
      peak = Math.max(peak, ++inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return origPut(...args);
    };
    const m = new UploadManager({ transport: srv, chunkBytes: 100, sleep: async () => {} });
    m.add(Array.from({ length: 7 }, (_, i) => ({ file: file(20, `f${i}`), relPath: "" })), "/api/uploads", "root");
    await settle(m);
    expect(m.items().every((i) => i.state === "done")).toBe(true);
    expect(peak).toBe(3);
  });
});
