// The upload manager: queues files, sends them in chunks, survives dropped
// connections by asking the server for its offset and continuing from there,
// and remembers session ids so the same file dropped again after a reload
// resumes instead of starting over.

import { ApiError, signedOut } from "./api";

export interface SessionInfo { id: string; offset: number; size: number }

export interface ChunkResult { upload: SessionInfo; node?: { id: string; name: string } }

/** The HTTP calls the manager makes; swapped for a fake in tests. */
export interface Transport {
  create(base: string, body: { parentId: string; name: string; size: number; relativePath: string }): Promise<ChunkResult>;
  status(base: string, id: string): Promise<ChunkResult>;
  put(base: string, id: string, offset: number, chunk: Blob, onProgress: (sent: number) => void, signal: AbortSignal): Promise<ChunkResult>;
  cancel(base: string, id: string): Promise<void>;
}

export type UploadState = "queued" | "uploading" | "retrying" | "done" | "error" | "cancelled";

export interface UploadItem {
  key: string;
  name: string;
  relPath: string;
  size: number;
  state: UploadState;
  /** Bytes the server has confirmed plus bytes in flight. */
  sent: number;
  error?: string;
  nodeId?: string;
  /** Bytes per second, smoothed. */
  rate: number;
}

export interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

interface Job {
  item: UploadItem;
  file: Blob;
  base: string;
  parentId: string;
  lastModified: number;
  sessionId?: string;
  abort?: AbortController;
  onDone?: () => void;
}

export interface ManagerOptions {
  transport: Transport;
  chunkBytes: number;
  concurrency?: number;
  storage?: Store;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Delay before retry attempt n (0-based): 1 s, 2 s, 4 s … capped at 30 s. */
export function backoff(n: number): number {
  return Math.min(30_000, 1000 * 2 ** n);
}

/** Splits [offset, size) into chunk ranges. */
export function chunkRanges(offset: number, size: number, chunk: number): [number, number][] {
  const out: [number, number][] = [];
  for (let start = offset; start < size; start += chunk) out.push([start, Math.min(size, start + chunk)]);
  return out;
}

let seq = 0;

export class UploadManager {
  private jobs: Job[] = [];
  private active = 0;
  private listeners = new Set<() => void>();
  private snapshot: UploadItem[] = [];
  private readonly opts: Required<Omit<ManagerOptions, "storage">> & { storage?: Store };

  constructor(opts: ManagerOptions) {
    this.opts = { concurrency: 3, sleep: defaultSleep, maxRetries: 8, ...opts };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  items = () => this.snapshot;

  private emit() {
    this.snapshot = this.jobs.map((j) => ({ ...j.item }));
    this.listeners.forEach((fn) => fn());
  }

  /** Queues files. relPath is the folder path inside a dropped folder ("" for loose files). */
  add(files: { file: File | (Blob & { name: string; lastModified?: number }); relPath: string }[], base: string, parentId: string, onDone?: () => void) {
    for (const { file, relPath } of files) {
      const item: UploadItem = { key: `u${++seq}`, name: file.name, relPath, size: file.size, state: "queued", sent: 0, rate: 0 };
      this.jobs.push({ item, file, base, parentId, lastModified: (file as File).lastModified ?? 0, onDone });
    }
    this.emit();
    this.pump();
  }

  cancel(key: string) {
    const job = this.jobs.find((j) => j.item.key === key);
    if (!job || job.item.state === "done" || job.item.state === "cancelled") return;
    job.item.state = "cancelled";
    job.abort?.abort();
    this.forget(job);
    if (job.sessionId) {
      // The server may still be finishing the aborted chunk; try a few times.
      const id = job.sessionId;
      void (async () => {
        for (let i = 0; i < 5; i++) {
          try {
            await this.opts.transport.cancel(job.base, id);
            return;
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) return;
            await this.opts.sleep(500 * (i + 1));
          }
        }
      })();
    }
    this.emit();
  }

  cancelAll() {
    this.jobs.filter((j) => j.item.state === "queued" || j.item.state === "uploading" || j.item.state === "retrying").forEach((j) => this.cancel(j.item.key));
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => !["done", "cancelled", "error"].includes(j.item.state));
    this.emit();
  }

  retry(key: string) {
    const job = this.jobs.find((j) => j.item.key === key);
    if (!job || job.item.state !== "error") return;
    job.item.state = "queued";
    job.item.error = undefined;
    this.emit();
    this.pump();
  }

  private memoKey(job: Job) {
    const { base, parentId, item, lastModified } = job;
    return `storage.upload:${base}:${parentId}:${item.relPath}/${item.name}:${item.size}:${lastModified}`;
  }

  private remember(job: Job) {
    try {
      if (job.sessionId) this.opts.storage?.setItem(this.memoKey(job), job.sessionId);
    } catch {
      /* storage may be unavailable */
    }
  }

  private forget(job: Job) {
    try {
      this.opts.storage?.removeItem(this.memoKey(job));
    } catch {
      /* storage may be unavailable */
    }
  }

  private pump() {
    while (this.active < this.opts.concurrency) {
      const job = this.jobs.find((j) => j.item.state === "queued");
      if (!job) return;
      this.active++;
      job.item.state = "uploading";
      this.emit();
      void this.run(job).finally(() => {
        this.active--;
        this.emit();
        this.pump();
      });
    }
  }

