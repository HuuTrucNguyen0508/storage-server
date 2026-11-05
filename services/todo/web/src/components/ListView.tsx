// Every task list: smart views, a project, a label, search results. Rows are
// grouped (sections, days, projects); views come from the cached lists.

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { del, errorText, get, patch, post } from "../api/client";
import type { Project, Section, Task } from "../api/types";
import { useApp } from "../app/context";
import { compareTasks, type Filters, inView, matchesFilters, reorder, type Sort, treeRows, type ViewName } from "../data/model";
import { keys, useCompletedTasks, useOpenTasks } from "../data/queries";
import { cssColor } from "../lib/colors";
import { addDays, dayHeading, dayKey, dayWords, fromLocalInputs, longDate, toLocalInputs } from "../lib/dates";
import { ProjectHead } from "./ProjectHead";
import { QuickAdd, type QuickAddHandle } from "./QuickAdd";
import { TaskRow } from "./TaskRow";
import { anchorBelow, ConfirmDialog, Icon, Menu, type MenuAnchor, navigate, typing, useLocation, useToast, withQuery } from "./ui";

export type ListRoute =
  | { kind: "view"; view: ViewName }
  | { kind: "project"; projectId: string }
  | { kind: "label"; labelId: string }
  | { kind: "search"; q: string };

interface Group {
  id: string;
  title: string;
  sub?: string;
  tone?: "danger";
  projectId: string | null;
  sectionId: string | null;
  section?: Section;
  rows: { task: Task; depth: number }[];
  /** Day for the per-day quick add on Upcoming. */
  day?: string;
  action?: { label: string; run: () => void };
}

const SORTS: { value: Sort; label: string }[] = [
  { value: "manual", label: "Your order" },
  { value: "due", label: "By due date" },
  { value: "priority", label: "By priority" },
  { value: "created", label: "By date added" },
];

