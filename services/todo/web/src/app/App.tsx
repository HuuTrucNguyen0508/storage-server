// The signed-in app: shared top bar, sidebar, the list, the detail panel,
// dialogs, keyboard shortcuts, drag and drop, live updates and reminders.

import {
  closestCenter, type CollisionDetection, DndContext, type DragEndEvent, DragOverlay, type DragStartEvent, KeyboardSensor,
  PointerSensor, pointerWithin, TouchSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, patch } from "../api/client";
import type { Label, Me, Project, Task } from "../api/types";
import { DetailPanel } from "../components/DetailPanel";
import { LabelDialog, MembersDialog, MoveDialog, ProjectDialog, ShortcutsDialog } from "../components/Dialogs";
import { type ListRoute, ListView } from "../components/ListView";
import { QuickAdd, type QuickAddHandle } from "../components/QuickAdd";
import { Settings } from "../components/Settings";
import { Sidebar, type SidebarHandle } from "../components/Sidebar";
import { A, anchorBelow, applyTheme, Avatar, Dialog, getTheme, Icon, Menu, type MenuAnchor, navigate, type Theme, typing, useLocation, useToast, withQuery } from "../components/ui";
import { useLive } from "../data/live";
import { getCaches, keys, useAccess, useAllSections, useLabels, useMe, useOpenTasks, useProjects, canWrite } from "../data/queries";
import { reorder, sortProjects } from "../data/model";
import { TaskWriter } from "../data/writer";
import { browserTimezone, dayKey } from "../lib/dates";
import { AppContext, type AppCtx, type ListModel } from "./context";

