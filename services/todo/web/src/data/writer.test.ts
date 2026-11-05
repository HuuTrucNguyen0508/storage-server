import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api/types";
import { keys } from "./queries";
import { type ToastInput, TaskWriter } from "./writer";

function task(over: Partial<Task["data"]> = {}, version = 1): Task {
  return {
    id: "t1",
    project_id: "p1",
    version,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    data: {
      title: "Pay rent",
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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const qc = new QueryClient();
  qc.setQueryData(keys.open, [task()]);
  qc.setQueryData(keys.completed, []);
  const toasts: ToastInput[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return fetchImpl(url, init);
  });
  const w = new TaskWriter(qc, (t) => toasts.push(t));
  const open = () => qc.getQueryData<Task[]>(keys.open)!;
  return { qc, w, toasts, calls, open };
}

afterEach(() => vi.unstubAllGlobals());

describe("optimistic writes", () => {
  it("shows the change at once and keeps the server's copy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async () => {
      await gate;
      return json(200, { task: task({ priority: 1 }, 2), next: null });
    });
    const p = s.w.update("t1", { priority: 1 });
    expect(s.open()[0]!.data.priority).toBe(1);
    expect(s.open()[0]!.version).toBe(1);
    release();
    await p;
    expect(s.open()[0]!.version).toBe(2);
    const sent = s.calls[0]!;
    expect(sent.init.method).toBe("PATCH");
    expect(new Headers(sent.init.headers).get("X-Requested-With")).toBe("fetch");
    expect(sent.init.redirect).toBe("manual");
    expect(JSON.parse(String(sent.init.body))).toEqual({ version: 1, priority: 1 });
  });

  it("rolls back and offers Retry when the server fails", async () => {
    let attempt = 0;
    const s = setup(async (_url, init) => {
      if (init.method === "GET") throw new TypeError("offline");
      attempt++;
      if (attempt === 1) return json(500, { error: "boom" });
      return json(200, { task: task({ title: "Pay the rent" }, 2), next: null });
    });
    const r = await s.w.update("t1", { title: "Pay the rent" });
    expect(r).toBeNull();
    expect(s.open()[0]!.data.title).toBe("Pay rent");
    expect(s.toasts[0]).toMatchObject({ tone: "danger" });
    expect(s.toasts[0]!.text).toContain("Couldn't save “Pay rent”");
    s.toasts[0]!.action!.run();
    await vi.waitFor(() => expect(s.open()[0]!.version).toBe(2));
    expect(s.open()[0]!.data.title).toBe("Pay the rent");
  });

  it("shows the stored value with a notice on a 409", async () => {
    const s = setup(async () => json(409, { error: "Stale task version", current: task({ title: "Bob's title" }, 5) }));
    await s.w.update("t1", { title: "Mine" });
    expect(s.open()[0]!.data.title).toBe("Bob's title");
    expect(s.open()[0]!.version).toBe(5);
    expect(s.w.conflicts.get("t1")).toMatch(/Someone else changed this task first/);
    expect(s.toasts[0]).toMatchObject({ tone: "warn" });
  });

  it("sends writes to one task in order, each with the latest version", async () => {
    let v = 1;
    const s = setup(async (_u, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.version).toBe(v);
      v++;
      return json(200, { task: task({ ...body, version: undefined }, v), next: null });
    });
    await Promise.all([s.w.update("t1", { priority: 2 }), s.w.update("t1", { priority: 3 })]);
    expect(s.open()[0]!.version).toBe(3);
    expect(s.open()[0]!.data.priority).toBe(3);
  });

  it("completes a repeating task, places the next one, and Undo removes it again", async () => {
    const s = setup(async (url) => {
      if (url.endsWith("/complete"))
        return json(200, { task: task({ completedAt: "2026-11-05T10:00:00Z", recurrence: { kind: "days", interval: 1, from: "due" } }, 2), next: { ...task({}, 1), id: "t2" } });
      if (url.endsWith("/t2/delete")) return json(200, { task: { ...task({ deletedAt: "2026-11-05T10:00:01Z" }, 2), id: "t2" }, next: null });
      if (url.endsWith("/uncomplete")) return json(200, { task: task({}, 3), next: null });
      throw new Error("unexpected " + url);
    });
    await s.w.complete("t1");
    expect(s.open().map((t) => t.id)).toEqual(["t2"]);
    expect(s.toasts[0]!.text).toContain("Next one is set");
    s.toasts[0]!.action!.run();
    await vi.waitFor(() => expect(s.open().map((t) => t.id)).toEqual(["t1"]));
  });

  it("removes an optimistic new task when creation fails", async () => {
    const s = setup(async () => json(400, { error: "Project not found" }));
    const r = await s.w.create("p1", { title: "New" });
    expect(r).toBeNull();
    expect(s.open().map((t) => t.id)).toEqual(["t1"]);
    expect(s.toasts[0]!.action).toBeUndefined();
  });
});
