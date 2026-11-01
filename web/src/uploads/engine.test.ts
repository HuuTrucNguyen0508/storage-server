import { afterEach, expect, it, vi } from "vitest";
import { defaultOptions } from "tus-js-client";
import { UploadEngine } from "./engine";
import type { UploadItem } from "./machine";

vi.mock("tus-js-client", async (actual) => ({
 ...await actual<typeof import("tus-js-client")>(),
 Upload: class {
  url = null;
  constructor(_file: File, private options: { onError?: (error: Error) => void }) {}
  findPreviousUploads() { return Promise.resolve([]); }
  resumeFromPreviousUpload() {}
  start() { this.options.onError?.(new Error("refused")); }
  abort() { return Promise.resolve(); }
 },
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows a failed publication on reload and keeps the resume record", async () => {
 const item: UploadItem = { id: "u", path: "folder/a.txt", name: "a.txt", size: 4, lastModified: 1, replaced: false, state: { tag: "failed", stored: 0, reason: "old failure" } };
 const storage = new Map([["storage.uploads",JSON.stringify([item])]]);
 vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string,value: string) => storage.set(key,value) });
 vi.spyOn(defaultOptions.urlStorage,"findUploadsByFingerprint").mockResolvedValue([{ urlStorageKey: "resume", uploadUrl: "/api/uploads/u", size: 4, parallelUploadUrls: null, metadata: {}, creationTime: "" }]);
 const remove = vi.spyOn(defaultOptions.urlStorage,"removeUpload").mockResolvedValue();
 vi.stubGlobal("fetch",vi.fn(async () => new Response(null,{status:409})));
 const engine = new UploadEngine({ kind: "owner", endpoint: "/api/uploads", destination: (p) => p });
 await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toEqual({ tag: "failed", stored: 0, reason: "The server refused this upload. Retry to publish it" }));
 expect(JSON.parse(storage.get("storage.uploads") ?? "[]")[0].state.tag).toBe("failed");
 expect(remove).not.toHaveBeenCalled();
 vi.stubGlobal("fetch",vi.fn(async () => new Response(null,{status:200,headers:{"Upload-Offset":"4","X-Stored-Path":"folder/a.txt"}})));
 engine.resume("u");
 await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toEqual({ tag: "done", storedPath: "folder/a.txt" }));
 expect(remove).toHaveBeenCalledWith("resume");
});

it("a late reconciliation response does not ask for a file the engine already holds", async () => {
 const item: UploadItem = { id: "u", path: "a.txt", name: "a.txt", size: 4, lastModified: 1, replaced: false, state: { tag: "needs-file", stored: 0 } };
 const storage = new Map([["storage.uploads",JSON.stringify([item])]]);
 vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string,value: string) => storage.set(key,value) });
 vi.spyOn(defaultOptions.urlStorage,"findUploadsByFingerprint").mockResolvedValue([{ urlStorageKey: "resume", uploadUrl: "/api/uploads/u", size: 4, parallelUploadUrls: null, metadata: {}, creationTime: "" }]);
 vi.stubGlobal("location", { origin: "http://localhost" });
 let answerHead = (_: Response) => {};
 vi.stubGlobal("fetch",vi.fn(() => new Promise<Response>((resolve) => { answerHead = resolve; })));
 const engine = new UploadEngine({ kind: "owner", endpoint: "/api/uploads", destination: (p) => p });
 await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
 await engine.pick("u", new File(["data"],"a.txt",{ lastModified: 1 }));
 await vi.waitFor(() => expect(engine.snapshot()[0]?.state.tag).toBe("failed"));
 const failure = engine.snapshot()[0]?.state;
 answerHead(new Response(null,{status:200,headers:{"Upload-Offset":"2"}}));
 await new Promise((resolve) => setTimeout(resolve,0));
 expect(engine.snapshot()[0]?.state).toEqual(failure);
});