export function App() {
  const me = useMe();
  const projects = useProjects();
  const labels = useLabels();
  if (me.isPending || projects.isPending || labels.isPending) return <Boot />;
  if (me.isError || projects.isError || labels.isError)
    return (
      <div className="empty boot-error">
        <p className="empty__title">Todo isn't answering</p>
        <p className="empty__text">Check your connection, then reload the page.</p>
        <div className="empty__actions">
          <button className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  return <Shell me={me.data} projects={projects.data} labels={labels.data} />;
}

function Boot() {
  return (
    <div className="app" aria-busy="true">
      <header className="topbar">
        <span className="topbar__app">Todo</span>
      </header>
      <div className="boot" />
    </div>
  );
}

function useToday(tz: string): string {
  const [today, setToday] = useState(() => dayKey(new Date(), tz));
  useEffect(() => {
    setToday(dayKey(new Date(), tz));
    const t = setInterval(() => setToday(dayKey(new Date(), tz)), 30_000);
    return () => clearInterval(t);
  }, [tz]);
  return today;
}

function routeOf(path: string, query: URLSearchParams): ListRoute | "settings" | "notfound" {
  const views = ["inbox", "today", "upcoming", "overdue", "completed", "all"] as const;
  const v = views.find((x) => path === `/${x}`);
  if (v) return { kind: "view", view: v };
  let m = path.match(/^\/p\/([0-9a-f-]{36})$/);
  if (m) return { kind: "project", projectId: m[1]! };
  m = path.match(/^\/l\/([0-9a-f-]{36})$/);
  if (m) return { kind: "label", labelId: m[1]! };
  if (path === "/search") return { kind: "search", q: query.get("q") ?? "" };
  if (path === "/settings") return "settings";
  return "notfound";
}

function Shell({ me, projects: rawProjects, labels }: { me: Me; projects: Project[]; labels: Label[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { path, query } = useLocation();
  const tz = me.timezone || "UTC";
  const today = useToday(tz);
  const projects = useMemo(() => sortProjects(rawProjects), [rawProjects]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const inbox = useMemo(() => projects.find((p) => p.inbox && p.owner === me.username) ?? null, [projects, me.username]);
  const access = useAccess(projects, me.username);
  const sections = useAllSections(projects);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const writer = useMemo(() => new TaskWriter(qc, toast), [qc, toast]);
  const listModel = useRef<ListModel | null>(null);
  const quickAdd = useRef<QuickAddHandle>(null);
  const sidebar = useRef<SidebarHandle>(null);
  useOpenTasks();

  const [dialog, setDialog] = useState<
    | { kind: "members"; projectId: string }
    | { kind: "project"; project: Project | null }
    | { kind: "label"; label: Label | null }
    | { kind: "move"; task: Task }
    | { kind: "shortcuts" }
    | { kind: "quickadd" }
    | null
  >(null);
  const [drawer, setDrawer] = useState(false);
  const [panelFocus, setPanelFocus] = useState<"title" | undefined>(undefined);

  const route = routeOf(path, query);
  const taskId = query.get("task");

  const openTask = useCallback((id: string | null, focus?: "title") => {
    setPanelFocus(focus);
    navigate(withQuery({ task: id }), { replace: !!new URL(location.href).searchParams.get("task") && !!id });
  }, []);

  const live = useLive({
    me: me.username,
    onReminder: ({ task, taskId: id }) => {
      const title = task?.data.title ?? "A task";
      toast({ text: `Reminder: “${title}”.`, tone: "warn", timeout: 15_000, action: { label: "Open", run: () => openTask(id) } });
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          const n = new Notification("Todo reminder", { body: title, tag: `todo-${id}` });
          n.onclick = () => {
            window.focus();
            openTask(id);
          };
        } catch {
          /* some browsers only allow notifications from a service worker */
        }
      }
    },
    onRemovedFrom: (projectId) => {
      const p = projectById.get(projectId);
      if (path === `/p/${projectId}`) navigate("/today");
      toast({ text: `You no longer have access to ${p?.data.name ?? "a project"}.`, tone: "warn" });
    },
  });

  // Adopt the browser's timezone once when the profile still has the API default.
  useEffect(() => {
    const flag = `todo.tzChecked.${me.username}`;
    let checked = false;
    try {
      checked = !!localStorage.getItem(flag);
      localStorage.setItem(flag, "1");
    } catch {
      checked = true;
    }
    const browser = browserTimezone();
    if (checked || me.timezone !== "UTC" || browser === "UTC") return;
    patch<Me>("/api/me", { timezone: browser })
      .then((m) => {
        qc.setQueryData<Me>(keys.me, (x) => (x ? { ...x, ...m } : x));
        void qc.invalidateQueries({ queryKey: ["tasks"] });
        toast({
          text: `Dates now follow your timezone, ${browser.replace(/_/g, " ")}.`,
          action: {
            label: "Keep UTC",
            run: () => void patch<Me>("/api/me", { timezone: "UTC" }).then((m2) => qc.setQueryData<Me>(keys.me, (x) => (x ? { ...x, ...m2 } : x))),
          },
        });
      })
      .catch(() => undefined);
  }, [me.username, me.timezone, qc, toast]);

  const ctx: AppCtx = useMemo(
    () => ({
      me,
      tz,
      today,
      projects,
      projectById,
      inbox,
      access,
      roleOf: (id) => access.get(id)?.role ?? null,
      canEdit: (id) => canWrite(access.get(id)?.role),
      labels,
      labelById,
      sections,
      writer,
      live,
      openTask,
      openQuickAdd: () => {
        if (quickAdd.current) quickAdd.current.focus();
        else setDialog({ kind: "quickadd" });
      },
      openMembers: (projectId) => setDialog({ kind: "members", projectId }),
      openProjectDialog: (project) => setDialog({ kind: "project", project }),
      openLabelDialog: (label) => setDialog({ kind: "label", label }),
      openMoveDialog: (task) => setDialog({ kind: "move", task }),
      listModel,
    }),
    [me, tz, today, projects, projectById, inbox, access, labels, labelById, sections, writer, live, openTask],
  );

  // ---- global shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".overlay")) {
        if (drawer) setDrawer(false);
        else if (new URL(location.href).searchParams.get("task") && !typing(e)) openTask(null);
        return;
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".overlay")) return;
      if (e.key === "q") {
        e.preventDefault();
        ctx.openQuickAdd();
      } else if (e.key === "/") {
        e.preventDefault();
        if (matchMedia("(max-width: 720px)").matches) setDrawer(true);
        requestAnimationFrame(() => sidebar.current?.focusSearch());
      } else if (e.key === "?") {
        e.preventDefault();
        setDialog({ kind: "shortcuts" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx, drawer, openTask]);

  // ---- drag and drop ----
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [dragging, setDragging] = useState<{ type: "task" | "project"; title: string } | null>(null);

  const collision: CollisionDetection = (args) => {
    const type = args.active.data.current?.type;
    const containers = args.droppableContainers.filter((c) => {
      const t = c.data.current?.type;
      return type === "project" ? t === "project" : t !== "project" || true;
    });
    const scoped = { ...args, droppableContainers: containers };
    const hits = pointerWithin(scoped);
    if (hits.length) {
      // Prefer a project in the sidebar over the list under it.
      const proj = hits.find((h) => String(h.id).startsWith("drop:") || String(h.id).startsWith("project:"));
      return proj && type === "task" ? [proj] : hits;
    }
    return closestCenter({ ...scoped, droppableContainers: containers.filter((c) => (type === "task" ? !String(c.id).startsWith("drop:") && !String(c.id).startsWith("project:") : true)) });
  };

  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current;
    if (d?.type === "task") setDragging({ type: "task", title: writer.task(String(e.active.id))?.data.title ?? "" });
    else if (d?.type === "project") setDragging({ type: "project", title: projectById.get(String(d.projectId))?.data.name ?? "" });
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const a = e.active.data.current;
    const over = e.over;
    if (!a || !over) return;
    const od = over.data.current;
    if (a.type === "project") {
      const list = projects.filter((p) => !p.inbox && !p.data.archived);
      const to = list.findIndex((p) => `project:${p.id}` === over.id);
      const id = String(a.projectId);
      if (to < 0 || `project:${id}` === over.id) return;
      const changes = reorder(list.map((p) => ({ id: p.id, order: p.data.order })), id, to);
      qc.setQueryData<Project[]>(keys.projects, (l) => l?.map((p) => {
        const c = changes.find((x) => x.id === p.id);
        return c ? { ...p, data: { ...p.data, order: c.order } } : p;
      }));
      try {
        await Promise.all(changes.map((c) => patch(`/api/projects/${c.id}`, { order: c.order })));
      } catch (err) {
        toast({ text: `Couldn't save the new order. ${errorText(err)}`, tone: "danger" });
        void qc.invalidateQueries({ queryKey: keys.projects });
      }
      return;
    }
    if (a.type !== "task") return;
    const id = String(e.active.id);
    const task = writer.task(id);
    if (!task) return;
    if (od?.type === "project-drop" || od?.type === "project") {
      const pid = String(od.projectId);
      if (pid === task.project_id) return;
      if (!canWrite(access.get(pid)?.role)) {
        toast({ text: "You can only view that project, so tasks can't move there.", tone: "warn" });
        return;
      }
      const from = { projectId: task.project_id, sectionId: task.data.sectionId };
      const end = (getCaches(qc).open ?? []).filter((t) => t.project_id === pid && !t.data.sectionId).reduce((m, t) => Math.max(m, t.data.order), 0) + 1024;
      const ok = await writer.moveToProject(id, pid, null, end);
      const p = projectById.get(pid);
      if (ok)
        toast({
          text: `Moved “${task.data.title}” to ${p?.inbox ? "Inbox" : p?.data.name}.`,
          tone: "ok",
          action: { label: "Undo", run: () => void writer.moveToProject(id, from.projectId, from.sectionId) },
        });
      return;
    }
    const model = listModel.current;
    if (!model?.canReorder) return;
    const targetId = od?.type === "task" ? String(od.group) : od?.type === "group" ? String(od.group) : null;
    const target = model.groups.find((g) => g.id === targetId);
    if (!target) return;
    const open = getCaches(qc).open ?? [];
    const list = target.taskIds.map((tid) => open.find((t) => t.id === tid)).filter((t): t is Task => !!t);
    const index = od?.type === "task" ? Math.max(0, target.taskIds.indexOf(String(over.id))) : list.length;
    const changes = reorder(list.map((t) => ({ id: t.id, order: t.data.order })), id, index);
    const sameGroup = target.taskIds.includes(id);
    const mine = changes.find((c) => c.id === id);
    for (const c of changes) if (c.id !== id) void writer.update(c.id, { order: c.order });
    if (sameGroup) {
      if (mine) void writer.update(id, { order: mine.order });
    } else if (target.projectId !== task.project_id) {
      await writer.moveToProject(id, target.projectId, target.sectionId, mine?.order);
    } else {
      void writer.update(id, { sectionId: target.sectionId, ...(mine ? { order: mine.order } : {}) });
    }
  };

  // ---- page ----
  let page: React.ReactNode;
  if (route === "settings") page = <Settings />;
  else if (route === "notfound")
    page = (
      <div className="empty list-empty">
        <p className="empty__title">Nothing here</p>
        <p className="empty__text">This address doesn't match a page.</p>
        <div className="empty__actions">
          <A className="btn" href="/today">
            Go to Today
          </A>
        </div>
      </div>
    );
  else page = <ListView key={route.kind === "project" ? route.projectId : route.kind} route={route} quickAddRef={quickAdd} />;

  const hasPanel = !!taskId;

  return (
    <AppContext.Provider value={ctx}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={(e) => void onDragEnd(e)}
        onDragCancel={() => setDragging(null)}
        accessibility={{
          screenReaderInstructions: {
            draggable: "To pick up a task, press Space. Use the arrow keys to move it, Space to drop it, or Escape to cancel. You can also use Move to… in the task's menu.",
          },
        }}
      >
        <div className={`app${hasPanel ? " has-task" : ""}`}>
          <a className="skip-link" href="#main">
            Skip to tasks
          </a>
          <TopBar me={me} onShortcuts={() => setDialog({ kind: "shortcuts" })} />
          <div className={`app__body app__body--panel${hasPanel ? " is-panel-open" : ""}`}>
            <Sidebar ref={sidebar} onAdd={() => ctx.openQuickAdd()} open={drawer} onClose={() => setDrawer(false)} />
            <main className="main todo-main" id="main" tabIndex={-1}>
              <LiveStatus state={live} />
              {page}
            </main>
            {hasPanel ? (
              <DetailPanel taskId={taskId!} focus={panelFocus} onClose={() => openTask(null)} />
            ) : (
              <aside className="panel panel--empty" aria-label="Task details">
                <div className="empty">
                  <div className="empty__icon">
                    <Icon name="i-check-circle" />
                  </div>
                  <div className="empty__title">Nothing selected</div>
                  <div className="empty__text">Pick a task to see its details, subtasks and comments.</div>
                </div>
              </aside>
            )}
            <div className="actionbar">
              <button className="btn btn--primary" onClick={() => ctx.openQuickAdd()}>
                <Icon name="i-plus" />
                Add task
              </button>
              <button className="btn btn--icon" aria-label="Lists" aria-expanded={drawer} aria-controls="sidebar" onClick={() => setDrawer(!drawer)}>
                <Icon name="i-list" />
              </button>
              <button
                className="btn btn--icon"
                aria-label="Search"
                onClick={() => {
                  setDrawer(true);
                  requestAnimationFrame(() => sidebar.current?.focusSearch());
                }}
              >
                <Icon name="i-search" />
              </button>
            </div>
          </div>
        </div>
        <DragOverlay dropAnimation={null}>{dragging ? <div className={`drag-ghost drag-ghost--${dragging.type}`}>{dragging.title}</div> : null}</DragOverlay>
      </DndContext>
      {dialog?.kind === "members" && <MembersDialog projectId={dialog.projectId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "project" && <ProjectDialog project={dialog.project} onClose={() => setDialog(null)} />}
      {dialog?.kind === "label" && <LabelDialog label={dialog.label} onClose={() => setDialog(null)} />}
      {dialog?.kind === "move" && <MoveDialog task={dialog.task} onClose={() => setDialog(null)} />}
      {dialog?.kind === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "quickadd" && (
        <Dialog title="Add a task" onClose={() => setDialog(null)}>
          <QuickAdd projectId={route !== "settings" && route !== "notfound" && route.kind === "project" ? route.projectId : null} onAdded={() => setDialog(null)} />
          <p className="text-2 muted">Lands in your Inbox unless you name a project with #.</p>
        </Dialog>
      )}
    </AppContext.Provider>
  );
}

function LiveStatus({ state }: { state: string }) {
  // Show "reconnecting" only after a short grace period, so a blip stays invisible.
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (state !== "reconnecting") {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <div className="live-status" role="status" aria-live="polite">
      {show && (
        <span className="live-status__text">
          <Icon name="i-signal" />
          Reconnecting. Changes from others will show up when the connection is back.
        </span>
      )}
    </div>
  );
}

function appLinks(me: Me) {
  const base = location.hostname.replace(/^todo\./, "");
  const https = (h: string) => `https://${h}.${base}/`;
  const local = !location.hostname.startsWith("todo.");
  const links = [
    { name: "Home", url: me.homeUrl || https("home") },
    { name: "Storage", url: local ? me.homeUrl.replace("home.", "storage.") : https("storage") },
    { name: "Todo", url: "/today" },
    { name: "PDF", url: local ? me.homeUrl.replace("home.", "pdf.") : https("pdf") },
  ];
  if (me.groups.includes("admins")) links.push({ name: "Grafana", url: local ? me.homeUrl.replace("home.", "grafana.") : https("grafana") });
  return links;
}

function TopBar({ me, onShortcuts }: { me: Me; onShortcuts: () => void }) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const name = me.name || me.username;
  const apps = appLinks(me);
  const logout = `${me.authPublicUrl}/logout?rd=${encodeURIComponent(me.homeUrl)}`;
  return (
    <header className="topbar">
      <A className="topbar__app" href="/today">
        Todo
      </A>
      <nav className="topbar__nav" aria-label="Apps">
        {apps.map((a) =>
          a.name === "Todo" ? (
            <A key={a.name} className="topbar__link" href={a.url} aria-current="page">
              {a.name}
            </A>
          ) : (
            <a key={a.name} className="topbar__link" href={a.url}>
              {a.name}
            </a>
          ),
        )}
      </nav>
      <details className="switcher">
        <summary>
          Apps <Icon name="i-chev-d" size="sm" />
        </summary>
        <ul className="menu" role="menu">
          {apps.map((a) => (
            <li key={a.name} role="none">
              <a className="menu__item" role="menuitem" href={a.url} aria-current={a.name === "Todo" ? "true" : undefined}>
                {a.name}
              </a>
            </li>
          ))}
        </ul>
      </details>
      <span className="topbar__spacer" />
      <button className="topbar__user" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(anchorBelow(e.currentTarget, true, 240))}>
        <Avatar name={name} size="sm" />
        <span className="hide-sm">{name}</span>
        <Icon name="i-chev-d" size="sm" className="hide-sm" />
      </button>
      {menu && (
        <Menu
          label="Account"
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            ...(["system", "light", "dark"] as Theme[]).map((t) => ({
              label: t === "system" ? "Match the system theme" : t === "light" ? "Light theme" : "Dark theme",
              checked: t === theme,
              onSelect: () => {
                applyTheme(t);
                setTheme(t);
              },
            })),
            { label: "Keyboard shortcuts", icon: "i-keyboard", kbd: "?", separatorBefore: true, onSelect: onShortcuts },
            { label: "Settings", icon: "i-settings", onSelect: () => navigate("/settings") },
            { label: `Sign out ${me.username}`, icon: "i-external", separatorBefore: true, onSelect: () => (window.location.href = logout) },
          ]}
        />
      )}
    </header>
  );
}
