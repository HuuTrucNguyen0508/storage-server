import { defaultOptions, Upload, type HttpResponse, type PreviousUpload } from "tus-js-client";
import { nextToStart, restorable, uploadsReducer, type NewUpload, type UploadEvent, type UploadItem } from "./machine";

const CHUNK_SIZE = 64 * 1024 * 1024;
const CONCURRENT = 3;
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 20_000, ...Array<number>(40).fill(30_000)];

export interface PickedFile {
  relativePath: string;
  file: File;
}

export type UploadTarget =
  | { kind: "owner"; endpoint: string; destination: (relativePath: string) => string }
  | { kind: "drop"; token: string; endpoint: string; destination: (relativePath: string) => string };

const FAILURE_WORDS: Record<string, string> = {
  insufficient_space: "The disk is too full for this file",
  exists: "A file is using one of the folder names on this path",
  symlink_refused: "A folder on this path is a symlink",
  reserved_name: "That name is reserved by the server",
  invalid_path: "This name cannot be stored here",
  unauthenticated: "Sign in again, then retry",
  open_required: "Reload this page, then retry",
  expired: "This link no longer takes files",
  exhausted: "This link no longer takes files",
  unavailable: "This link no longer takes files",
};

function reasonOf(error: Error): string {
  const response = "originalResponse" in error ? (error.originalResponse as HttpResponse | null) : null;
  if (response === null) return "The connection was lost. Retry to continue";
  try {
    const code = (JSON.parse(response.getBody()) as { error?: { code?: string } }).error?.code;
    if (code !== undefined && code in FAILURE_WORDS) return FAILURE_WORDS[code] as string;
  } catch {
  }
  return "The server refused this upload";
}

export class UploadEngine {
  private items: UploadItem[] = [];
  private listeners = new Set<() => void>();
  private files = new Map<string, File>();
  private running = new Map<string, Upload>();
  private stored = new Map<string, string | null>();
  private readonly storageKey: string;

  constructor(private readonly target: UploadTarget) {
    this.storageKey = target.kind === "owner" ? "storage.uploads" : `storage.uploads.${target.token}`;
    this.restore();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): readonly UploadItem[] => this.items;

  private dispatch(event: UploadEvent): void {
    this.items = uploadsReducer(this.items, event);
    this.persist();
    for (const listener of this.listeners) listener();
    this.pump();
  }

