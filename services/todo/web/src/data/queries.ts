// Server state. Tasks live in two cached lists (open and completed) that live
// events and optimistic writes update in place; every view is derived from them.

import { type QueryClient, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { get } from "../api/client";
import type { ActivityRow, Comment, Label, Me, Members, Project, Role, Section, Task } from "../api/types";
import { type Caches, placeTask } from "./model";

export const keys = {
  me: ["me"] as const,
  projects: ["projects"] as const,
  labels: ["labels"] as const,
  sections: (p: string) => ["sections", p] as const,
  allSections: ["sections"] as const,
  open: ["tasks", "open"] as const,
  completed: ["tasks", "completed"] as const,
  task: (id: string) => ["task", id] as const,
  comments: (id: string) => ["comments", id] as const,
  members: (p: string) => ["members", p] as const,
  activity: (p: string) => ["activity", p] as const,
  search: (q: string) => ["tasks", "search", q] as const,
};

export function getCaches(qc: QueryClient): Caches {
  return { open: qc.getQueryData<Task[]>(keys.open), completed: qc.getQueryData<Task[]>(keys.completed) };
}

export function setCaches(qc: QueryClient, next: Caches) {
  const now = getCaches(qc);
  if (next.open !== now.open && next.open) qc.setQueryData(keys.open, next.open);
  if (next.completed !== now.completed && next.completed) qc.setQueryData(keys.completed, next.completed);
}

export function updateCaches(qc: QueryClient, f: (c: Caches) => Caches) {
  setCaches(qc, f(getCaches(qc)));
}

// ---- overlay: changes that a refetch must not wipe out ----
//
// A list refetch returns the server's snapshot from when it started. Tasks that
// arrived over the live stream meanwhile, and optimistic edits still in flight,
// are laid back over the fresh list.

const recent = new Map<string, { task: Task; at: number }>();
const pending = new Map<string, (t: Task) => Task>();

export function rememberLive(t: Task) {
  recent.set(t.id, { task: t, at: Date.now() });
  if (recent.size > 500) {
    const cutoff = Date.now() - 60_000;
    for (const [k, v] of recent) if (v.at < cutoff) recent.delete(k);
  }
}

export function setPending(id: string, f: ((t: Task) => Task) | null) {
  if (f) pending.set(id, f);
  else pending.delete(id);
}

function overlay(list: Task[], which: "open" | "completed", started: number): Task[] {
  let c: Caches = which === "open" ? { open: list, completed: [] } : { open: [], completed: list };
  for (const { task, at } of recent.values()) if (at >= started - 2000) c = placeTask(c, task);
  for (const [id, f] of pending) {
    const t = c.open!.find((x) => x.id === id) ?? c.completed!.find((x) => x.id === id);
    if (t) c = placeTask(c, f(t), true);
  }
  return (which === "open" ? c.open : c.completed)!;
}

async function fetchTasks(view: "all" | "completed"): Promise<Task[]> {
  const started = Date.now();
  const r = await get<{ tasks: Task[] }>(`/api/tasks?view=${view}`);
  return overlay(r.tasks, view === "all" ? "open" : "completed", started);
}

// ---- hooks ----

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => get<Me>("/api/me"), staleTime: 5 * 60_000 });
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => get<Project[]>("/api/projects") });
export const useLabels = () => useQuery({ queryKey: keys.labels, queryFn: () => get<Label[]>("/api/labels") });
export const useOpenTasks = () => useQuery({ queryKey: keys.open, queryFn: () => fetchTasks("all") });
export const useCompletedTasks = (enabled = true) => useQuery({ queryKey: keys.completed, queryFn: () => fetchTasks("completed"), enabled });

export const useSections = (projectId: string | null) =>
  useQuery({ queryKey: keys.sections(projectId ?? ""), queryFn: () => get<Section[]>(`/api/projects/${projectId}/sections`), enabled: !!projectId });

export const useComments = (taskId: string, enabled = true) =>
  useQuery({ queryKey: keys.comments(taskId), queryFn: () => get<Comment[]>(`/api/tasks/${taskId}/comments`), enabled });

export const useMembers = (projectId: string | null) =>
  useQuery({ queryKey: keys.members(projectId ?? ""), queryFn: () => get<Members>(`/api/projects/${projectId}/members`), enabled: !!projectId });

export const useActivity = (projectId: string | null) =>
  useQuery({ queryKey: keys.activity(projectId ?? ""), queryFn: () => get<ActivityRow[]>(`/api/projects/${projectId}/activity`), enabled: !!projectId });

/** Sections of every project at once, for the move menus and drag targets. */
export function useAllSections(projects: Project[]): Map<string, Section[]> {
  const results = useQueries({
    queries: projects.map((p) => ({ queryKey: keys.sections(p.id), queryFn: () => get<Section[]>(`/api/projects/${p.id}/sections`), staleTime: 60_000 })),
  });
  return useMemo(() => {
    const m = new Map<string, Section[]>();
    projects.forEach((p, i) => m.set(p.id, [...(results[i]?.data ?? [])].sort((a, b) => a.data.order - b.data.order)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, ...results.map((r) => r.data)]);
}

export interface Access {
  role: Role | null;
  /** Project owners, available before member details are requested. */
  people: string[];
}

/** Access metadata arrives atomically with the project list. Member details load on demand. */
export function useAccess(projects: Project[]): Map<string, Access> {
  return useMemo(() => new Map(projects.map((p) => [p.id, {
    role: p.role,
    people: [p.owner],
  }])), [projects]);
}

export const canWrite = (role: Role | null | undefined) => role === "owner" || role === "editor";

export { useQueryClient };
