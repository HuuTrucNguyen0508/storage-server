// Pure task-cache logic: where a task belongs, how live events change the
// caches, how views are derived, and how manual order is ranked. No React here.

import type { LiveEvent, Project, Task } from "../api/types";
import { addDays, dayKey } from "../lib/dates";

/** Open tasks (view=all) and completed tasks (view=completed); undefined until loaded. */
export interface Caches {
  open: Task[] | undefined;
  completed: Task[] | undefined;
}

export const isTemp = (id: string) => id.startsWith("tmp-");

export function findTask(c: Caches, id: string): Task | undefined {
  return c.open?.find((t) => t.id === id) ?? c.completed?.find((t) => t.id === id);
}

function without(list: Task[] | undefined, id: string): Task[] | undefined {
  if (!list) return list;
  const i = list.findIndex((t) => t.id === id);
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
}

function upsert(list: Task[] | undefined, t: Task): Task[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === t.id);
  if (i < 0) return [...list, t];
  const next = list.slice();
  next[i] = t;
  return next;
}

/**
 * Puts a task where its state says it lives: open, completed, or nowhere
 * (deleted). An older version never replaces a newer one unless `force`
 * (optimistic edits and rollbacks keep the version they started from).
 */
export function placeTask(c: Caches, t: Task, force = false): Caches {
  const have = findTask(c, t.id);
  if (have && !force && have.version > t.version) return c;
  let open = without(c.open, t.id);
  let completed = without(c.completed, t.id);
  if (!t.data.deletedAt) {
    if (t.data.completedAt) completed = upsert(completed, t);
    else open = upsert(open, t);
  }
  return { open, completed };
}

export function dropTask(c: Caches, id: string): Caches {
  return { open: without(c.open, id), completed: without(c.completed, id) };
}

export type Effect =
  | { type: "invalidate"; key: readonly unknown[] }
  | { type: "resync" }
  | { type: "reminder"; taskId: string; reminderAt: string; eventId: string; time: string }
  | { type: "project"; project: Project }
  | { type: "removed-from"; projectId: string };

export interface ReduceContext {
  me: string;
  /** Projects the user can see right now; a task moved elsewhere leaves the caches. */
  projectIds: Set<string>;
}

function taskOf(e: LiveEvent): Task | null {
  const t = e.data.task as Task | undefined;
  return t && typeof t === "object" && typeof t.id === "string" && t.data ? t : null;
}

/**
 * Applies a batch of live events to the caches. Replayed and echoed events are
 * harmless: task placement is guarded by version, and a "created" echo of the
 * user's own optimistic insert replaces the temporary row instead of adding one.
 */
export function reduceEvents(c: Caches, events: LiveEvent[], ctx: ReduceContext): { caches: Caches; effects: Effect[] } {
  const effects: Effect[] = [];
  let caches = c;
  for (const e of events) {
    switch (e.kind) {
      case "created":
      case "updated":
      case "completed": {
        const t = taskOf(e);
        if (!t) {
          effects.push({ type: "invalidate", key: ["tasks"] });
          break;
        }
        if (e.kind === "created" && e.actor === ctx.me && caches.open) {
          const temp = caches.open.find((x) => isTemp(x.id) && x.project_id === t.project_id && x.data.title === t.data.title);
          if (temp) caches = dropTask(caches, temp.id);
        }
        caches = placeTask(caches, t);
        break;
      }
      case "moved": {
        const id = String(e.data.id ?? "");
        const to = String(e.data.projectId ?? "");
        if (id && !ctx.projectIds.has(to)) caches = dropTask(caches, id);
        break;
      }
      case "commented":
        effects.push({ type: "invalidate", key: ["comments", String(e.data.taskId ?? "")] });
        if (e.projectId) effects.push({ type: "invalidate", key: ["activity", e.projectId] });
        break;
      case "project.created":
      case "project.updated": {
        const p = e.data.project as Project | undefined;
        if (p && typeof p.id === "string") effects.push({ type: "project", project: p });
        else effects.push({ type: "invalidate", key: ["projects"] });
        break;
      }
      case "section.created":
        if (e.projectId) effects.push({ type: "invalidate", key: ["sections", e.projectId] });
        break;
      case "shared":
      case "member.left":
      case "ownership.transferred":
        effects.push({ type: "invalidate", key: ["projects"] });
        if (e.projectId) effects.push({ type: "invalidate", key: ["members", e.projectId] });
        break;
      case "member.removed":
        effects.push({ type: "invalidate", key: ["projects"] });
        if (e.projectId) effects.push({ type: "invalidate", key: ["members", e.projectId] });
        if (e.data.username === ctx.me && e.projectId) effects.push({ type: "removed-from", projectId: e.projectId });
        break;
      case "reminder":
        effects.push({
          type: "reminder",
          taskId: String(e.data.taskId ?? ""),
          reminderAt: String(e.data.reminderAt ?? ""),
          eventId: e.id,
          time: e.time,
        });
        break;
      case "resync":
      case "imported":
        effects.push({ type: "resync" });
        break;
      default:
        effects.push({ type: "invalidate", key: ["tasks"] });
    }
  }
  return { caches, effects };
}

