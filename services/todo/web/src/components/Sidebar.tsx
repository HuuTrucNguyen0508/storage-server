// Sidebar: add, search, smart views with counts, projects (drag to reorder or
// drop a task on one to move it), labels, settings. A drawer on phones.

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Project } from "../api/types";
import { useApp } from "../app/context";
import { inView, type ViewName } from "../data/model";
import { useOpenTasks } from "../data/queries";
import { cssColor } from "../lib/colors";
import { A, Icon, navigate, useLocation } from "./ui";

export interface SidebarHandle {
  focusSearch: () => void;
}

export const Sidebar = forwardRef<SidebarHandle, { onAdd: () => void; open: boolean; onClose: () => void }>(function Sidebar({ onAdd, open, onClose }, ref) {
  const app = useApp();
  const { path, query } = useLocation();
  const tasks = useOpenTasks();
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState(path === "/search" ? (query.get("q") ?? "") : "");
  const search = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focusSearch: () => search.current?.focus() }), []);

  const counts = useMemo(() => {
    const list = (tasks.data ?? []).filter((t) => !app.projectById.get(t.project_id)?.data.archived);
    const c = (v: ViewName) => list.filter((t) => inView(t, v, app.tz, app.today, app.inbox?.id ?? null)).length;
    const perProject = new Map<string, number>();
    for (const t of list) perProject.set(t.project_id, (perProject.get(t.project_id) ?? 0) + 1);
    return { inbox: c("inbox"), today: c("today"), overdue: c("overdue"), upcoming: c("upcoming"), perProject };
  }, [tasks.data, app.tz, app.today, app.inbox, app.projectById]);

  const active = app.projects.filter((p) => !p.inbox && !p.data.archived);
  const archived = app.projects.filter((p) => !p.inbox && p.data.archived);

  const nav = (href: string, icon: string, label: string, count?: number, tone?: "danger") => (
    <A className="nav__item" href={href} aria-current={path === href ? "page" : undefined} onClick={onClose}>
      <Icon name={icon} />
      <span className="nav__label">{label}</span>
      {count ? <span className={`nav__count${tone ? " nav__count--danger" : ""}`}>{count}</span> : null}
    </A>
  );

  return (
    <>
      {open && <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />}
      <aside className={`sidebar${open ? " is-open" : ""}`} aria-label="Lists" id="sidebar">
        <button className="btn btn--primary sidebar__add" onClick={onAdd}>
          <Icon name="i-plus" />
          Add task
          <span className="kbd sidebar__kbd" aria-hidden="true">
            Q
          </span>
        </button>
        <form
          role="search"
          className="sidebar__search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/search?q=${encodeURIComponent(q.trim())}`);
            onClose();
          }}
        >
          <label className="input-wrap">
            <Icon name="i-search" />
            <input
              ref={search}
              className="input input--sm"
              type="search"
              placeholder="Search tasks"
              aria-label="Search tasks"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQ("");
                  search.current?.blur();
                }
              }}
            />
            <span className="kbd" aria-hidden="true">
              /
            </span>
          </label>
        </form>
        <nav className="sidebar__group" aria-label="Views">
          {nav("/inbox", "i-inbox", "Inbox", counts.inbox)}
          {nav("/today", "i-today", "Today", counts.today)}
          {nav("/upcoming", "i-calendar", "Upcoming", counts.upcoming)}
          {nav("/overdue", "i-alert", "Overdue", counts.overdue, "danger")}
          {nav("/completed", "i-check-circle", "Completed")}
          {nav("/all", "i-list", "All tasks")}
        </nav>
        <nav className="sidebar__group" aria-label="Projects">
          <div className="sidebar__heading">
            <span>Projects</span>
            <button className="btn btn--sm btn--quiet btn--icon" aria-label="New project" onClick={() => app.openProjectDialog(null)}>
              <Icon name="i-plus" />
            </button>
          </div>
          <SortableContext items={active.map((p) => `project:${p.id}`)} strategy={verticalListSortingStrategy}>
            {active.map((p) => (
              <ProjectItem key={p.id} project={p} current={path === `/p/${p.id}`} count={counts.perProject.get(p.id) ?? 0} onNavigate={onClose} />
            ))}
          </SortableContext>
          {active.length === 0 && (
            <button className="nav__item sidebar__hint" onClick={() => app.openProjectDialog(null)}>
              <Icon name="i-plus" />
              <span className="nav__label">Create your first project</span>
            </button>
          )}
          {archived.length > 0 && (
            <>
              <button className="nav__item sidebar__toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
                <Icon name={showArchived ? "i-chev-d" : "i-chev-r"} />
                <span className="nav__label">Archived</span>
                <span className="nav__count">{archived.length}</span>
              </button>
              {showArchived &&
                archived.map((p) => (
                  <A key={p.id} className="nav__item nav__item--archived" href={`/p/${p.id}`} aria-current={path === `/p/${p.id}` ? "page" : undefined} onClick={onClose}>
                    <span className="nav__dot" style={{ background: cssColor(p.data.color, p.data.name) }} />
                    <span className="nav__label">{p.data.name}</span>
                  </A>
                ))}
            </>
          )}
        </nav>
        <nav className="sidebar__group" aria-label="Labels">
          <div className="sidebar__heading">
            <span>Labels</span>
            <button className="btn btn--sm btn--quiet btn--icon" aria-label="New label" onClick={() => app.openLabelDialog(null)}>
              <Icon name="i-plus" />
            </button>
          </div>
          {[...app.labels]
            .sort((a, b) => a.data.name.localeCompare(b.data.name))
            .map((l) => (
              <A key={l.id} className="nav__item" href={`/l/${l.id}`} aria-current={path === `/l/${l.id}` ? "page" : undefined} onClick={onClose}>
                <span className="label" style={{ "--dot": cssColor(l.data.color, l.data.name) } as React.CSSProperties}>
                  {l.data.name}
                </span>
              </A>
            ))}
          {app.labels.length === 0 && <p className="sidebar__note">Type @name in quick add to make one.</p>}
        </nav>
        <nav className="sidebar__group sidebar__bottom" aria-label="More">
          {nav("/settings", "i-settings", "Settings")}
        </nav>
      </aside>
    </>
  );
});

