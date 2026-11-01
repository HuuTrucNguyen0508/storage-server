/**
 * The only module that speaks HTTP to the JSON API. Wire shapes end here: a
 * response is parsed into the types below, or it throws.
 */

export type EntryKind = "file" | "dir" | "symlink" | "other";
export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text";

export interface Entry {
  name: string;
  kind: EntryKind;
  size: number;
  modTime: Date;
  preview: PreviewKind | null;
}

export interface Listing {
  path: string;
  entries: Entry[];
}

export interface SearchHit {
  path: string;
  name: string;
  kind: EntryKind;
  size: number;
  modTime: Date;
}

export interface SessionState {
  setupRequired: boolean;
  authenticated: boolean;
}

export interface LoginSession {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  userAgent: string;
  ip: string;
  current: boolean;
}

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  kind: EntryKind;
  deletedAt: Date;
  purgeAt: Date;
}

export type ShareKind = "link" | "drop";
export type ShareState = "active" | "expired" | "exhausted" | "suspended" | "missing";

export interface Share {
  id: string;
  kind: ShareKind;
  url: string;
  path: string;
  state: ShareState;
  uses: number;
  maxUses: number | null;
  expiresAt: Date | null;
  hasPassword: boolean;
  createdAt: Date;
}

export interface ShareRequest {
  path: string;
  kind: ShareKind;
  password?: string;
  expiresAt?: Date;
  maxUses?: number;
}

export interface LinkFacts {
  kind: ShareKind;
  name: string;
  isFolder: boolean;
  size: number | null;
  passwordRequired: boolean;
  expiresAt: Date | null;
}

export type ItemResult<T> = { path: string; ok: T } | { path: string; error: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A response that does not match the contract. A bug, never a user error. */
export class WireError extends Error {
  constructor(what: string) {
    super(`unexpected response: ${what}`);
    this.name = "WireError";
  }
}

type Json = Record<string, unknown>;

function asObject(v: unknown, what: string): Json {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new WireError(`${what} is not an object`);
  return v as Json;
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new WireError(`${what} is not an array`);
  return v;
}

function str(o: Json, key: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new WireError(`${key} is not a string`);
  return v;
}

function num(o: Json, key: string): number {
  const v = o[key];
  if (typeof v !== "number") throw new WireError(`${key} is not a number`);
  return v;
}

function bool(o: Json, key: string): boolean {
  const v = o[key];
  if (typeof v !== "boolean") throw new WireError(`${key} is not a boolean`);
  return v;
}

function date(o: Json, key: string): Date {
  const parsed = new Date(str(o, key));
  if (Number.isNaN(parsed.getTime())) throw new WireError(`${key} is not a time`);
  return parsed;
}

function nullable<T>(o: Json, key: string, read: (o: Json, key: string) => T): T | null {
  return o[key] === null || o[key] === undefined ? null : read(o, key);
}

function oneOf<const T extends string>(o: Json, key: string, allowed: readonly T[]): T {
  const v = str(o, key);
  if (!(allowed as readonly string[]).includes(v)) throw new WireError(`${key} is ${JSON.stringify(v)}`);
  return v as T;
}

const ENTRY_KINDS = ["file", "dir", "symlink", "other"] as const;
const PREVIEW_KINDS = ["image", "video", "audio", "pdf", "text", ""] as const;

function parseEntry(v: unknown): Entry {
  const o = asObject(v, "entry");
  const preview = oneOf(o, "preview", PREVIEW_KINDS);
  return {
    name: str(o, "name"),
    kind: oneOf(o, "kind", ENTRY_KINDS),
    size: num(o, "size"),
    modTime: date(o, "modTime"),
    preview: preview === "" ? null : preview,
  };
}

function parseListing(v: unknown): Listing {
  const o = asObject(v, "listing");
  return { path: str(o, "path"), entries: asArray(o.entries, "entries").map(parseEntry) };
}

function parseShare(v: unknown): Share {
  const o = asObject(v, "share");
  return {
    id: str(o, "id"),
    kind: oneOf(o, "kind", ["link", "drop"]),
    url: str(o, "url"),
    path: str(o, "path"),
    state: oneOf(o, "state", ["active", "expired", "exhausted", "suspended", "missing"]),
    uses: num(o, "uses"),
    maxUses: nullable(o, "maxUses", num),
    expiresAt: nullable(o, "expiresAt", date),
    hasPassword: bool(o, "hasPassword"),
    createdAt: date(o, "createdAt"),
  };
}

function parseTrashItem(v: unknown): TrashItem {
  const o = asObject(v, "trash item");
  return {
    id: str(o, "id"),
    name: str(o, "name"),
    originalPath: str(o, "originalPath"),
    kind: oneOf(o, "kind", ENTRY_KINDS),
    deletedAt: date(o, "deletedAt"),
    purgeAt: date(o, "purgeAt"),
  };
}

function parseLoginSession(v: unknown): LoginSession {
  const o = asObject(v, "session");
  return {
    id: str(o, "id"),
    createdAt: date(o, "createdAt"),
    lastSeenAt: date(o, "lastSeenAt"),
    userAgent: str(o, "userAgent"),
    ip: str(o, "ip"),
    current: bool(o, "current"),
  };
}

function parseLinkFacts(v: unknown): LinkFacts {
  const o = asObject(v, "link");
  return {
    kind: oneOf(o, "kind", ["link", "drop"]),
    name: str(o, "name"),
    isFolder: bool(o, "isFolder"),
    size: nullable(o, "size", num),
    passwordRequired: bool(o, "passwordRequired"),
    expiresAt: nullable(o, "expiresAt", date),
  };
}

function parseResults<T>(v: unknown, read: (o: Json) => T): ItemResult<T>[] {
  const o = asObject(v, "results");
  return asArray(o.results, "results").map((item) => {
    const r = asObject(item, "result");
    const path = str(r, "path");
    return typeof r.error === "string" ? { path, error: r.error } : { path, ok: read(r) };
  });
}

function parseSearchHit(o: Json): SearchHit {
  return {
    path: str(o, "path"),
    name: str(o, "name"),
    kind: oneOf(o, "kind", ENTRY_KINDS),
    size: num(o, "size"),
    modTime: date(o, "modTime"),
  };
}

async function failure(res: Response): Promise<ApiError> {
  const retry = res.headers.get("Retry-After");
  const retryAfter = retry === null ? null : Number(retry);
  try {
    const body = asObject(await res.json(), "error body");
    const error = asObject(body.error, "error");
    return new ApiError(res.status, str(error, "code"), str(error, "message"), retryAfter);
  } catch {
    return new ApiError(res.status, "unknown", res.statusText, retryAfter);
  }
}

let onUnauthenticated: () => void = () => {};

export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  // Chrome keeps a 410 fresh forever when it has no Cache-Control, so a link that
  // came back from the trash would stay broken for anyone who saw it there.
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  if (res.ok) return res;
  const err = await failure(res);
  if (err.code === "unauthenticated") onUnauthenticated();
  throw err;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export async function readNdjson(body: ReadableStream<Uint8Array>, onValue: (value: unknown) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim() !== "") onValue(JSON.parse(line));
    }
    if (done) return;
  }
}

