// Every task write goes through here: it shows the change at once, sends it
// with the version the server last gave, and then settles. A 409 shows the
// stored value with a notice; a failure rolls back and offers Retry.

import type { QueryClient } from "@tanstack/react-query";
import { ApiError, errorText, get, patch, post } from "../api/client";
import type { Task, TaskCreate, TaskData, TaskResult } from "../api/types";
import { dropTask, findTask, isTemp, placeTask } from "./model";
import { getCaches, keys, setPending, updateCaches } from "./queries";

export interface ToastInput {
  text: string;
  tone?: "ok" | "danger" | "warn";
  action?: { label: string; run: () => void };
  timeout?: number;
}

type Listener = () => void;

/** Tasks whose last write lost to someone else's change: the panel shows a notice. */
export class ConflictStore {
  private map = new Map<string, string>();
  private listeners = new Set<Listener>();
  subscribe = (f: Listener) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };
  get = (id: string) => this.map.get(id);
  set(id: string, msg: string | null) {
    if (msg) this.map.set(id, msg);
    else this.map.delete(id);
    this.listeners.forEach((f) => f());
  }
}

export class TaskWriter {
  private chains = new Map<string, Promise<unknown>>();
  readonly conflicts = new ConflictStore();

  constructor(
    private qc: QueryClient,
    private toast: (t: ToastInput) => void,
  ) {}

  task(id: string): Task | undefined {
    return findTask(getCaches(this.qc), id) ?? this.qc.getQueryData<Task>(keys.task(id));
  }

  private place(t: Task, force = false) {
    updateCaches(this.qc, (c) => placeTask(c, t, force));
    if (this.qc.getQueryData(keys.task(t.id))) this.qc.setQueryData(keys.task(t.id), t);
  }

  /** Runs writes to one task one after another, so each sends the latest version. */
  private serial<T>(id: string, f: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(f);
    this.chains.set(id, run);
    void run.finally(() => {
      if (this.chains.get(id) === run) this.chains.delete(id);
    }).catch(() => undefined);
    return run;
  }

  /**
   * Applies `change` to a task now and sends it. `send` receives the version
   * to send. Resolves with the server result, or null when it failed (already
   * reported to the user).
   */
  write(
    id: string,
    change: Partial<TaskData>,
    send: (version: number) => Promise<TaskResult>,
    opts: { failText?: string; quiet409?: boolean } = {},
  ): Promise<TaskResult | null> {
    const before = this.task(id);
    if (!before) return Promise.resolve(null);
    const apply = (t: Task): Task => ({ ...t, data: { ...t.data, ...change } });
    setPending(id, apply);
    this.place(apply(before), true);
    this.conflicts.set(id, null);
    return this.serial(id, async () => {
      const current = this.task(id);
      try {
        const r = await send(current?.version ?? before.version);
        setPending(id, null);
        this.place(r.task);
        if (r.next) this.place(r.next);
        return r;
      } catch (e) {
        setPending(id, null);
        if (e instanceof ApiError && e.status === 409) {
          const stored = (e.body as { current?: Task } | undefined)?.current;
          if (stored) this.place(stored, true);
          else await this.refresh(id, before);
          const msg = "Someone else changed this task first. You're looking at what they saved; make your change again if you still want it.";
          this.conflicts.set(id, msg);
          if (!opts.quiet409) this.toast({ text: `“${before.data.title}” changed while you were editing. Showing the saved version.`, tone: "warn" });
          return null;
        }
        await this.refresh(id, before);
        this.toast({
          text: `${opts.failText ?? `Couldn't save “${before.data.title}”.`} ${errorText(e)}`,
          tone: "danger",
          action:
            e instanceof ApiError && !e.retryable
              ? undefined
              : { label: "Retry", run: () => void this.write(id, change, send, opts) },
          timeout: 10_000,
        });
        return null;
      }
    });
  }

  /** Puts the server's copy back after a failed write (or the snapshot when offline). */
  private async refresh(id: string, fallback: Task) {
    try {
      this.place(await get<Task>(`/api/tasks/${id}`), true);
    } catch {
      this.place(fallback, true);
    }
  }

  update(id: string, change: Partial<TaskData>, opts?: { failText?: string }) {
    return this.write(id, change, (version) => patch<TaskResult>(`/api/tasks/${id}`, { version, ...change }), opts);
  }

  /** Completes a task; the toast offers Undo, which also removes a created next occurrence. */
  async complete(id: string, opts: { toast?: boolean } = {}) {
    const t = this.task(id);
    if (!t || isTemp(id)) return null;
    const r = await this.write(id, { completedAt: new Date().toISOString() }, (version) => post<TaskResult>(`/api/tasks/${id}/complete`, { version }));
    if (r && opts.toast !== false) {
      const next = r.next;
      this.toast({
        text: next ? `Completed “${t.data.title}”. Next one is set.` : `Completed “${t.data.title}”.`,
        tone: "ok",
        action: { label: "Undo", run: () => void this.undoComplete(id, next?.id ?? null) },
      });
    }
    return r;
  }

