export type UploadState =
  | { tag: "queued"; stored: number }
  | { tag: "sending"; stored: number; sent: number }
  | { tag: "paused"; stored: number }
  | { tag: "reconnecting"; stored: number }
  | { tag: "needs-file"; stored: number }
  | { tag: "done"; storedPath: string | null }
  | { tag: "failed"; stored: number; reason: string };

export interface UploadItem {
  id: string;
  path: string;
  name: string;
  size: number;
  lastModified: number;
  state: UploadState;
  replaced: boolean;
}

export type NewUpload = Pick<UploadItem, "id" | "path" | "name" | "size" | "lastModified">;

export type UploadEvent =
  | { type: "added"; uploads: NewUpload[] }
  | { type: "restored"; items: UploadItem[] }
  | { type: "started"; id: string }
  | { type: "sent"; id: string; bytes: number }
  | { type: "stored"; id: string; bytes: number }
  | { type: "connectionLost"; id: string }
  | { type: "pauseRequested"; id: string }
  | { type: "resumeRequested"; id: string }
  | { type: "filePicked"; id: string; same: boolean; name: string; size: number; lastModified: number }
  | { type: "offsetKnown"; id: string; stored: number }
  | { type: "finished"; id: string; storedPath: string | null }
  | { type: "failed"; id: string; reason: string }
  | { type: "removed"; id: string }
  | { type: "finishedCleared" };

function storedOf(state: UploadState): number {
  return state.tag === "done" ? 0 : state.stored;
}

function advance(item: UploadItem, event: UploadEvent): UploadItem {
  const { state } = item;
  switch (event.type) {
    case "started":
      return state.tag === "queued" ? { ...item, state: { tag: "sending", stored: state.stored, sent: state.stored } } : item;
    case "sent":
      if (state.tag === "sending") return { ...item, state: { ...state, sent: Math.max(event.bytes, state.stored) } };
      if (state.tag === "reconnecting") return { ...item, state: { tag: "sending", stored: state.stored, sent: Math.max(event.bytes, state.stored) } };
      return item;
    case "stored":
      if (state.tag === "sending") return { ...item, state: { ...state, stored: event.bytes, sent: Math.max(state.sent, event.bytes) } };
      if (state.tag === "reconnecting") return { ...item, state: { tag: "sending", stored: event.bytes, sent: event.bytes } };
      return item;
    case "connectionLost":
      return state.tag === "sending" ? { ...item, state: { tag: "reconnecting", stored: state.stored } } : item;
    case "pauseRequested":
      return state.tag === "sending" || state.tag === "reconnecting" || state.tag === "queued"
        ? { ...item, state: { tag: "paused", stored: state.stored } }
        : item;
    case "resumeRequested":
      return state.tag === "paused" || state.tag === "failed" ? { ...item, state: { tag: "queued", stored: state.stored } } : item;
    case "filePicked":
      if (state.tag !== "needs-file") return item;
      if (event.same) return { ...item, state: { tag: "queued", stored: state.stored } };
      return {
        ...item,
        name: event.name,
        size: event.size,
        lastModified: event.lastModified,
        path: `${item.path.slice(0, item.path.length - item.name.length)}${event.name}`,
        replaced: true,
        state: { tag: "queued", stored: 0 },
      };
    case "offsetKnown":
      return state.tag === "needs-file" || state.tag === "failed"
        ? { ...item, state: { tag: "needs-file", stored: event.stored } }
        : item;
    case "finished":
      return state.tag === "done" ? item : { ...item, state: { tag: "done", storedPath: event.storedPath } };
    case "failed":
      return state.tag === "done" ? item : { ...item, state: { tag: "failed", stored: storedOf(state), reason: event.reason } };
    default:
      return item;
  }
}

export function uploadsReducer(items: readonly UploadItem[], event: UploadEvent): UploadItem[] {
  switch (event.type) {
    case "added":
      return [
        ...items,
        ...event.uploads.map((u): UploadItem => ({ ...u, replaced: false, state: { tag: "queued", stored: 0 } })),
      ];
    case "restored":
      return [...items, ...event.items.filter((r) => !items.some((i) => i.id === r.id))];
    case "removed":
      return items.filter((i) => i.id !== event.id);
    case "finishedCleared":
      return items.filter((i) => i.state.tag !== "done");
    default:
      return items.map((i) => (i.id === event.id ? advance(i, event) : i));
  }
}

export function restorable(items: readonly UploadItem[]): UploadItem[] {
  return items.flatMap((item) =>
    item.state.tag === "done" ? [] : [{ ...item, state: { tag: "needs-file" as const, stored: storedOf(item.state) } }],
  );
}

export function nextToStart(items: readonly UploadItem[], slots: number): string[] {
  const busy = items.filter((i) => i.state.tag === "sending" || i.state.tag === "reconnecting").length;
  const free = Math.max(slots - busy, 0);
  return items
    .filter((i) => i.state.tag === "queued")
    .slice(0, free)
    .map((i) => i.id);
}

export interface TraySummary {
  finished: number;
  total: number;
  percent: number;
  settled: boolean;
}

export function bytesDone(item: UploadItem): number {
  return item.state.tag === "done" ? item.size : storedOf(item.state);
}

export function summarize(items: readonly UploadItem[]): TraySummary {
  const size = items.reduce((sum, i) => sum + i.size, 0);
  const done = items.reduce((sum, i) => sum + bytesDone(i), 0);
  const finished = items.filter((i) => i.state.tag === "done").length;
  const percent = size === 0 ? (items.length > 0 && finished === items.length ? 100 : 0) : Math.floor((done / size) * 100);
  return { finished, total: items.length, percent, settled: items.every((i) => i.state.tag === "done") };
}