export interface ContentSource {
  contentUrl(path: string): string;
  downloadUrl(path: string): string;
  thumbUrl(path: string, width: 256 | 1024): string;
}

export type SearchEnd = { truncated: boolean };

export const owner = {
  async session(): Promise<SessionState> {
    const o = asObject(await (await call("/api/session")).json(), "session");
    return { setupRequired: bool(o, "setupRequired"), authenticated: bool(o, "authenticated") };
  },
  async setup(code: string, password: string): Promise<void> {
    await call("/api/setup", jsonInit("POST", { code, password }));
  },
  async login(password: string): Promise<void> {
    await call("/api/login", jsonInit("POST", { password }));
  },
  async logout(): Promise<void> {
    await call("/api/logout", { method: "POST" });
  },
  async changePassword(current: string, next: string): Promise<void> {
    await call("/api/account/password", jsonInit("POST", { current, new: next }));
  },
  async sessions(): Promise<LoginSession[]> {
    return asArray(await (await call("/api/sessions")).json(), "sessions").map(parseLoginSession);
  },
  async revokeSession(id: string): Promise<void> {
    await call(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async list(path: string): Promise<Listing> {
    return parseListing(await (await call(`/api/files?${query({ path })}`)).json());
  },
  async mkdir(path: string): Promise<void> {
    await call("/api/files/folder", jsonInit("POST", { path }));
  },
  async rename(path: string, name: string): Promise<string> {
    return str(asObject(await (await call("/api/files/rename", jsonInit("POST", { path, name }))).json(), "rename"), "path");
  },
  async move(paths: string[], to: string): Promise<ItemResult<string>[]> {
    const res = await call("/api/files/move", jsonInit("POST", { paths, to }));
    return parseResults(await res.json(), (r) => str(r, "newPath"));
  },
  async trash(paths: string[]): Promise<ItemResult<string>[]> {
    const res = await call("/api/files/trash", jsonInit("POST", { paths }));
    return parseResults(await res.json(), (r) => str(r, "trashId"));
  },
  async search(q: string, path: string, onHit: (hit: SearchHit) => void, signal: AbortSignal): Promise<SearchEnd> {
    const res = await call(`/api/search?${query({ q, path })}`, { signal });
    if (res.body === null) throw new WireError("search has no body");
    let end: SearchEnd | null = null;
    await readNdjson(res.body, (value) => {
      const o = asObject(value, "search line");
      if (o.done === true) end = { truncated: bool(o, "truncated") };
      else onHit(parseSearchHit(o));
    });
    if (end === null) throw new WireError("search stream ended without a last line");
    return end;
  },
  async listTrash(): Promise<TrashItem[]> {
    return asArray(await (await call("/api/trash")).json(), "trash").map(parseTrashItem);
  },
  async emptyTrash(): Promise<void> {
    await call("/api/trash", { method: "DELETE" });
  },
  async restore(id: string): Promise<string> {
    const res = await call(`/api/trash/${encodeURIComponent(id)}/restore`, { method: "POST" });
    return str(asObject(await res.json(), "restore"), "path");
  },
  async purge(id: string): Promise<void> {
    await call(`/api/trash/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async shares(): Promise<Share[]> {
    return asArray(await (await call("/api/shares")).json(), "shares").map(parseShare);
  },
  async createShare(req: ShareRequest): Promise<Share> {
    const body = { ...req, expiresAt: req.expiresAt?.toISOString() };
    return parseShare(await (await call("/api/shares", jsonInit("POST", body))).json());
  },
  async revokeShare(id: string): Promise<void> {
    await call(`/api/shares/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  source: {
    contentUrl: (path: string) => `/api/files/content?${query({ path })}`,
    downloadUrl: (path: string) => `/api/files/content?${query({ path })}&download`,
    thumbUrl: (path: string, w: 256 | 1024) => `/api/files/thumb?${query({ path, w: String(w) })}`,
  } satisfies ContentSource,
  zipUrl: "/api/files/zip",
};

export function contentKind(contentType: string | null): PreviewKind | null {
  const type = (contentType ?? "").split(";")[0]?.trim() ?? "";
  if (type === "application/pdf") return "pdf";
  if (type === "text/plain") return "text";
  for (const kind of ["image", "video", "audio"] as const) {
    if (type.startsWith(`${kind}/`)) return kind;
  }
  return null;
}

/** What a preview can show of a file, from the policy's own Content-Type. HEAD spends no guest use. */
export async function previewKindAt(url: string): Promise<PreviewKind | null> {
  return contentKind((await call(url, { method: "HEAD" })).headers.get("Content-Type"));
}

export type GuestApi = ReturnType<typeof guest>;

export function guest(token: string) {
  const base = `/api/public/${encodeURIComponent(token)}`;
  return {
    async facts(): Promise<LinkFacts> {
      return parseLinkFacts(await (await call(base)).json());
    },
    async open(password?: string): Promise<void> {
      await call(`${base}/open`, jsonInit("POST", password === undefined ? {} : { password }));
    },
    async list(path: string): Promise<Listing> {
      return parseListing(await (await call(`${base}/files?${query({ path })}`)).json());
    },
    source: {
      contentUrl: (path: string) => `${base}/content?${query({ path })}`,
      downloadUrl: (path: string) => `${base}/content?${query({ path })}&download`,
      thumbUrl: (path: string, w: 256 | 1024) => `${base}/thumb?${query({ path, w: String(w) })}`,
    } satisfies ContentSource,
    zipUrl: `${base}/zip`,
    uploadEndpoint: `${base}/uploads`,
  };
}

export const OWNER_UPLOADS = "/api/uploads";

/** Posts a form into a hidden frame so a failure answer never replaces the page. */
export function postDownload(url: string, paths: readonly string[]): void {
  const frame = "download-frame";
  if (document.getElementById(frame) === null) {
    const iframe = document.createElement("iframe");
    iframe.id = frame;
    iframe.name = frame;
    iframe.hidden = true;
    document.body.append(iframe);
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.target = frame;
  for (const path of paths) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "path";
    input.value = path;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
  form.remove();
}

