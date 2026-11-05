// Fetch helper for the todo API. Mutations carry X-Requested-With: fetch, as
// docs/architecture.md requires. The SSO proxy answers an expired session with
// a redirect to the sign-in page; a fetch never follows it, and the page
// reloads instead so the browser goes through sign-in.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
  /** Network failures and server errors may succeed on retry; 4xx never will. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

let onSignedOut = () => window.location.reload();
/** Tests replace the reload. */
export function setSignedOutHandler(f: () => void) {
  onSignedOut = f;
}

export function isRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

export async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") headers.set("X-Requested-With", "fetch");
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, method, headers, body: payload, credentials: "same-origin", redirect: "manual" });
  } catch {
    throw new ApiError(0, "You're offline or the server didn't answer");
  }
  if (isRedirect(res)) {
    onSignedOut();
    throw new ApiError(401, "Your session ended. Sign in again");
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401) onSignedOut();
    const msg = (data as { error?: unknown } | undefined)?.error;
    throw new ApiError(res.status, typeof msg === "string" ? msg : res.statusText || `HTTP ${res.status}`, data);
  }
  return data as T;
}

export const get = <T>(url: string, init?: RequestInit) => request<T>("GET", url, undefined, init);
export const post = <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {});
export const patch = <T>(url: string, body: unknown) => request<T>("PATCH", url, body);
export const del = <T>(url: string) => request<T>("DELETE", url);

/** Error text for a toast: what went wrong, ending in a full stop. */
export function errorText(e: unknown): string {
  const m = e instanceof Error && e.message ? e.message : "That didn't work";
  const s = m[0]!.toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : s + ".";
}
