import { describe, expect, it } from "vitest";
import { nextToStart, restorable, summarize, uploadsReducer, type NewUpload, type UploadEvent, type UploadItem } from "./machine";

const file: NewUpload = { id: "1", path: "photos/a.mov", name: "a.mov", size: 1000, lastModified: 5 };

function run(...events: UploadEvent[]): UploadItem[] {
  return events.reduce(uploadsReducer, uploadsReducer([], { type: "added", uploads: [file] }));
}

function state(...events: UploadEvent[]) {
  return run(...events)[0]?.state;
}

const id = "1";

describe("upload states", () => {
  it("a new file waits in the queue", () => {
    expect(state()).toEqual({ tag: "queued", stored: 0 });
  });

  it("sending tracks stored and in-flight bytes apart", () => {
    expect(state({ type: "started", id }, { type: "sent", id, bytes: 400 })).toEqual({ tag: "sending", stored: 0, sent: 400 });
    expect(state({ type: "started", id }, { type: "sent", id, bytes: 400 }, { type: "stored", id, bytes: 300 })).toEqual({
      tag: "sending",
      stored: 300,
      sent: 400,
    });
  });

  it("losing the connection keeps what the server stored and drops what was in flight", () => {
    expect(state({ type: "started", id }, { type: "sent", id, bytes: 400 }, { type: "stored", id, bytes: 300 }, { type: "connectionLost", id })).toEqual({
      tag: "reconnecting",
      stored: 300,
    });
  });

  it("a retry continues from the stored bytes, never from zero", () => {
    expect(
      state(
        { type: "started", id },
        { type: "stored", id, bytes: 300 },
        { type: "connectionLost", id },
        { type: "sent", id, bytes: 0 },
      ),
    ).toEqual({ tag: "sending", stored: 300, sent: 300 });
  });

  it("pause keeps the stored bytes, and resume queues from them", () => {
    const paused = [{ type: "started", id }, { type: "stored", id, bytes: 300 }, { type: "pauseRequested", id }] as const;
    expect(state(...paused)).toEqual({ tag: "paused", stored: 300 });
    expect(state(...paused, { type: "resumeRequested", id })).toEqual({ tag: "queued", stored: 300 });
  });

  it("a late progress event from an aborted request cannot unpause", () => {
    expect(state({ type: "started", id }, { type: "pauseRequested", id }, { type: "sent", id, bytes: 500 })).toEqual({ tag: "paused", stored: 0 });
  });

  it("finishing is final", () => {
    const done = [{ type: "finished", id, storedPath: "photos/a (1).mov" }] as const;
    expect(state(...done)).toEqual({ tag: "done", storedPath: "photos/a (1).mov" });
    expect(state(...done, { type: "failed", id, reason: "late" })).toEqual({ tag: "done", storedPath: "photos/a (1).mov" });
    expect(state(...done, { type: "connectionLost", id })).toEqual({ tag: "done", storedPath: "photos/a (1).mov" });
  });

  it("a failed upload keeps its bytes and can be retried", () => {
    const failed = [{ type: "started", id }, { type: "stored", id, bytes: 300 }, { type: "failed", id, reason: "disk full" }] as const;
    expect(state(...failed)).toEqual({ tag: "failed", stored: 300, reason: "disk full" });
    expect(state(...failed, { type: "resumeRequested", id })).toEqual({ tag: "queued", stored: 300 });
  });
});

describe("after a reload", () => {
  const before = run({ type: "started", id }, { type: "stored", id, bytes: 710 });

  it("an unfinished upload waits for its file, with its offset", () => {
    expect(restorable(before).map((i) => i.state)).toEqual([{ tag: "needs-file", stored: 710 }]);
  });

  it("a finished upload does not come back", () => {
    expect(restorable(run({ type: "finished", id, storedPath: null }))).toEqual([]);
  });

  it("the server's offset replaces the remembered one", () => {
    const items = uploadsReducer(restorable(before), { type: "offsetKnown", id, stored: 800 });
    expect(items[0]?.state).toEqual({ tag: "needs-file", stored: 800 });
  });

  it("a failed upload with no file asks for its file once the server reports a partial offset", () => {
    const failed = uploadsReducer(restorable(before), { type: "failed", id, reason: "The server refused this upload. Retry to publish it" });
    const items = uploadsReducer(failed, { type: "offsetKnown", id, stored: 800 });
    expect(items[0]?.state).toEqual({ tag: "needs-file", stored: 800 });
  });

  it("the same file continues from the offset", () => {
    const items = uploadsReducer(restorable(before), { type: "filePicked", id, same: true, name: "a.mov", size: 1000, lastModified: 5 });
    expect(items[0]?.state).toEqual({ tag: "queued", stored: 710 });
    expect(items[0]?.replaced).toBe(false);
  });

  it("a different file starts over and says so, in the same folder", () => {
    const items = uploadsReducer(restorable(before), { type: "filePicked", id, same: false, name: "b.mov", size: 2000, lastModified: 9 });
    expect(items[0]).toEqual({
      id,
      path: "photos/b.mov",
      name: "b.mov",
      size: 2000,
      lastModified: 9,
      replaced: true,
      state: { tag: "queued", stored: 0 },
    });
  });

  it("does not add an item twice when two tabs restore", () => {
    const items = restorable(before);
    expect(uploadsReducer(items, { type: "restored", items })).toHaveLength(1);
  });
});

describe("the queue", () => {
  const add = (n: number): UploadItem[] =>
    uploadsReducer([], {
      type: "added",
      uploads: Array.from({ length: n }, (_, i) => ({ ...file, id: String(i) })),
    });

  it("starts files in order up to the free slots", () => {
    expect(nextToStart(add(5), 3)).toEqual(["0", "1", "2"]);
  });

  it("counts a reconnecting upload as busy", () => {
    let items = add(5);
    items = uploadsReducer(items, { type: "started", id: "0" });
    items = uploadsReducer(items, { type: "connectionLost", id: "0" });
    items = uploadsReducer(items, { type: "started", id: "1" });
    expect(nextToStart(items, 3)).toEqual(["2"]);
  });

  it("does not count a paused upload", () => {
    const items = uploadsReducer(add(2), { type: "pauseRequested", id: "0" });
    expect(nextToStart(items, 1)).toEqual(["1"]);
  });
});

describe("the summary", () => {
  it("counts finished files and percent by bytes", () => {
    const items = uploadsReducer(
      uploadsReducer(
        uploadsReducer(
          [],
          {
            type: "added",
            uploads: [
              { ...file, id: "a", size: 100 },
              { ...file, id: "b", size: 300 },
            ],
          },
        ),
        { type: "finished", id: "a", storedPath: null },
      ),
      { type: "started", id: "b" },
    );
    const withBytes = uploadsReducer(items, { type: "stored", id: "b", bytes: 100 });
    expect(summarize(withBytes)).toEqual({ finished: 1, total: 2, percent: 50, settled: false });
  });

  it("a zero-byte file reads as complete", () => {
    const items = uploadsReducer(
      uploadsReducer([], { type: "added", uploads: [{ ...file, size: 0 }] }),
      { type: "finished", id, storedPath: null },
    );
    expect(summarize(items)).toEqual({ finished: 1, total: 1, percent: 100, settled: true });
  });
});
