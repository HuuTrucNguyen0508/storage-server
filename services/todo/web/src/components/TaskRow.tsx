// One task row: completion check, title, meta line, assignee and a menu.

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useState } from "react";
import type { Task } from "../api/types";
import { useApp } from "../app/context";
import { isTemp } from "../data/model";
import { cssColor } from "../lib/colors";
import { dueInfo } from "../lib/dates";
import { shortRecurrence } from "../lib/recurrence";
import { anchorBelow, Avatar, Icon, Menu, type MenuAnchor } from "./ui";

export interface RowProps {
  task: Task;
  depth: number;
  group: string;
  selected: boolean;
  done: boolean;
  draggable: boolean;
  showProject: boolean;
  compactToday: boolean;
  parentTitle?: string;
  subtasks?: { done: number; total: number };
  onSelect: (id: string) => void;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
}

export const TaskRow = memo(function TaskRow(p: RowProps) {
  const app = useApp();
  const { task } = p;
  const d = task.data;
  const editable = app.canEdit(task.project_id) && !isTemp(task.id);
  const sortable = useSortable({ id: task.id, data: { type: "task", group: p.group }, disabled: !p.draggable || !editable });
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const project = app.projectById.get(task.project_id);
  const due = d.due ? dueInfo(d.due, d.dateOnly, app.tz, app.today, p.compactToday) : null;
  const labels = d.labels.map((id) => app.labelById.get(id)).filter((l) => !!l);
  const checked = p.done || !!d.completedAt;
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
  };
  const cls = [
    "task",
    p.depth > 0 ? `task--depth${p.depth}` : "",
    p.selected ? "is-selected" : "",
    checked ? "is-done" : "",
    p.done ? "is-leaving" : "",
    sortable.isDragging ? "is-dragging" : "",
    sortable.isOver && !sortable.isDragging ? "is-drop-target" : "",
    isTemp(task.id) ? "is-pending" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li ref={sortable.setNodeRef} style={style} className={cls} data-task-id={task.id} aria-current={p.selected ? "true" : undefined}>
      {p.draggable && editable ? (
        <button
          className="task__grip"
          aria-label={`Reorder ${d.title}`}
          {...sortable.attributes}
          {...sortable.listeners}
          ref={sortable.setActivatorNodeRef}
        >
          <Icon name="i-grip" />
        </button>
      ) : (
        <span className="task__grip" aria-hidden="true" />
      )}
      <input
        className={`check check--round p${d.priority}`}
        type="checkbox"
        checked={checked}
        disabled={!editable}
        aria-label={`${checked ? "Reopen" : "Complete"} ${d.title}`}
        onChange={() => (checked ? p.onReopen(task.id) : p.onComplete(task.id))}
      />
      <div className="task__body">
        <button className="task__open" onClick={() => p.onSelect(task.id)} data-row-open>
          <span className="task__title">{d.title}</span>
        </button>
        <div className="task__meta">
          {due && (
            <span className={due.tone === "overdue" ? "task__due--overdue" : due.tone === "today" ? "task__due--today" : undefined}>
              <Icon name={due.timed ? "i-clock" : "i-calendar"} />
              {due.text}
            </span>
          )}
          {d.recurrence && (
            <span>
              <Icon name="i-repeat" />
              {shortRecurrence(d.recurrence)}
            </span>
          )}
          {(d.reminderAt || d.reminderOffsetMinutes !== null) && (
            <span>
              <Icon name="i-bell" label="Has a reminder" />
            </span>
          )}
          {p.showProject && project && (
            <span className="task__project" style={{ "--dot": cssColor(project.data.color, project.data.name) } as React.CSSProperties}>
              {project.inbox ? "Inbox" : `${project.data.emoji ? project.data.emoji + " " : ""}${project.data.name}`}
            </span>
          )}
          {p.parentTitle && (
            <span className="task__parent">
              <Icon name="i-subtask" />
              {p.parentTitle}
            </span>
          )}
          {labels.map((l) => (
            <span key={l.id} className="label" style={{ "--dot": cssColor(l.data.color, l.data.name) } as React.CSSProperties}>
              {l.data.name}
            </span>
          ))}
          {p.subtasks && p.subtasks.total > 0 && (
            <span>
              <Icon name="i-subtask" />
              {p.subtasks.done} of {p.subtasks.total}
            </span>
          )}
          {d.description.trim() && (
            <span className="task__has-notes">
              <Icon name="i-file" label="Has notes" />
            </span>
          )}
        </div>
      </div>
      <div className="task__end">
        {d.assignee && d.assignee !== app.me.username && <Avatar name={d.assignee} />}
        {d.assignee === app.me.username && project && !project.inbox && <span className="badge badge--accent task__mine">You</span>}
        {editable && (
          <button
            className="btn btn--sm btn--quiet btn--icon task__more"
            aria-label={`More for ${d.title}`}
            aria-haspopup="menu"
            onClick={(e) => setMenu(anchorBelow(e.currentTarget, true, 200))}
          >
            <Icon name="i-more" />
          </button>
        )}
      </div>
      {menu && (
        <Menu
          label={`Actions for ${d.title}`}
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: "Open details", icon: "i-pencil", kbd: "E", onSelect: () => app.openTask(task.id, "title") },
            { label: "Move to…", icon: "i-move", onSelect: () => app.openMoveDialog(task) },
            { label: "Duplicate", icon: "i-copy", onSelect: () => void app.writer.duplicate(task.id) },
            { label: "Delete", icon: "i-trash", danger: true, separatorBefore: true, onSelect: () => void app.writer.remove(task.id) },
          ]}
        />
      )}
    </li>
  );
});
