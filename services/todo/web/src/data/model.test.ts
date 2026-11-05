import { describe, expect, it } from "vitest";
import type { LiveEvent, Task } from "../api/types";
import { parseMessages, freshReminder } from "./live";
import { SseParser } from "../lib/sse";
import { type Caches, inView, orderBetween, placeTask, reduceEvents, reorder, treeRows } from "./model";

function task(id: string, over: Partial<Task["data"]> = {}, version = 1, project = "p1"): Task {
  return {
    id,
    project_id: project,
    version,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    data: {
      title: id,
      description: "",
      due: null,
      dateOnly: false,
      priority: 4,
      labels: [],
      sectionId: null,
      parentId: null,
      assignee: null,
      order: 0,
      recurrence: null,
      reminderAt: null,
      reminderOffsetMinutes: null,
      completedAt: null,
      deletedAt: null,
      ...over,
    },
  };
}

const ev = (kind: string, data: Record<string, unknown>, extra: Partial<LiveEvent> = {}): LiveEvent => ({
  kind,
  id: "1",
  projectId: "p1",
  actor: "bob",
  data,
  time: "2026-11-05T10:00:00.000Z",
  ...extra,
});

const ctx = { me: "alice", projectIds: new Set(["p1", "p2"]) };

describe("SSE parser", () => {
  it("parses events split across chunks, CRLF line ends, comments and multi-line data", () => {
    const p = new SseParser();
    const a = p.feed("event: resync\ndata: {}\n\n: heartbeat\n\nid: 7\r\nevent: upd");
    expect(a.messages).toEqual([{ id: null, event: "resync", data: "{}" }]);
    expect(a.comments).toBe(1);
    const b = p.feed('ated\r\ndata: {"a":\r\ndata: 1}\r\n\r');
    expect(b.messages).toEqual([]);
    const c = p.feed("\n");
    expect(c.messages).toEqual([{ id: "7", event: "updated", data: '{"a":\n1}' }]);
  });

  it("turns messages into typed events and skips malformed data", () => {
    const out = parseMessages([
      { id: "3", event: "created", data: JSON.stringify({ id: "3", projectId: "p1", actor: "bob", data: { task: { id: "t" } }, time: "x" }) },
      { id: "4", event: "updated", data: "not json" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "created", id: "3", projectId: "p1", actor: "bob" });
  });
});

describe("live event reducer", () => {
  it("adds, updates and completes tasks, and ignores replays of older versions", () => {
    let c: Caches = { open: [], completed: [] };
    c = reduceEvents(c, [ev("created", { task: task("a", {}, 1) })], ctx).caches;
    expect(c.open!.map((t) => t.id)).toEqual(["a"]);
    c = reduceEvents(c, [ev("updated", { task: task("a", { title: "new" }, 3) })], ctx).caches;
    c = reduceEvents(c, [ev("updated", { task: task("a", { title: "stale" }, 2) })], ctx).caches;
    expect(c.open![0]!.data.title).toBe("new");
    c = reduceEvents(c, [ev("completed", { task: task("a", { completedAt: "2026-11-05T10:00:00Z" }, 4) })], ctx).caches;
    expect(c.open).toEqual([]);
    expect(c.completed!.map((t) => t.id)).toEqual(["a"]);
    c = reduceEvents(c, [ev("updated", { task: task("a", { deletedAt: "2026-11-05T10:00:00Z" }, 5) })], ctx).caches;
    expect(c.completed).toEqual([]);
  });

  it("replaces the user's own optimistic row when its creation echoes back", () => {
    const temp = task("tmp-1", { title: "Buy milk" }, 0);
    const c = reduceEvents({ open: [temp], completed: [] }, [ev("created", { task: task("real", { title: "Buy milk" }) }, { actor: "alice" })], ctx).caches;
    expect(c.open!.map((t) => t.id)).toEqual(["real"]);
  });

  it("drops a task moved to a project the user can't see", () => {
    const c0: Caches = { open: [task("a")], completed: [] };
    expect(reduceEvents(c0, [ev("moved", { id: "a", projectId: "p2" })], ctx).caches.open).toHaveLength(1);
    expect(reduceEvents(c0, [ev("moved", { id: "a", projectId: "secret" })], ctx).caches.open).toHaveLength(0);
  });

  it("reports reminders, resyncs, membership and comment changes as effects", () => {
    const { effects } = reduceEvents(
      { open: [], completed: [] },
      [
        ev("reminder", { taskId: "a", reminderAt: "2026-11-05T09:00:00Z" }, { id: "9" }),
        ev("resync", {}),
        ev("member.removed", { username: "alice" }),
        ev("commented", { taskId: "a", comment: {} }),
      ],
      ctx,
    );
    expect(effects).toContainEqual({ type: "reminder", taskId: "a", reminderAt: "2026-11-05T09:00:00Z", eventId: "9", time: "2026-11-05T10:00:00.000Z" });
    expect(effects).toContainEqual({ type: "resync" });
    expect(effects).toContainEqual({ type: "removed-from", projectId: "p1" });
    expect(effects).toContainEqual({ type: "invalidate", key: ["comments", "a"] });
  });

  it("skips reminders that are replays or long past", () => {
    const now = Date.parse("2026-11-05T10:00:00Z");
    expect(freshReminder("1", "2026-11-05T09:58:00Z", new Set(), now)).toBe(true);
    expect(freshReminder("1", "2026-11-05T09:58:00Z", new Set(["1"]), now)).toBe(false);
    expect(freshReminder("2", "2026-11-04T09:58:00Z", new Set(), now)).toBe(false);
  });

  it("leaves lists that aren't loaded alone", () => {
    const c = reduceEvents({ open: undefined, completed: undefined }, [ev("created", { task: task("a") })], ctx).caches;
    expect(c).toEqual({ open: undefined, completed: undefined });
  });
});

describe("views and order", () => {
  const tz = "Europe/Paris";
  it("matches the API's view rules in the user's timezone", () => {
    // 23:30 UTC on the 4th is 00:30 on the 5th in Paris: due today there.
    const t = task("a", { due: "2026-11-04T23:30:00.000Z" });
    expect(inView(t, "today", tz, "2026-11-05", null)).toBe(true);
    expect(inView(t, "overdue", tz, "2026-11-05", null)).toBe(false);
    expect(inView(t, "overdue", tz, "2026-11-06", null)).toBe(true);
    expect(inView(t, "upcoming", tz, "2026-10-30", null)).toBe(true);
    expect(inView(t, "upcoming", tz, "2026-10-29", null)).toBe(false);
    expect(inView(task("b"), "inbox", tz, "2026-11-05", "p1")).toBe(true);
    expect(inView(task("c", { completedAt: "x" }), "today", tz, "2026-11-05", null)).toBe(false);
  });

  it("finds an order between neighbours and renumbers when there is no room", () => {
    expect(orderBetween(1024, 2048)).toBe(1536);
    expect(orderBetween(undefined, 1024)).toBe(0);
    expect(orderBetween(0, 0)).toBeNull();
    const list = [
      { id: "a", order: 0 },
      { id: "b", order: 0 },
      { id: "c", order: 0 },
    ];
    expect(reorder(list, "c", 0)).toEqual([{ id: "c", order: -1024 }]);
    expect(reorder(list, "c", 1)).toEqual([
      { id: "a", order: 1024 },
      { id: "c", order: 2048 },
      { id: "b", order: 3072 },
    ]);
    expect(reorder([{ id: "a", order: 1024 }, { id: "b", order: 2048 }, { id: "c", order: 3072 }], "a", 2)).toEqual([{ id: "a", order: 4096 }]);
  });

  it("nests subtasks under their parents, two levels deep at most", () => {
    const rows = treeRows([task("child", { parentId: "p", order: 1 }), task("p"), task("grand", { parentId: "child" }), task("deep", { parentId: "grand" })], "manual");
    expect(rows.map((r) => `${r.task.id}:${r.depth}`)).toEqual(["p:0", "child:1", "grand:2", "deep:2"]);
  });

  it("never lets an older copy replace a newer one unless forced", () => {
    const c: Caches = { open: [task("a", { title: "v3" }, 3)], completed: [] };
    expect(placeTask(c, task("a", { title: "v2" }, 2)).open![0]!.data.title).toBe("v3");
    expect(placeTask(c, task("a", { title: "v2" }, 2), true).open![0]!.data.title).toBe("v2");
  });
});