function ProjectItem({ project: p, current, count, onNavigate }: { project: Project; current: boolean; count: number; onNavigate: () => void }) {
  const app = useApp();
  const s = useSortable({ id: `project:${p.id}`, data: { type: "project", projectId: p.id } });
  const drop = useDroppable({ id: `drop:${p.id}`, data: { type: "project-drop", projectId: p.id } });
  const access = app.access.get(p.id);
  const members = p.memberCount - 1;
  const role = access?.role;
  return (
    <div
      ref={(el) => {
        s.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      className={`nav__row${s.isDragging ? " is-dragging" : ""}${drop.isOver || (s.isOver && !s.isDragging) ? " is-drop-target" : ""}`}
      style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }}
    >
      <A className="nav__item" href={`/p/${p.id}`} aria-current={current ? "page" : undefined} onClick={onNavigate}>
        <span className="nav__dot" style={{ background: cssColor(p.data.color, p.data.name) }} />
        {p.data.emoji && (
          <span className="nav__emoji" aria-hidden="true">
            {p.data.emoji}
          </span>
        )}
        <span className="nav__label">{p.data.name}</span>
        {role === "viewer" && <Icon name="i-eye" size="sm" className="faint" label="View only" />}
        {(members > 0 || p.owner !== app.me.username) && <Icon name="i-users" size="sm" className="faint" label={`Shared with ${members + 1} people`} />}
        {count ? <span className="nav__count">{count}</span> : null}
      </A>
      <button className="nav__grip" aria-label={`Reorder ${p.data.name}`} ref={s.setActivatorNodeRef} {...s.attributes} {...s.listeners}>
        <Icon name="i-grip" size="sm" />
      </button>
    </div>
  );
}
