// Server-sent events over fetch, so the client can send Last-Event-ID itself,
// see the SSO redirect when a session ends, and notice heartbeats.

export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/** Incremental text/event-stream parser (WHATWG rules for fields, comments and line ends). */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  private hasId = false;

  /** Feeds a decoded chunk; returns the messages it completed and how many comment lines it saw. */
  feed(chunk: string): { messages: SseMessage[]; comments: number } {
    this.buf += chunk;
    const messages: SseMessage[] = [];
    let comments = 0;
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      if (!m) break;
      // A lone \r at the very end may be the first half of \r\n.
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      if (line === "") {
        if (this.data.length) messages.push({ id: this.hasId ? this.id : null, event: this.event || "message", data: this.data.join("\n") });
        this.data = [];
        this.event = "";
        this.hasId = false;
        continue;
      }
      if (line.startsWith(":")) {
        comments++;
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
      else if (field === "event") this.event = value;
      else if (field === "id" && !value.includes("\0")) {
        this.id = value;
        this.hasId = true;
      }
    }
    return { messages, comments };
  }
}

export type StreamState = "connecting" | "live" | "reconnecting";

export interface StreamOptions {
  url: string;
  lastEventId: () => string | null;
  onMessages: (m: SseMessage[]) => void;
  onState: (s: StreamState) => void;
  onSignedOut: () => void;
  fetchImpl?: typeof fetch;
  /** Silence longer than this means the connection is dead (heartbeats come every second). */
  staleMs?: number;
}

/**
 * Keeps one stream open: reconnects with backoff (1 s doubling to 30 s, with
 * jitter), resumes from the last event ID, and reports a redirect as signed out.
 * Returns a stop function.
 */
export function openStream(o: StreamOptions): () => void {
  const f = o.fetchImpl ?? fetch.bind(globalThis);
  const staleMs = o.staleMs ?? 15_000;
  let stopped = false;
  let attempt = 0;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = async () => {
    if (stopped) return;
    ctrl = new AbortController();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    const last = o.lastEventId();
    if (last) headers["Last-Event-ID"] = last;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const pet = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl?.abort(), staleMs);
    };
    try {
      pet();
      const res = await f(o.url, { headers, credentials: "same-origin", redirect: "manual", signal: ctrl.signal, cache: "no-store" });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400) || res.status === 401) {
        stopped = true;
        o.onSignedOut();
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      let first = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pet();
        const { messages } = parser.feed(value);
        if (first && (messages.length || value.length)) {
          first = false;
          attempt = 0;
          o.onState("live");
        }
        if (messages.length) o.onMessages(messages);
      }
    } catch {
      /* fall through to reconnect */
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    if (stopped) return;
    o.onState("reconnecting");
    const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    attempt = Math.min(attempt + 1, 5);
    timer = setTimeout(run, delay);
  };

  o.onState("connecting");
  void run();
  const online = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      void run();
    }
  };
  window.addEventListener("online", online);
  return () => {
    stopped = true;
    window.removeEventListener("online", online);
    if (timer) clearTimeout(timer);
    ctrl?.abort();
  };
}