  private async run(job: Job) {
    const t = this.opts.transport;
    const { item } = job;
    // cancel() changes the state from outside while this runs.
    const cancelled = () => (item.state as UploadState) === "cancelled";
    try {
      let info: ChunkResult | undefined;
      // Resume a session left by an earlier page load, if the server still has it.
      let saved: string | null = null;
      try {
        saved = this.opts.storage?.getItem(this.memoKey(job)) ?? null;
      } catch {
        saved = null;
      }
      if (saved) {
        try {
          info = await t.status(job.base, saved);
          job.sessionId = saved;
        } catch {
          this.forget(job);
        }
      }
      if (!info) {
        info = await t.create(job.base, { parentId: job.parentId, name: item.name, size: item.size, relativePath: item.relPath });
        job.sessionId = info.upload.id;
        if (info.node) return this.finish(job, info);
        this.remember(job);
      }
      let offset = info.upload.offset;
      item.sent = offset;
      let failures = 0;
      while (offset < item.size) {
        if (cancelled()) return;
        const end = Math.min(item.size, offset + this.opts.chunkBytes);
        job.abort = new AbortController();
        const started = performance.now();
        const base = offset;
        try {
          const res = await t.put(job.base, job.sessionId!, offset, job.file.slice(offset, end), (n) => {
            item.sent = base + n;
            const secs = (performance.now() - started) / 1000;
            if (secs > 0.2) item.rate = item.rate ? item.rate * 0.7 + (n / secs) * 0.3 : n / secs;
            this.emit();
          }, job.abort.signal);
          failures = 0;
          offset = res.upload.offset;
          item.sent = offset;
          item.state = "uploading";
          if (res.node) return this.finish(job, res);
        } catch (e) {
          if (cancelled()) return;
          if (e instanceof ApiError && e.code === "offset_mismatch") {
            offset = (e.body as { upload?: SessionInfo })?.upload?.offset ?? offset;
            continue;
          }
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 409 && e.status !== 429) throw e;
          if (failures >= this.opts.maxRetries) throw e;
          item.state = "retrying";
          this.emit();
          await this.opts.sleep(backoff(failures++));
          if (cancelled()) return;
          // Ask the server what it kept; the bytes before that are not sent again.
          try {
            const st = await t.status(job.base, job.sessionId!);
            offset = st.upload.offset;
            item.sent = offset;
          } catch (se) {
            if (se instanceof ApiError && se.status === 404) throw se;
          }
          item.state = "uploading";
        }
      }
    } catch (e) {
      if (cancelled()) return;
      item.state = "error";
      item.error = e instanceof ApiError ? e.message : "The connection failed. Try again.";
      if (e instanceof ApiError && e.status === 404) this.forget(job);
    }
  }

  private finish(job: Job, res: ChunkResult) {
    job.item.state = "done";
    job.item.sent = job.item.size;
    job.item.nodeId = res.node?.id;
    this.forget(job);
    job.onDone?.();
  }
}

/** The real transport: fetch for JSON calls, XHR for chunks (upload progress). */
export function httpTransport(): Transport {
  const json = async (method: string, url: string, body?: unknown): Promise<ChunkResult> => {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      redirect: "manual",
      headers: { "X-Requested-With": "fetch", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      signedOut(url);
      throw new ApiError(401, "signed_out", "your session ended; sign in again");
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "http_" + res.status, data?.error?.message ?? res.statusText, data);
    return data;
  };
  return {
    create: (base, body) => json("POST", base, body),
    status: (base, id) => json("GET", `${base}/${id}`),
    cancel: async (base, id) => {
      await json("DELETE", `${base}/${id}`);
    },
    put: (base, id, offset, chunk, onProgress, signal) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `${base}/${id}`);
        xhr.setRequestHeader("X-Requested-With", "fetch");
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.setRequestHeader("Upload-Offset", String(offset));
        xhr.upload.onprogress = (ev) => onProgress(ev.loaded);
        xhr.onload = () => {
          let data: any = {};
          try {
            data = JSON.parse(xhr.responseText || "{}");
          } catch {
            data = {};
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new ApiError(xhr.status, data?.error?.code ?? "http_" + xhr.status, data?.error?.message ?? "Upload failed", data));
        };
        xhr.onerror = () => reject(new Error("network"));
        xhr.ontimeout = () => reject(new Error("timeout"));
        signal.addEventListener("abort", () => xhr.abort());
        xhr.onabort = () => reject(new Error("aborted"));
        xhr.send(chunk);
      }),
  };
}

/** Reads dropped items, walking into folders. */
export async function filesFromDrop(dt: DataTransfer): Promise<{ file: File; relPath: string }[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const e = item.kind === "file" ? item.webkitGetAsEntry?.() : null;
    if (e) entries.push(e);
  }
  if (entries.length === 0) return Array.from(dt.files).map((file) => ({ file, relPath: "" }));
  const out: { file: File; relPath: string }[] = [];
  const walk = async (entry: FileSystemEntry, dir: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, relPath: dir });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, path);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

/** Files from an <input type=file>, with folder paths for webkitdirectory pickers. */
export function filesFromInput(list: FileList): { file: File; relPath: string }[] {
  return Array.from(list).map((file) => {
    const rel = file.webkitRelativePath || "";
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    return { file, relPath: dir };
  });
}