// ---- views ----

export type ViewName = "inbox" | "today" | "upcoming" | "overdue" | "completed" | "all";

export interface Filters {
  label?: string;
  priority?: number;
  assignee?: string;
  project?: string;
}

export type Sort = "manual" | "due" | "priority" | "created";

export function matchesFilters(t: Task, f: Filters): boolean {
  if (f.label && !t.data.labels.includes(f.label)) return false;
  if (f.priority && t.data.priority !== f.priority) return false;
  if (f.assignee && t.data.assignee !== f.assignee) return false;
  if (f.project && t.project_id !== f.project) return false;
  return true;
}

/** Same rules as GET /api/tasks?view=…, evaluated on the cached lists. */
export function inView(t: Task, view: ViewName, tz: string, today: string, inboxId: string | null): boolean {
  if (view === "completed") return !!t.data.completedAt;
  if (t.data.completedAt || t.data.deletedAt) return false;
  if (view === "all") return true;
  if (view === "inbox") return t.project_id === inboxId;
  const day = t.data.due ? dayKey(new Date(t.data.due), tz) : null;
  if (!day) return false;
  if (view === "today") return day <= today;
  if (view === "overdue") return day < today;
  return day >= today && day < addDays(today, 7);
}

export function compareTasks(sort: Sort): (a: Task, b: Task) => number {
  const created = (a: Task, b: Task) => a.created_at.localeCompare(b.created_at);
  switch (sort) {
    case "priority":
      return (a, b) => a.data.priority - b.data.priority || (a.data.due ?? "9999").localeCompare(b.data.due ?? "9999") || a.data.order - b.data.order;
    case "due":
      return (a, b) => (a.data.due ?? "9999").localeCompare(b.data.due ?? "9999") || a.data.priority - b.data.priority;
    case "created":
      return (a, b) => created(a, b);
    case "manual":
      return (a, b) => a.data.order - b.data.order || created(a, b);
  }
}

/** Groups tasks into parent → children for nested rendering (depth-first, sorted). */
export interface TreeRow {
  task: Task;
  depth: number;
}

export function treeRows(tasks: Task[], sort: Sort, maxDepth = 2): TreeRow[] {
  const ids = new Set(tasks.map((t) => t.id));
  const byParent = new Map<string | null, Task[]>();
  for (const t of tasks) {
    const p = t.data.parentId && ids.has(t.data.parentId) ? t.data.parentId : null;
    const list = byParent.get(p) ?? [];
    list.push(t);
    byParent.set(p, list);
  }
  const cmp = compareTasks(sort);
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const t of (byParent.get(parent) ?? []).sort(cmp)) {
      out.push({ task: t, depth: Math.min(depth, maxDepth) });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function sortProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => Number(b.inbox) - Number(a.inbox) || a.data.order - b.data.order || a.data.name.localeCompare(b.data.name));
}

// ---- manual order ----

const STEP = 1024;

/**
 * The order value for an item dropped between `before` and `after` (either may
 * be missing). Returns null when there is no room, and the caller renumbers.
 */
export function orderBetween(before: number | undefined, after: number | undefined): number | null {
  if (before === undefined && after === undefined) return STEP;
  if (before === undefined) return after! - STEP;
  if (after === undefined) return before + STEP;
  const mid = (before + after) / 2;
  return mid > before && mid < after ? mid : null;
}

/** Renumbers a whole list in steps, returning only the items whose order changes. */
export function renumber<T extends { id: string; order: number }>(list: T[]): { id: string; order: number }[] {
  return list.map((x, i) => ({ id: x.id, order: (i + 1) * STEP })).filter((x, i) => x.order !== list[i]!.order);
}

/**
 * Moves `id` to `index` within `list` (already in display order) and returns
 * the order updates to send: one when there is room, a renumbering otherwise.
 */
export function reorder<T extends { id: string; order: number }>(list: T[], id: string, index: number): { id: string; order: number }[] {
  const from = list.findIndex((x) => x.id === id);
  const moving = from >= 0 ? list[from]! : { id, order: 0 };
  const rest = list.filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  const placed = [...rest.slice(0, at), moving, ...rest.slice(at)];
  const o = orderBetween(rest[at - 1]?.order, rest[at]?.order);
  if (o !== null) return from >= 0 && list[from]!.order === o && from === at ? [] : [{ id, order: o }];
  return renumber(placed as T[]);
}

/** Next order value at the end of a list. */
export function orderAtEnd(list: { order: number }[]): number {
  return list.reduce((m, x) => Math.max(m, x.order), 0) + STEP;
}
