// Typed client for the storage API (see ../API.md). Every mutating request
// carries X-Requested-With: fetch, which the server requires.

export type Kind =
  | "folder" | "image" | "video" | "audio" | "pdf" | "markdown" | "json" | "csv"
  | "code" | "text" | "archive" | "office" | "other";

export interface Node {
  id: string;
  parentId: string | null;
  name: string;
  isDir: boolean;
  size: number;
  kind: Kind;
  mime: string;
  language?: string;
  thumbnail: boolean;
  owner: string;
  starred: boolean;
  createdAt: string;
  modifiedAt: string;
  permission?: string;
  /** Who can reach the viewer's own nodes (absent when nobody else can). */
  sharing?: { people: { username: string; permission: "read" | "edit" }[]; links: number; linkExpiresAt: string | null };
}

export interface Crumb { id: string; name: string }

export type Permission = "owner" | "edit" | "read" | "drop";

export interface Folder {
  node: Node;
  permission: Permission;
  crumbs: Crumb[];
  viaShare?: boolean;
  items: Node[];
}

export interface User {
  id: number;
  username: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  quotaBytes: number;
  rootId: string;
}

export interface Usage { usedBytes: number; reservedBytes: number; quotaBytes: number; files: number }

export interface Me {
  user: User;
  usage: Usage;
  apps: { name: string; url: string }[];
  logoutUrl: string;
  maxFileBytes: number;
  chunkBytes: number;
  textPreviewCap: number;
  publicUrl: string;
}

export interface Share { id: string; nodeId: string; username: string; permission: "read" | "edit"; createdAt: string }

export interface Link {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeIsDir: boolean;
  owner: string;
  kind: "view" | "drop";
  hasPassword: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  status: "active" | "revoked" | "expired" | "exhausted";
}

export interface TrashItem extends Node { trashedAt: string; fromFolder: string; purgeAt: string }

export interface ActivityEntry { actor: string; action: string; detail: string; createdAt: string }

export interface ArchiveListing {
  entries: { name: string; size: number; compressed: number; modified: string; isDir: boolean }[];
  total: number;
  truncated: boolean;
}

export interface AdminUser extends User {
  placeholder: boolean;
  lastSeenAt: string | null;
  usedBytes: number;
  reservedBytes: number;
  files: number;
  shares: number;
  links: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") headers.set("X-Requested-With", "fetch");
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  // The SSO proxy answers an expired session with a redirect to the sign-in
  // page; never follow it from a fetch. Reloading goes through sign-in.
  const res = await fetch(url, { ...init, method, headers, body: payload, credentials: "same-origin", redirect: "manual" });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    signedOut(url);
    throw new ApiError(401, "signed_out", "your session ended; sign in again");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    if (res.status === 401) signedOut(url);
    throw new ApiError(res.status, err?.code ?? "http_" + res.status, err?.message ?? res.statusText, data);
  }
  return data as T;
}

/** Reloads the page (through sign-in) when a private call finds the session gone. */
export function signedOut(url: string) {
  if (!url.startsWith("/api/public/")) window.location.reload();
}

export const get = <T>(url: string) => request<T>("GET", url);
export const post = <T>(url: string, body?: unknown) => request<T>("POST", url, body);
export const patch = <T>(url: string, body?: unknown) => request<T>("PATCH", url, body);
export const put = <T>(url: string, body?: unknown) => request<T>("PUT", url, body);
export const del = <T>(url: string) => request<T>("DELETE", url);

/**
 * Where a viewer reads file bytes from: the signed-in API or a public link.
 * Both expose the same per-node endpoints.
 */
export interface Source {
  /** Prefix for node URLs, e.g. "/api" or "/api/public/<token>". */
  base: string;
  isPublic: boolean;
}

export const privateSource: Source = { base: "/api", isPublic: false };
export const publicSource = (token: string): Source => ({ base: `/api/public/${encodeURIComponent(token)}`, isPublic: true });

export const nodeUrl = (src: Source, id: string, what: "content" | "raw" | "office-preview" | "archive" | "children" | "" = "") =>
  `${src.base}/nodes/${encodeURIComponent(id)}${what ? "/" + what : ""}`;

export const thumbUrl = (src: Source, n: Node, size = 256) =>
  `${src.base}/nodes/${encodeURIComponent(n.id)}/thumbnail?size=${size}&v=${encodeURIComponent(n.modifiedAt)}`;

export const zipUrl = (src: Source, ids: string[]) => {
  const q = ids.map((id) => "id=" + encodeURIComponent(id)).join("&");
  return src.isPublic ? `${src.base}/zip${q ? "?" + q : ""}` : `/api/zip?${q}`;
};

/** Starts a browser download without leaving the page. */
export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