  private persist(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.items.filter((i) => i.state.tag !== "done")));
    } catch {
    }
  }

  private restore(): void {
    let saved: UploadItem[] = [];
    try {
      saved = restorable(JSON.parse(localStorage.getItem(this.storageKey) ?? "[]") as UploadItem[]);
    } catch {
      return;
    }
    if (saved.length === 0) return;
    this.dispatch({ type: "restored", items: saved });
    for (const item of saved) void this.reconcile(item);
  }

  /** The stored offset lags a chunk behind, and the last answer may have been lost. */
  private async reconcile(item: UploadItem): Promise<void> {
    const latest = (await this.previous(item))[0];
    if (typeof latest?.uploadUrl !== "string") return;
    const res = await fetch(latest.uploadUrl, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } }).catch(() => null);
    if (res === null) return;
    if (!res.ok) {
      if (res.status === 404) this.dispatch({ type: "offsetKnown", id: item.id, stored: 0 });
      return;
    }
    const offset = Number(res.headers.get("Upload-Offset"));
    if (offset < item.size) {
      this.dispatch({ type: "offsetKnown", id: item.id, stored: offset });
      return;
    }
    await defaultOptions.urlStorage.removeUpload(latest.urlStorageKey);
    this.dispatch({ type: "finished", id: item.id, storedPath: res.headers.get("X-Stored-Path") });
  }

  private fingerprint(item: Fingerprinted): string {
    const scope = this.target.kind === "owner" ? "owner" : this.target.token;
    return ["storage", scope, item.path, item.size, item.lastModified].join("|");
  }

  private previous(item: UploadItem): Promise<PreviousUpload[]> {
    return defaultOptions.urlStorage.findUploadsByFingerprint(this.fingerprint(item));
  }

  add(picks: readonly PickedFile[]): void {
    const uploads = picks.map(({ relativePath, file }): NewUpload => {
      const id = crypto.randomUUID();
      this.files.set(id, file);
      return {
        id,
        path: this.target.destination(relativePath),
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      };
    });
    this.dispatch({ type: "added", uploads });
  }

  async pick(id: string, file: File): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (item === undefined) return;
    const same = file.name === item.name && file.size === item.size && file.lastModified === item.lastModified;
    if (!same) await this.discardServerCopy(item);
    this.files.set(id, file);
    this.dispatch({ type: "filePicked", id, same, name: file.name, size: file.size, lastModified: file.lastModified });
  }

  pause(id: string): void {
    this.dispatch({ type: "pauseRequested", id });
    void this.running.get(id)?.abort(false);
    this.running.delete(id);
  }

  resume(id: string): void {
    this.dispatch({ type: "resumeRequested", id });
  }

  async cancel(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    const upload = this.running.get(id);
    this.running.delete(id);
    this.files.delete(id);
    this.dispatch({ type: "removed", id });
    if (upload !== undefined) await upload.abort(true).catch(() => {});
    else if (item !== undefined) await this.discardServerCopy(item);
  }

  clearFinished(): void {
    this.dispatch({ type: "finishedCleared" });
  }

  private async discardServerCopy(item: UploadItem): Promise<void> {
    for (const prev of await this.previous(item)) {
      if (typeof prev.uploadUrl === "string") {
        await fetch(prev.uploadUrl, { method: "DELETE", headers: { "Tus-Resumable": "1.0.0" } }).catch(() => null);
      }
      await defaultOptions.urlStorage.removeUpload(prev.urlStorageKey);
    }
  }

  private pump(): void {
    for (const id of nextToStart(this.items, CONCURRENT)) void this.start(id);
  }

  private async start(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    const file = this.files.get(id);
    if (item === undefined || file === undefined) return;
    this.dispatch({ type: "started", id });

    const upload = new Upload(file, {
      endpoint: new URL(this.target.endpoint, location.origin).toString(),
      chunkSize: CHUNK_SIZE,
      retryDelays: RETRY_DELAYS,
      metadata: { path: item.path },
      urlStorage: defaultOptions.urlStorage,
      fingerprint: () => Promise.resolve(this.fingerprint(item)),
      removeFingerprintOnSuccess: true,
      onProgress: (sent) => this.dispatch({ type: "sent", id, bytes: sent }),
      onChunkComplete: (_size, accepted) => this.dispatch({ type: "stored", id, bytes: accepted }),
      onShouldRetry: (err) => {
        const status = err.originalResponse?.getStatus() ?? 0;
        const retry = status === 0 || status === 408 || status === 409 || status === 423 || (status >= 500 && status !== 507);
        if (retry) this.dispatch({ type: "connectionLost", id });
        return retry;
      },
      onAfterResponse: (_req, res) => {
        const path = res.getHeader("X-Stored-Path");
        if (path !== undefined && path !== "") this.stored.set(id, path);
      },
      onSuccess: () => {
        this.running.delete(id);
        this.files.delete(id);
        this.dispatch({ type: "finished", id, storedPath: this.stored.get(id) ?? null });
      },
      onError: (err) => {
        this.running.delete(id);
        this.dispatch({ type: "failed", id, reason: reasonOf(err) });
      },
    });
    this.running.set(id, upload);
    const previous = await upload.findPreviousUploads();
    if (this.running.get(id) !== upload) return;
    const latest = previous[0];
    if (latest !== undefined) upload.resumeFromPreviousUpload(latest);
    upload.start();
  }
}

type Fingerprinted = Pick<UploadItem, "path" | "size" | "lastModified">;