export function ListView({ route, quickAddRef }: { route: ListRoute; quickAddRef: React.RefObject<QuickAddHandle | null> }) {
  const app = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const { query } = useLocation();
  const open = useOpenTasks();
  const isCompletedView = route.kind === "view" && route.view === "completed";
  const completed = useCompletedTasks(true);
  const search = useQuery({
    queryKey: keys.search(route.kind === "search" ? route.q : ""),
    queryFn: () => get<{ tasks: Task[] }>(`/api/tasks?view=all&q=${encodeURIComponent(route.kind === "search" ? route.q : "")}`),
    enabled: route.kind === "search" && !!route.q.trim(),
  });

  const project = route.kind === "project" ? app.projectById.get(route.projectId) : route.kind === "view" && route.view === "inbox" ? app.inbox : null;
  const projectId = project?.id ?? null;
  const sections = useMemo(() => (projectId ? (app.sections.get(projectId) ?? []) : []), [app.sections, projectId]);

  const defaultSort: Sort = route.kind === "project" || (route.kind === "view" && route.view === "inbox") ? "manual" : route.kind === "view" && route.view === "today" ? "priority" : "due";
  const sort = (query.get("sort") as Sort | null) ?? defaultSort;
  const filters: Filters = {
    label: query.get("label") ?? undefined,
    priority: query.get("priority") ? Number(query.get("priority")) : undefined,
    assignee: query.get("assignee") ?? undefined,
    project: query.get("project") ?? undefined,
  };
  const filtered = !!(filters.label || filters.priority || filters.assignee || filters.project);

  // Completed rows linger briefly so the check is seen before the row leaves.
  const [leaving, setLeaving] = useState<Map<string, Task>>(new Map());
  const reduced = useRef(matchMedia("(prefers-reduced-motion: reduce)").matches);
  const complete = useCallback(
    (id: string) => {
      const t = app.writer.task(id);
      if (!t) return;
      setLeaving((m) => new Map(m).set(id, { ...t, data: { ...t.data, completedAt: new Date().toISOString() } }));
      setTimeout(() => setLeaving((m) => {
        const n = new Map(m);
        n.delete(id);
        return n;
      }), reduced.current ? 500 : 1100);
      void app.writer.complete(id);
    },
    [app.writer],
  );
  const reopen = useCallback((id: string) => void app.writer.uncomplete(id), [app.writer]);

  // ---- derive groups ----
  const groups: Group[] = useMemo(() => {
    const openList = open.data ?? [];
    const base: Task[] =
      route.kind === "search" ? (search.data?.tasks ?? []).filter((t) => !t.data.completedAt && !t.data.deletedAt) : isCompletedView ? (completed.data ?? []) : openList;
    const lingering = [...leaving.values()].filter((t) => !base.some((b) => b.id === t.id));
    const all = [...base, ...(isCompletedView ? [] : lingering)].filter((t) => matchesFilters(t, filters));
    const tz = app.tz;
    const today = app.today;
    const cmp = compareTasks(sort);
    const flatRows = (list: Task[]) => list.sort(cmp).map((task) => ({ task, depth: 0 }));
    const inboxId = app.inbox?.id ?? null;
    const visibleProject = (t: Task) => !app.projectById.get(t.project_id)?.data.archived;

    if (project) {
      const mine = all.filter((t) => t.project_id === project.id);
      const out: Group[] = [];
      const bySection = (sid: string | null) => treeRows(mine.filter((t) => (t.data.sectionId ?? null) === sid || (sid === null && !!t.data.sectionId && !sections.some((s) => s.id === t.data.sectionId))), sort);
      out.push({ id: `g:${project.id}:-`, title: "", projectId: project.id, sectionId: null, rows: bySection(null) });
      for (const s of sections) out.push({ id: `g:${project.id}:${s.id}`, title: s.data.name, projectId: project.id, sectionId: s.id, section: s, rows: bySection(s.id) });
      return out;
    }
    if (route.kind === "view" && route.view === "completed") {
      const byDay = new Map<string, Task[]>();
      for (const t of all) {
        const k = dayKey(new Date(t.data.completedAt!), tz);
        byDay.set(k, [...(byDay.get(k) ?? []), t]);
      }
      return [...byDay.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 60)
        .map(([k, list]) => ({
          id: `d:${k}`,
          title: dayWords(k, today),
          sub: k === today || k === addDays(today, -1) ? longDate(k) : undefined,
          projectId: null,
          sectionId: null,
          rows: list.sort((a, b) => b.data.completedAt!.localeCompare(a.data.completedAt!)).map((task) => ({ task, depth: 0 })),
        }));
    }
    if (route.kind === "view" && route.view === "today") {
      const overdue = all.filter((t) => inView(t, "overdue", tz, today, inboxId) && visibleProject(t));
      const todays = all.filter((t) => inView(t, "today", tz, today, inboxId) && !inView(t, "overdue", tz, today, inboxId) && visibleProject(t));
      const out: Group[] = [];
      if (overdue.length)
        out.push({
          id: "overdue",
          title: "Overdue",
          tone: "danger",
          projectId: null,
          sectionId: null,
          rows: flatRows(overdue),
          action: { label: "Move all to today", run: () => moveAllToToday(overdue) },
        });
      out.push({ id: "today", title: "Today", projectId: null, sectionId: null, rows: flatRows(todays) });
      return out;
    }
    if (route.kind === "view" && route.view === "upcoming") {
      const out: Group[] = [];
      for (let i = 0; i < 7; i++) {
        const k = addDays(today, i);
        const list = all.filter((t) => !t.data.completedAt && t.data.due && dayKey(new Date(t.data.due), tz) === k && visibleProject(t));
        const h = dayHeading(k, today);
        out.push({ id: `d:${k}`, title: h.title, sub: h.sub, projectId: null, sectionId: null, rows: flatRows(list), day: k });
      }
      return out;
    }
    if (route.kind === "view" && route.view === "overdue") {
      return [{ id: "overdue", title: "", projectId: null, sectionId: null, rows: flatRows(all.filter((t) => inView(t, "overdue", tz, today, inboxId) && visibleProject(t))) }];
    }
    // All, a label, search: grouped by project.
    const list = all.filter((t) => (route.kind === "label" ? t.data.labels.includes(route.labelId) : true) && visibleProject(t) && !t.data.completedAt);
    const out: Group[] = [];
    for (const p of app.projects) {
      const mine = list.filter((t) => t.project_id === p.id);
      if (!mine.length) continue;
      out.push({
        id: `p:${p.id}`,
        title: p.inbox ? "Inbox" : `${p.data.emoji ? p.data.emoji + " " : ""}${p.data.name}`,
        projectId: p.id,
        sectionId: null,
        rows: sort === "manual" ? treeRows(mine, sort) : flatRows(mine),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.data, completed.data, search.data, leaving, route, sort, query.toString(), app.tz, app.today, app.projects, project, sections, isCompletedView]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.task)), [groups]);
  const allKnown = useMemo(() => [...(open.data ?? []), ...(completed.data ?? [])], [open.data, completed.data]);
  const subCounts = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const t of allKnown) {
      if (!t.data.parentId || t.data.deletedAt) continue;
      const c = m.get(t.data.parentId) ?? { done: 0, total: 0 };
      c.total++;
      if (t.data.completedAt) c.done++;
      m.set(t.data.parentId, c);
    }
    return m;
  }, [allKnown]);
  const titleOf = useMemo(() => new Map(allKnown.map((t) => [t.id, t.data.title])), [allKnown]);

  // ---- drag model for the shell's DndContext ----
  const canReorder = !!project && sort === "manual" && !filtered && app.canEdit(project.id);
  useEffect(() => {
    app.listModel.current = {
      canReorder,
      groups: groups.map((g) => ({ id: g.id, projectId: g.projectId ?? "", sectionId: g.sectionId, taskIds: g.rows.filter((r) => r.depth === 0).map((r) => r.task.id) })),
    };
    return () => {
      app.listModel.current = null;
    };
  }, [groups, canReorder, app.listModel]);

  // ---- selection and keys ----
  const selectedFromUrl = query.get("task");
  const [selected, setSelected] = useState<string | null>(selectedFromUrl);
  useEffect(() => {
    if (selectedFromUrl) setSelected(selectedFromUrl);
  }, [selectedFromUrl]);

  const focusRow = (id: string) => {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-id="${id}"] [data-row-open]`)?.focus());
  };

  const moveWithin = useCallback(
    async (id: string, dir: -1 | 1) => {
      const g = groups.find((x) => x.rows.some((r) => r.task.id === id));
      if (!g || !canReorder) return;
      const t = g.rows.find((r) => r.task.id === id)!.task;
      const siblings = g.rows.filter((r) => (r.task.data.parentId ?? null) === (t.data.parentId ?? null)).map((r) => r.task);
      const i = siblings.findIndex((x) => x.id === id);
      const j = i + dir;
      if (j < 0 || j >= siblings.length) return;
      const changes = reorder(siblings.map((x) => ({ id: x.id, order: x.data.order })), id, j);
      await Promise.all(changes.map((c) => app.writer.update(c.id, { order: c.order })));
      focusRow(id);
    },
    [groups, canReorder, app.writer],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || document.querySelector(".overlay")) return;
      const ids = flat.map((t) => t.id);
      const cur = selected && ids.includes(selected) ? selected : null;
      const i = cur ? ids.indexOf(cur) : -1;
      const go = (n: number) => {
        const id = ids[Math.max(0, Math.min(ids.length - 1, n))];
        if (!id) return;
        setSelected(id);
        if (selectedFromUrl) app.openTask(id);
        focusRow(id);
      };
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && cur) {
        e.preventDefault();
        void moveWithin(cur, e.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (e.altKey) return;
      if (e.key === "j" || (e.key === "ArrowDown" && i >= 0)) {
        e.preventDefault();
        go(i + 1);
      } else if (e.key === "k" || (e.key === "ArrowUp" && i >= 0)) {
        e.preventDefault();
        go(i < 0 ? 0 : i - 1);
      } else if ((e.key === "x" || (e.key === " " && (e.target as HTMLElement).dataset.rowOpen !== undefined)) && cur) {
        e.preventDefault();
        const t = flat[i]!;
        if (!app.canEdit(t.project_id)) return;
        if (t.data.completedAt) reopen(cur);
        else complete(cur);
        go(i + 1 < ids.length ? i + 1 : i - 1);
      } else if ((e.key === "e" || e.key === "Enter") && cur && (e.key === "e" || (e.target as HTMLElement).dataset.rowOpen === undefined)) {
        e.preventDefault();
        app.openTask(cur, "title");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, selected, selectedFromUrl, app, complete, reopen, moveWithin]);

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      app.openTask(id);
    },
    [app],
  );

  async function moveAllToToday(list: Task[]) {
    const editable = list.filter((t) => app.canEdit(t.project_id));
    const prev = editable.map((t) => ({ id: t.id, due: t.data.due }));
    const results = await Promise.all(
      editable.map((t) => {
        const time = t.data.dateOnly ? null : toLocalInputs(t.data.due!, app.tz).time;
        return app.writer.update(t.id, { due: fromLocalInputs(app.today, time, app.tz) });
      }),
    );
    const n = results.filter(Boolean).length;
    if (n)
      toast({
        text: `Moved ${n} task${n === 1 ? "" : "s"} to today.`,
        tone: "ok",
        action: { label: "Undo", run: () => prev.forEach((p) => void app.writer.update(p.id, { due: p.due })) },
      });
  }

  // ---- head ----
  let title = "";
  let sub = "";
  if (route.kind === "view") {
    title = { inbox: "Inbox", today: "Today", upcoming: "Upcoming", overdue: "Overdue", completed: "Completed", all: "All tasks" }[route.view];
    if (route.view === "today") sub = longDate(app.today);
    if (route.view === "upcoming") sub = "Next 7 days";
  } else if (route.kind === "label") {
    const l = app.labelById.get(route.labelId);
    title = l ? l.data.name : "Label";
  } else if (route.kind === "search") {
    title = route.q ? `Results for “${route.q}”` : "Search";
  }

  const loading = open.isPending || (isCompletedView && completed.isPending) || (route.kind === "search" && search.isFetching && !search.data);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const qaProject = project ? project.id : route.kind === "label" ? null : null;
  const defaultDay = route.kind === "view" && route.view === "today" ? app.today : null;
  const showQuickAdd = !(route.kind === "view" && route.view === "completed") && route.kind !== "search" && !(project && !app.canEdit(project.id));
  const dndDisabled = !canReorder;

  if (route.kind === "project" && !project) {
    return (
      <div className="empty list-empty">
        <div className="empty__icon">
          <Icon name="i-lock" />
        </div>
        <p className="empty__title">This project isn't available</p>
        <p className="empty__text">It was deleted, or you're no longer a member. Ask the owner to share it again.</p>
        <div className="empty__actions">
          <button className="btn" onClick={() => navigate("/today")}>
            Go to Today
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="list">
      {project && !project.inbox ? (
        <ProjectHead project={project} sortControl={<SortFilter sort={sort} defaultSort={defaultSort} filters={filters} projectFixed />} />
      ) : (
        <div className="page-head list-head">
          <h1>
            {route.kind === "label" && app.labelById.get(route.labelId) && (
              <span className="nav__dot list-head__dot" style={{ background: cssColor(app.labelById.get(route.labelId)!.data.color, title) }} />
            )}
            {title} {sub && <span className="page-head__sub">{sub}</span>}
          </h1>
          <SortFilter sort={sort} defaultSort={defaultSort} filters={filters} projectFixed={!!project} hideSort={isCompletedView} />
        </div>
      )}
      {filtered && <ActiveFilters filters={filters} />}
      {showQuickAdd && (
        <QuickAdd
          ref={quickAddRef}
          projectId={qaProject}
          defaultDay={defaultDay}
          placeholder={project && !project.inbox ? `Add a task to ${project.data.name}. Try: Call the agent tomorrow 10am p2` : undefined}
        />
      )}
      {loading ? (
        <Skeleton />
      ) : total === 0 && !(project && sections.length) && !(route.kind === "view" && route.view === "upcoming") ? (
        <Empty route={route} filtered={filtered} project={project ?? null} onAdd={() => quickAddRef.current?.focus()} />
      ) : (
        groups.map((g) => (
          <GroupBlock
            key={g.id}
            group={g}
            canReorder={canReorder && !dndDisabled}
            selected={selected}
            leaving={leaving}
            showProject={!project}
            compactToday={route.kind === "view" && route.view === "today"}
            subCounts={subCounts}
            titleOf={titleOf}
            flatSubtasks={!project && sort !== "manual"}
            onSelect={select}
            onComplete={complete}
            onReopen={reopen}
            onSectionChanged={() => void qc.invalidateQueries({ queryKey: keys.sections(projectId ?? "") })}
          />
        ))
      )}
      {project && app.canEdit(project.id) && !loading && <AddSection projectId={project.id} sections={sections} />}
      <div className="list-foot" />
    </div>
  );
}

function GroupBlock(p: {
  group: Group;
  canReorder: boolean;
  selected: string | null;
  leaving: Map<string, Task>;
  showProject: boolean;
  compactToday: boolean;
  subCounts: Map<string, { done: number; total: number }>;
  titleOf: Map<string, string>;
  flatSubtasks: boolean;
  onSelect: (id: string) => void;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onSectionChanged: () => void;
}) {
  const app = useApp();
  const { group: g } = p;
  const drop = useDroppable({ id: g.id, data: { type: "group", group: g.id }, disabled: !p.canReorder });
  const [adding, setAdding] = useState(false);
  const addRef = useRef<QuickAddHandle>(null);
  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);
  const ids = g.rows.filter((r) => r.depth === 0).map((r) => r.task.id);
  const head = g.title ? (
    <div className={`section-head${g.tone === "danger" ? " section-head--danger" : ""}`}>
      <h2 className="section-head__title">
        {g.title}
        {g.sub && <span className="section-head__sub">{g.sub}</span>}
      </h2>
      <span className="nav__count">{g.rows.length || ""}</span>
      <span className="grow" />
      {g.action && g.rows.length > 0 && (
        <button className="btn btn--sm btn--quiet" onClick={g.action.run}>
          {g.action.label}
        </button>
      )}
      {g.section && app.canEdit(g.projectId!) && <SectionMenu section={g.section} onChanged={p.onSectionChanged} />}
    </div>
  ) : null;
  return (
    <section className={`group${drop.isOver ? " is-drop-target" : ""}`} aria-label={g.title || undefined}>
      {head}
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={!p.canReorder}>
        <ul className="tasks" ref={drop.setNodeRef}>
          {g.rows.map((r) => (
            <TaskRow
              key={r.task.id}
              task={r.task}
              depth={p.flatSubtasks ? 0 : r.depth}
              group={g.id}
              selected={p.selected === r.task.id}
              done={p.leaving.has(r.task.id)}
              draggable={p.canReorder && r.depth === 0}
              showProject={p.showProject}
              compactToday={p.compactToday}
              parentTitle={(p.flatSubtasks || r.depth === 0) && r.task.data.parentId ? p.titleOf.get(r.task.data.parentId) : undefined}
              subtasks={p.subCounts.get(r.task.id)}
              onSelect={p.onSelect}
              onComplete={p.onComplete}
              onReopen={p.onReopen}
            />
          ))}
          {g.rows.length === 0 && g.section && <li className="group__empty">Drop tasks here, or add one below.</li>}
          {g.rows.length === 0 && g.day && !adding && <li className="group__empty">Nothing planned.</li>}
        </ul>
      </SortableContext>
      {(g.section || g.day) &&
        (adding ? (
          <div className="group__add">
            <QuickAdd
              compact
              projectId={g.section ? g.projectId : null}
              sectionId={g.section?.id ?? null}
              defaultDay={g.day ?? null}
              placeholder={g.day ? `Add a task for ${g.title.toLowerCase().startsWith("to") ? g.title.toLowerCase() : g.title}` : `Add a task to ${g.title}`}
              ref={addRef}
            />
            <button className="btn btn--sm btn--quiet" onClick={() => setAdding(false)}>
              Done
            </button>
          </div>
        ) : (
          (!g.section || app.canEdit(g.projectId!)) && (
            <button className="btn btn--sm btn--quiet group__add-btn" onClick={() => setAdding(true)}>
              <Icon name="i-plus" />
              Add task
            </button>
          )
        ))}
    </section>
  );
}

function SectionMenu({ section, onChanged }: { section: Section; onChanged: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(section.data.name);
  const siblings = app.sections.get(section.project_id) ?? [];
  const idx = siblings.findIndex((s) => s.id === section.id);
  const swap = async (dir: -1 | 1) => {
    const other = siblings[idx + dir];
    if (!other) return;
    try {
      const a = section.data.order === other.data.order ? idx + dir : other.data.order;
      const b = section.data.order === other.data.order ? idx : section.data.order;
      await Promise.all([patch(`/api/sections/${section.id}`, { order: a }), patch(`/api/sections/${other.id}`, { order: b })]);
      onChanged();
    } catch (e) {
      toast({ text: `Couldn't move the section. ${errorText(e)}`, tone: "danger" });
    }
  };
  if (renaming)
    return (
      <form
        className="row section-rename"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          try {
            await patch(`/api/sections/${section.id}`, { name: name.trim() });
            onChanged();
            setRenaming(false);
          } catch (err) {
            toast({ text: `Couldn't rename the section. ${errorText(err)}`, tone: "danger" });
          }
        }}
      >
        <input className="input input--sm" value={name} onChange={(e) => setName(e.target.value)} aria-label="Section name" autoFocus maxLength={200} />
        <button className="btn btn--sm btn--primary">Save</button>
        <button className="btn btn--sm btn--quiet" type="button" onClick={() => setRenaming(false)}>
          Cancel
        </button>
      </form>
    );
  return (
    <>
      <button className="btn btn--sm btn--quiet btn--icon" aria-label={`Section ${section.data.name} options`} aria-haspopup="menu" onClick={(e) => setMenu(anchorBelow(e.currentTarget, true, 200))}>
        <Icon name="i-more" />
      </button>
      {menu && (
        <Menu
          label={`Section ${section.data.name}`}
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", icon: "i-pencil", onSelect: () => setRenaming(true) },
            { label: "Move up", icon: "i-chev-u", disabled: idx <= 0, onSelect: () => void swap(-1) },
            { label: "Move down", icon: "i-chev-d", disabled: idx >= siblings.length - 1, onSelect: () => void swap(1) },
            { label: "Delete section", icon: "i-trash", danger: true, separatorBefore: true, onSelect: () => setDeleting(true) },
          ]}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${section.data.name}?`}
          action="Delete section"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await del(`/api/sections/${section.id}`);
              onChanged();
              toast({ text: `Deleted section ${section.data.name}. Its tasks stay in the project.`, tone: "ok" });
            } catch (e) {
              toast({ text: `Couldn't delete the section. ${errorText(e)}`, tone: "danger" });
            }
          }}
        >
          <p>The tasks in it stay in the project, without a section.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function AddSection({ projectId, sections }: { projectId: string; sections: Section[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open)
    return (
      <button className="btn btn--sm btn--quiet add-section" onClick={() => setOpen(true)}>
        <Icon name="i-plus" />
        Add section
      </button>
    );
  return (
    <form
      className="row add-section"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        try {
          const order = sections.reduce((m, s) => Math.max(m, s.data.order), 0) + 1024;
          await post(`/api/projects/${projectId}/sections`, { name: name.trim(), order });
          await qc.invalidateQueries({ queryKey: keys.sections(projectId) });
          setName("");
          setOpen(false);
        } catch (err) {
          toast({ text: `Couldn't add the section. ${errorText(err)}`, tone: "danger" });
        }
      }}
    >
      <input className="input input--sm" placeholder="Section name, like Before the move" value={name} onChange={(e) => setName(e.target.value)} aria-label="Section name" autoFocus maxLength={200} />
      <button className="btn btn--sm btn--primary">Add section</button>
      <button className="btn btn--sm btn--quiet" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

export function SortFilter({ sort, defaultSort, filters, projectFixed, hideSort }: { sort: Sort; defaultSort: Sort; filters: Filters; projectFixed?: boolean; hideSort?: boolean }) {
  const app = useApp();
  const [menu, setMenu] = useState<{ at: MenuAnchor; kind: "filter" | "label" | "priority" | "assignee" | "project" | "sort" } | null>(null);
  const people = useMemo(() => {
    const s = new Set<string>([app.me.username]);
    for (const a of app.access.values()) a.people.forEach((p) => s.add(p));
    return [...s].sort();
  }, [app.access, app.me.username]);
  const set = (k: string, v: string | null) => navigate(withQuery({ [k]: v }), { replace: true });
  const items = () => {
    if (!menu) return [];
    switch (menu.kind) {
      case "filter":
        return [
          { label: "Label…", icon: "i-tag", onSelect: () => setMenu({ at: menu.at, kind: "label" }) },
          { label: "Priority…", icon: "i-flag", onSelect: () => setMenu({ at: menu.at, kind: "priority" }) },
          { label: "Assigned to…", icon: "i-user", onSelect: () => setMenu({ at: menu.at, kind: "assignee" }) },
          ...(projectFixed ? [] : [{ label: "Project…", icon: "i-list", onSelect: () => setMenu({ at: menu.at, kind: "project" }) }]),
          ...(hideSort ? [] : [{ label: "Sort…", icon: "i-sort", separatorBefore: true, onSelect: () => setMenu({ at: menu.at, kind: "sort" }) }]),
        ];
      case "sort":
        return SORTS.map((x) => ({ label: x.label, checked: sort === x.value, onSelect: () => set("sort", x.value === defaultSort ? null : x.value) }));
      case "label":
        return app.labels.map((l) => ({ label: l.data.name, dot: cssColor(l.data.color, l.data.name), checked: filters.label === l.id, onSelect: () => set("label", filters.label === l.id ? null : l.id) }));
      case "priority":
        return [1, 2, 3, 4].map((n) => ({ label: `Priority ${n}`, checked: filters.priority === n, onSelect: () => set("priority", filters.priority === n ? null : String(n)) }));
      case "assignee":
        return people.map((u) => ({ label: u === app.me.username ? `${u} (you)` : u, checked: filters.assignee === u, onSelect: () => set("assignee", filters.assignee === u ? null : u) }));
      case "project":
        return app.projects.map((p) => ({
          label: p.inbox ? "Inbox" : p.data.name,
          dot: cssColor(p.data.color, p.data.name),
          checked: filters.project === p.id,
          onSelect: () => set("project", filters.project === p.id ? null : p.id),
        }));
    }
  };
  return (
    <div className="row list-tools">
      <button className="btn btn--sm btn--quiet" aria-haspopup="menu" onClick={(e) => setMenu({ at: anchorBelow(e.currentTarget, true, 200), kind: "filter" })}>
        <Icon name="i-filter" />
        <span className="hide-sm">Filter</span>
      </button>
      {!hideSort && (
        <label className="select select--quiet select--sm hide-sm">
          <select aria-label="Sort" value={sort} onChange={(e) => set("sort", e.target.value === defaultSort ? null : e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {menu && <Menu label="Filter" at={menu.at} onClose={() => setMenu(null)} items={items()} />}
    </div>
  );
}

function ActiveFilters({ filters }: { filters: Filters }) {
  const app = useApp();
  const chips: { key: string; text: string }[] = [];
  if (filters.label) chips.push({ key: "label", text: `Label: ${app.labelById.get(filters.label)?.data.name ?? "unknown"}` });
  if (filters.priority) chips.push({ key: "priority", text: `Priority ${filters.priority}` });
  if (filters.assignee) chips.push({ key: "assignee", text: `Assigned to ${filters.assignee}` });
  if (filters.project) {
    const p: Project | undefined = app.projectById.get(filters.project);
    chips.push({ key: "project", text: `Project: ${p?.inbox ? "Inbox" : (p?.data.name ?? "unknown")}` });
  }
  return (
    <div className="row active-filters" role="group" aria-label="Active filters">
      {chips.map((c) => (
        <button key={c.key} className="chip" onClick={() => navigate(withQuery({ [c.key]: null }), { replace: true })} aria-label={`Remove filter ${c.text}`}>
          {c.text}
          <Icon name="i-x" />
        </button>
      ))}
      <button className="btn btn--sm btn--quiet" onClick={() => navigate(withQuery({ label: null, priority: null, assignee: null, project: null }), { replace: true })}>
        Clear filters
      </button>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="list-skeleton" aria-busy="true" aria-label="Loading tasks">
      {[72, 48, 64, 40, 56].map((w, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton skeleton--circle list-skeleton__check" />
          <span className="skeleton skeleton--text" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

function Empty({ route, filtered, project, onAdd }: { route: ListRoute; filtered: boolean; project: Project | null; onAdd: () => void }) {
  const app = useApp();
  let title = "Nothing here";
  let text = "";
  let icon = "i-check-circle";
  let add = true;
  if (filtered) {
    title = "No tasks match these filters";
    text = "Clear a filter to see more.";
    add = false;
  } else if (route.kind === "search") {
    title = route.q ? `No open tasks match “${route.q}”` : "Search your tasks";
    text = route.q ? "Search looks at titles and notes, whole words. Completed tasks aren't searched." : "Type in the search box and press Enter.";
    icon = "i-search";
    add = false;
  } else if (project) {
    if (project.inbox) {
      title = "Your inbox is empty";
      text = "Anything you add without a project lands here, ready to sort later.";
      icon = "i-inbox";
    } else {
      title = `No tasks in ${project.data.name} yet`;
      text = app.canEdit(project.id) ? "Add the first one above. Sections help split a project into stages." : "When someone adds a task, it shows here.";
      add = app.canEdit(project.id);
    }
  } else if (route.kind === "view") {
    const m: Record<ViewName, [string, string, string]> = {
      today: ["Nothing due today", "Enjoy the quiet, or plan ahead in Upcoming.", "i-today"],
      upcoming: ["Nothing in the next 7 days", "Give a task a date and it shows here.", "i-calendar"],
      overdue: ["Nothing overdue", "Everything with a date is on time.", "i-check-circle"],
      completed: ["Nothing completed yet", "Tasks you check off show here, newest first.", "i-check-circle"],
      all: ["No open tasks", "Add one above, or import a list in Settings.", "i-list"],
      inbox: ["Your inbox is empty", "Anything you add without a project lands here.", "i-inbox"],
    };
    [title, text, icon] = m[route.view];
    add = route.view !== "completed" && route.view !== "overdue";
  } else if (route.kind === "label") {
    title = "No open tasks with this label";
    text = "Type @ and the label's name in quick add to tag a task.";
    icon = "i-tag";
  }
  return (
    <div className="empty list-empty">
      <div className="empty__icon">
        <Icon name={icon} />
      </div>
      <p className="empty__title">{title}</p>
      <p className="empty__text">{text}</p>
      {add && (
        <div className="empty__actions">
          <button className="btn" onClick={onAdd}>
            <Icon name="i-plus" />
            Add a task
          </button>
        </div>
      )}
    </div>
  );
}