  async undoComplete(id: string, nextId: string | null) {
    if (nextId) await this.remove(nextId, { toast: false });
    return this.write(id, { completedAt: null }, (version) => post<TaskResult>(`/api/tasks/${id}/uncomplete`, { version }));
  }

  uncomplete(id: string) {
    return this.write(id, { completedAt: null }, (version) => post<TaskResult>(`/api/tasks/${id}/uncomplete`, { version }));
  }

  async remove(id: string, opts: { toast?: boolean } = {}) {
    const t = this.task(id);
    if (!t) return null;
    const r = await this.write(id, { deletedAt: new Date().toISOString() }, (version) => post<TaskResult>(`/api/tasks/${id}/delete`, { version }));
    if (r && opts.toast !== false)
      this.toast({ text: `Deleted “${t.data.title}”.`, action: { label: "Undo", run: () => void this.restore(id) } });
    return r;
  }

  async restore(id: string) {
    let t = this.task(id);
    if (!t) {
      try {
        t = await get<Task>(`/api/tasks/${id}`);
        this.qc.setQueryData(keys.task(id), t);
      } catch (e) {
        this.toast({ text: `Couldn't restore the task. ${errorText(e)}`, tone: "danger" });
        return null;
      }
    }
    const v = t.version;
    try {
      const r = await post<TaskResult>(`/api/tasks/${id}/restore`, { version: v });
      this.place(r.task, true);
      return r;
    } catch (e) {
      this.toast({ text: `Couldn't restore “${t.data.title}”. ${errorText(e)}`, tone: "danger", action: { label: "Retry", run: () => void this.restore(id) } });
      return null;
    }
  }

  async duplicate(id: string) {
    const t = this.task(id);
    if (!t) return null;
    try {
      const copy = await post<Task>(`/api/tasks/${id}/duplicate`, { version: t.version });
      this.place(copy);
      this.toast({ text: `Duplicated “${t.data.title}”.`, tone: "ok" });
      return copy;
    } catch (e) {
      this.toast({ text: `Couldn't duplicate “${t.data.title}”. ${errorText(e)}`, tone: "danger" });
      return null;
    }
  }

  /** Creates a task, showing it at once under a temporary ID. */
  async create(projectId: string, data: Partial<TaskCreate> & { title: string }, opts: { toast?: boolean } = {}): Promise<Task | null> {
    const tempId = `tmp-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const full: TaskCreate = {
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
      ...data,
    };
    const temp: Task = { id: tempId, project_id: projectId, version: 0, created_at: now, updated_at: now, data: { ...full, completedAt: null, deletedAt: null } };
    this.place(temp);
    try {
      const t = await post<Task>(`/api/projects/${projectId}/tasks`, full);
      updateCaches(this.qc, (c) => placeTask(dropTask(c, tempId), t));
      if (opts.toast) this.toast({ text: `Added “${t.data.title}”.`, tone: "ok" });
      return t;
    } catch (e) {
      updateCaches(this.qc, (c) => dropTask(c, tempId));
      this.toast({
        text: `Couldn't add “${data.title}”. ${errorText(e)}`,
        tone: "danger",
        action: e instanceof ApiError && !e.retryable ? undefined : { label: "Retry", run: () => void this.create(projectId, data, opts) },
        timeout: 10_000,
      });
      return null;
    }
  }

  /**
   * Moves a task, with its subtasks, to another project (and section). The API
   * wants children moved first and parents in the destination, so children are
   * detached, the parent moves, and they are attached again.
   */
  async moveToProject(id: string, projectId: string, sectionId: string | null, order?: number): Promise<boolean> {
    const root = this.task(id);
    if (!root) return false;
    if (root.project_id === projectId) {
      return !!(await this.update(id, { sectionId, ...(order !== undefined ? { order } : {}) }));
    }
    const open = getCaches(this.qc).open ?? [];
    const descendants: Task[] = [];
    const walk = (pid: string) => {
      for (const c of open.filter((t) => t.data.parentId === pid)) {
        walk(c.id);
        descendants.push(c);
      }
    };
    walk(id);
    const fail = (e: unknown) => {
      this.toast({ text: `Couldn't move “${root.data.title}”. ${errorText(e)}`, tone: "danger" });
      return false;
    };
    try {
      for (const c of descendants)
        await this.write(c.id, { parentId: null, sectionId: null }, (version) =>
          patch<TaskResult>(`/api/tasks/${c.id}`, { version, projectId, parentId: null, sectionId: null }),
        ).then((r) => {
          if (!r) throw new Error("a subtask didn't move");
        });
      const r = await this.write(
        id,
        { parentId: null, sectionId, ...(order !== undefined ? { order } : {}) },
        (version) => patch<TaskResult>(`/api/tasks/${id}`, { version, projectId, parentId: null, sectionId, ...(order !== undefined ? { order } : {}) }),
        { failText: `Couldn't move “${root.data.title}”.` },
      );
      if (!r) return false;
      for (const c of descendants.reverse()) {
        const parentId = c.data.parentId;
        if (parentId) await this.update(c.id, { parentId });
      }
      return true;
    } catch (e) {
      return fail(e);
    }
  }
}
