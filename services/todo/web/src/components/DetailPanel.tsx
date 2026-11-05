// The task detail panel: every field of a task, its subtasks, comments and history.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { errorText, get, post } from "../api/client";
import type { ActivityRow, Comment, Priority, Task } from "../api/types";
import { useApp } from "../app/context";
import { isTemp } from "../data/model";
import { keys, useActivity, useComments, useCompletedTasks, useOpenTasks } from "../data/queries";
import { cssColor } from "../lib/colors";
import { addDays, ago, dueInfo, fromLocalInputs, shortDate, toLocalInputs } from "../lib/dates";
import { sanitizedHtml } from "../lib/markdown";
import { describeRecurrence } from "../lib/recurrence";
import { QuickAdd } from "./QuickAdd";
import { RecurrenceEditor } from "./RecurrenceEditor";
import { anchorBelow, Avatar, Icon, Menu, type MenuAnchor, useToast } from "./ui";

const REMINDERS: { value: string; label: string; minutes: number | null }[] = [
  { value: "none", label: "No reminder", minutes: null },
  { value: "0", label: "At the due time", minutes: 0 },
  { value: "10", label: "10 minutes before", minutes: 10 },
  { value: "30", label: "30 minutes before", minutes: 30 },
  { value: "60", label: "1 hour before", minutes: 60 },
  { value: "1440", label: "1 day before", minutes: 1440 },
  { value: "custom", label: "At a set time…", minutes: null },
];

export function DetailPanel({ taskId, focus, onClose }: { taskId: string; focus: "title" | undefined; onClose: () => void }) {
  const open = useOpenTasks();
  const completed = useCompletedTasks();
  const cached = useMemo(
    () => open.data?.find((t) => t.id === taskId) ?? completed.data?.find((t) => t.id === taskId),
    [open.data, completed.data, taskId],
  );
  const fetched = useQuery({
    queryKey: keys.task(taskId),
    queryFn: () => get<Task>(`/api/tasks/${taskId}`),
    enabled: !cached && !isTemp(taskId) && !open.isPending,
    retry: false,
  });
  const task = cached ?? fetched.data;
  const ref = useRef<HTMLElement>(null);

  return (
    <aside
      className="panel detail"
      aria-label="Task details"
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !(e.target as HTMLElement).closest("form.recur, .detail__notes-edit")) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {!task ? (
        fetched.isError ? (
          <div className="empty detail__missing">
            <p className="empty__title">This task isn't available</p>
            <p className="empty__text">It was deleted, or its project isn't shared with you any more.</p>
            <div className="empty__actions">
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="panel__body" aria-busy="true">
            <span className="skeleton skeleton--text" />
            <span className="skeleton skeleton--text is-short" />
          </div>
        )
      ) : (
        <Detail key={task.id} task={task} focus={focus} onClose={onClose} />
      )}
    </aside>
  );
}

function Detail({ task, focus, onClose }: { task: Task; focus: "title" | undefined; onClose: () => void }) {
  const app = useApp();
  const d = task.data;
  const project = app.projectById.get(task.project_id);
  const section = d.sectionId ? app.sections.get(task.project_id)?.find((s) => s.id === d.sectionId) : undefined;
  const editable = app.canEdit(task.project_id) && !isTemp(task.id) && !d.deletedAt;
  const conflict = useSyncExternalStore(app.writer.conflicts.subscribe, () => app.writer.conflicts.get(task.id));
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState(d.title);
  useEffect(() => setTitle(d.title), [d.title]);
  useEffect(() => {
    if (focus === "title") titleRef.current?.focus();
  }, [focus, task.id]);

  const saveTitle = () => {
    const v = title.replace(/\s+/g, " ").trim();
    if (!v) return setTitle(d.title);
    if (v !== d.title) void app.writer.update(task.id, { title: v });
  };

  const people = app.access.get(task.project_id)?.people ?? [];
  const parent = d.parentId ? app.writer.task(d.parentId) : undefined;
  const depth = parent ? (parent.data.parentId ? 2 : 1) : 0;

  return (
    <>
      <div className="panel__head">
        <input
          className={`check check--round p${d.priority}`}
          type="checkbox"
          checked={!!d.completedAt}
          disabled={!editable}
          aria-label={`${d.completedAt ? "Reopen" : "Complete"} ${d.title}`}
          onChange={() => void (d.completedAt ? app.writer.uncomplete(task.id) : app.writer.complete(task.id))}
        />
        <span className="grow text-2 muted truncate">
          in{" "}
          {project && (
            <span className="task__project" style={{ "--dot": cssColor(project.data.color, project.data.name) } as React.CSSProperties}>
              {project.inbox ? "Inbox" : project.data.name}
            </span>
          )}
          {section && <span> / {section.data.name}</span>}
        </span>
        {editable && (
          <button className="btn btn--sm btn--quiet btn--icon" aria-label="Task options" aria-haspopup="menu" onClick={(e) => setMenu(anchorBelow(e.currentTarget, true, 200))}>
            <Icon name="i-more" />
          </button>
        )}
        <button className="btn btn--sm btn--quiet btn--icon" aria-label="Close details" onClick={onClose}>
          <Icon name="i-x" />
        </button>
        {menu && (
          <Menu
            label="Task options"
            at={menu}
            onClose={() => setMenu(null)}
            items={[
              { label: "Move to…", icon: "i-move", onSelect: () => app.openMoveDialog(task) },
              { label: "Duplicate", icon: "i-copy", onSelect: () => void app.writer.duplicate(task.id) },
              {
                label: "Delete",
                icon: "i-trash",
                danger: true,
                separatorBefore: true,
                onSelect: () => {
                  onClose();
                  void app.writer.remove(task.id);
                },
              },
            ]}
          />
        )}
      </div>
      <div className="panel__body">
        {conflict && (
          <div className="notice notice--warn" role="status">
            <Icon name="i-info" />
            <div className="grow">{conflict}</div>
            <button className="btn btn--sm btn--quiet btn--icon" aria-label="Dismiss" onClick={() => app.writer.conflicts.set(task.id, null)}>
              <Icon name="i-x" />
            </button>
          </div>
        )}
        {d.deletedAt && (
          <div className="notice notice--danger" role="status">
            <div className="grow">This task was deleted.</div>
            {app.canEdit(task.project_id) && (
              <button className="btn btn--sm" onClick={() => void app.writer.restore(task.id)}>
                Restore
              </button>
            )}
          </div>
        )}
        {!app.canEdit(task.project_id) && !d.deletedAt && (
          <div className="notice" role="note">
            <Icon name="i-eye" />
            <div>You can view this project. Ask its owner for edit access to change tasks.</div>
          </div>
        )}
        <div className="detail__main">
          {editable ? (
            <textarea
              ref={titleRef}
              className="input input--quiet detail__title"
              rows={1}
              value={title}
              aria-label="Title"
              maxLength={1000}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveTitle();
                  (e.target as HTMLTextAreaElement).blur();
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setTitle(d.title);
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
            />
          ) : (
            <h2 className={`detail__title detail__title--static${d.completedAt ? " is-done" : ""}`}>{d.title}</h2>
          )}
          <Notes task={task} editable={editable} />
        </div>

        <div className="stack stack--sm detail__props">
          <DueProp task={task} editable={editable} />
          <RepeatProp task={task} editable={editable} />
          <div className="prop">
            <span className="prop__name" id={`pri-${task.id}`}>
              Priority
            </span>
            <div className="prop__value">
              {!editable ? (
                <span className={`text-2 seg__p p${d.priority}`}>{d.priority === 4 ? "P4, no rush" : `P${d.priority}`}</span>
              ) : (
              <div className="seg" role="radiogroup" aria-labelledby={`pri-${task.id}`}>
                {([1, 2, 3, 4] as Priority[]).map((n) => (
                  <label className="seg__opt" key={n}>
                    <input
                      className="sr-only"
                      type="radio"
                      name={`pri-${task.id}`}
                      checked={d.priority === n}
                      disabled={!editable}
                      onChange={() => void app.writer.update(task.id, { priority: n })}
                    />
                    <span className={`seg__p p${n}`}>P{n}</span>
                  </label>
                ))}
              </div>
              )}
            </div>
          </div>
          <LabelsProp task={task} editable={editable} />
          <div className="prop">
            <label className="prop__name" htmlFor={`asg-${task.id}`}>
              Assigned to
            </label>
            <div className="prop__value">
              {project?.inbox ? (
                <span className="muted text-2">Only you. Share a project to assign tasks.</span>
              ) : !editable ? (
                <span className="text-2">{d.assignee ? (d.assignee === app.me.username ? "You" : d.assignee) : "Nobody"}</span>
              ) : (
                <span className="select select--sm">
                  <select
                    id={`asg-${task.id}`}
                    value={d.assignee ?? ""}
                    disabled={!editable}
                    onChange={(e) => void app.writer.update(task.id, { assignee: e.target.value || null })}
                  >
                    <option value="">Nobody</option>
                    {[...new Set([...people, ...(d.assignee ? [d.assignee] : [])])].map((u) => (
                      <option key={u} value={u}>
                        {u === app.me.username ? `${u} (you)` : u}
                      </option>
                    ))}
                  </select>
                </span>
              )}
            </div>
          </div>
          <ReminderProp task={task} editable={editable} />
        </div>

        <Subtasks task={task} editable={editable} depth={depth} />
        <Comments task={task} canComment={editable} />
        <History task={task} />
        <p className="text-1 faint detail__foot">
          Created {shortDate(task.created_at, app.tz)}.
          {d.completedAt ? ` Completed ${ago(d.completedAt, app.tz)}.` : ""}
          {task.updated_at !== task.created_at ? ` Last changed ${ago(task.updated_at, app.tz)}.` : ""}
        </p>
      </div>
    </>
  );
}

function Notes({ task, editable }: { task: Task; editable: boolean }) {
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.data.description);
  useEffect(() => {
    if (!editing) setText(task.data.description);
  }, [task.data.description, editing]);
  const save = () => {
    setEditing(false);
    if (text !== task.data.description) void app.writer.update(task.id, { description: text });
  };
  if (editing)
    return (
      <div className="detail__notes-edit">
        <textarea
          className="textarea detail__notes-input"
          value={text}
          autoFocus
          aria-label="Notes, in Markdown"
          maxLength={100000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setText(task.data.description);
              setEditing(false);
            }
          }}
        />
        <div className="row">
          <span className="text-1 muted grow">Markdown works: **bold**, lists, [links](https://…). Ctrl+Enter saves.</span>
          <button className="btn btn--sm btn--quiet" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button className="btn btn--sm btn--primary" onClick={save}>
            Save notes
          </button>
        </div>
      </div>
    );
  if (!task.data.description.trim())
    return editable ? (
      <button className="chip chip--empty detail__add-notes" onClick={() => setEditing(true)}>
        <Icon name="i-pencil" />
        Add notes
      </button>
    ) : null;
  return (
    <div className="detail__notes">
      <div className="prose detail__prose" dangerouslySetInnerHTML={sanitizedHtml(task.data.description)} />
      {editable && (
        <button className="btn btn--sm btn--quiet detail__edit-notes" onClick={() => setEditing(true)}>
          <Icon name="i-pencil" />
          Edit notes
        </button>
      )}
    </div>
  );
}

function DueProp({ task, editable }: { task: Task; editable: boolean }) {
  const app = useApp();
  const d = task.data;
  const [editing, setEditing] = useState(false);
  const info = d.due ? dueInfo(d.due, d.dateOnly, app.tz, app.today) : null;
  const tone = info?.tone === "overdue" ? " chip--overdue" : "";
  return (
    <div className="prop prop--wrap">
      <span className="prop__name">Due</span>
      <div className="prop__value">
        {editing ? (
          <DueEditor
            task={task}
            onCancel={() => setEditing(false)}
            onSave={(due, dateOnly) => {
              setEditing(false);
              void app.writer.update(task.id, due ? { due, dateOnly } : { due: null, dateOnly: false, reminderOffsetMinutes: null });
            }}
          />
        ) : editable ? (
          <button className={`chip${info ? tone : " chip--empty"}`} onClick={() => setEditing(true)} aria-label={info ? `Due ${info.text}. Change` : "Set a due date"}>
            <Icon name={info?.timed ? "i-clock" : "i-calendar"} />
            {info ? info.text : "No date"}
          </button>
        ) : (
          <span className="text-2">{info ? info.text : "No date"}</span>
        )}
      </div>
    </div>
  );
}

/** Date with an optional time, plus the dates people pick most. */
export function DueEditor({ task, onSave, onCancel }: { task: Task; onSave: (due: string | null, dateOnly: boolean) => void; onCancel: () => void }) {
  const app = useApp();
  const local = task.data.due ? toLocalInputs(task.data.due, app.tz) : null;
  const [date, setDate] = useState(local?.date ?? app.today);
  const [time, setTime] = useState(task.data.due && !task.data.dateOnly ? local!.time : "");
  const weekday = new Date(app.today + "T12:00:00Z").getUTCDay();
  const nextMonday = addDays(app.today, ((8 - weekday) % 7) || 7);
  const picks: [string, string][] = [
    ["Today", app.today],
    ["Tomorrow", addDays(app.today, 1)],
    ["Next Monday", nextMonday],
    ["In a week", addDays(app.today, 7)],
  ];
  return (
    <form
      className="recur due-edit"
      aria-label="Due date"
      onSubmit={(e) => {
        e.preventDefault();
        if (date) onSave(fromLocalInputs(date, time || null, app.tz), !time);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="row due-edit__picks">
        {picks.map(([label, key]) => (
          <button key={label} type="button" className="chip" aria-pressed={date === key} onClick={() => setDate(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="row due-edit__inputs">
        <label className="field">
          <span className="field__label">Date</span>
          <input className="input input--sm" type="date" value={date} required data-autofocus onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Time</span>
          <input className="input input--sm" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <p className="recur__summary">{date ? dueInfo(fromLocalInputs(date, time || null, app.tz), !time, app.tz, app.today).text : "Pick a date."}{!time && <span className="muted"> All day.</span>}</p>
      <div className="row recur__actions">
        {task.data.due && (
          <button type="button" className="btn btn--sm btn--quiet btn--danger due-edit__clear" onClick={() => onSave(null, false)}>
            Remove date
          </button>
        )}
        <button type="button" className="btn btn--sm btn--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={!date}>
          Save
        </button>
      </div>
    </form>
  );
}

function RepeatProp({ task, editable }: { task: Task; editable: boolean }) {
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const r = task.data.recurrence;
  return (
    <div className="prop prop--wrap">
      <span className="prop__name">Repeats</span>
      <div className="prop__value">
        {editing ? (
          <RecurrenceEditor
            value={r}
            due={task.data.due}
            tz={app.tz}
            onCancel={() => setEditing(false)}
            onSave={(next) => {
              setEditing(false);
              const change: Partial<Task["data"]> = { recurrence: next };
              // A repeating task needs a start; use today when it has no date.
              if (next && !task.data.due) Object.assign(change, { due: fromLocalInputs(app.today, null, app.tz), dateOnly: true });
              void app.writer.update(task.id, change);
            }}
          />
        ) : editable ? (
          <button className={`chip${r ? "" : " chip--empty"}`} onClick={() => setEditing(true)} aria-label={r ? `Repeats: ${describeRecurrence(r)}. Change` : "Set a repeat"}>
            <Icon name="i-repeat" />
            {r ? describeRecurrence(r) : "Doesn't repeat"}
          </button>
        ) : (
          <span className="text-2">{r ? describeRecurrence(r) : "Doesn't repeat"}</span>
        )}
      </div>
    </div>
  );
}

function LabelsProp({ task, editable }: { task: Task; editable: boolean }) {
  const app = useApp();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const mine = task.data.labels.map((id) => app.labelById.get(id)).filter((l) => !!l);
  const hidden = task.data.labels.length - mine.length;
  const toggle = (id: string) => {
    const has = task.data.labels.includes(id);
    void app.writer.update(task.id, { labels: has ? task.data.labels.filter((x) => x !== id) : [...task.data.labels, id] });
  };
  return (
    <div className="prop">
      <span className="prop__name">Labels</span>
      <div className="prop__value">
        {mine.map((l) => (
          <span className="chip" key={l.id}>
            <span className="label" style={{ "--dot": cssColor(l.data.color, l.data.name) } as React.CSSProperties}>
              {l.data.name}
            </span>
            {editable && (
              <button className="chip__x" aria-label={`Remove label ${l.data.name}`} onClick={() => toggle(l.id)}>
                <Icon name="i-x" size="sm" />
              </button>
            )}
          </span>
        ))}
        {hidden > 0 && <span className="text-2 muted">{hidden === 1 ? "1 label of someone else's" : `${hidden} labels of other people`}</span>}
        {editable && (
          <button className="chip chip--empty" aria-haspopup="menu" onClick={(e) => setMenu(anchorBelow(e.currentTarget, false, 220))}>
            <Icon name="i-plus" />
            Add label
          </button>
        )}
        {!editable && mine.length === 0 && hidden === 0 && <span className="text-2 muted">None</span>}
        {menu && (
          <Menu
            label="Labels"
            at={menu}
            onClose={() => setMenu(null)}
            items={[
              ...app.labels.map((l) => ({ label: l.data.name, dot: cssColor(l.data.color, l.data.name), checked: task.data.labels.includes(l.id), onSelect: () => toggle(l.id) })),
              { label: "New label…", icon: "i-plus", separatorBefore: app.labels.length > 0, onSelect: () => app.openLabelDialog(null) },
            ]}
          />
        )}
      </div>
    </div>
  );
}

function ReminderProp({ task, editable }: { task: Task; editable: boolean }) {
  const app = useApp();
  const d = task.data;
  const current = d.reminderAt ? "custom" : d.reminderOffsetMinutes !== null ? String(d.reminderOffsetMinutes) : "none";
  const [custom, setCustom] = useState(current === "custom");
  const local = d.reminderAt ? toLocalInputs(d.reminderAt, app.tz) : d.due ? toLocalInputs(d.due, app.tz) : null;
  const words = d.reminderAt
    ? `${dueInfo(d.reminderAt, false, app.tz, app.today).text}`
    : d.reminderOffsetMinutes !== null && d.due
      ? dueInfo(new Date(new Date(d.due).getTime() - d.reminderOffsetMinutes * 60000).toISOString(), false, app.tz, app.today).text
      : null;
  const notifications = typeof Notification !== "undefined" ? Notification.permission : "denied";
  return (
    <div className="prop prop--wrap">
      <label className="prop__name" htmlFor={`rem-${task.id}`}>
        Reminder
      </label>
      <div className="prop__value">
        {!editable ? (
          <span className="text-2">{words ? `${REMINDERS.find((r) => r.value === current)?.label ?? "At a set time"}, ${words}` : "No reminder"}</span>
        ) : (
        <span className="select select--sm">
          <select
            id={`rem-${task.id}`}
            disabled={!editable}
            value={custom ? "custom" : current}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") {
                setCustom(true);
                return;
              }
              setCustom(false);
              void app.writer.update(task.id, { reminderAt: null, reminderOffsetMinutes: v === "none" ? null : Number(v) });
            }}
          >
            {REMINDERS.map((r) => (
              <option key={r.value} value={r.value} disabled={r.minutes !== null && !d.due}>
                {r.label}
              </option>
            ))}
          </select>
        </span>
        )}
        {custom && editable && (
          <input
            className="input input--sm"
            type="datetime-local"
            aria-label="Remind me at"
            value={d.reminderAt && local ? `${local.date}T${local.time}` : ""}
            onChange={(e) => {
              const [date, time] = e.target.value.split("T");
              if (date && time) void app.writer.update(task.id, { reminderAt: fromLocalInputs(date, time, app.tz), reminderOffsetMinutes: null });
            }}
          />
        )}
        {words && editable && <span className="text-2 muted">{words}</span>}
        {words && notifications === "default" && editable && (
          <button className="btn btn--sm btn--quiet" onClick={() => void Notification.requestPermission()}>
            Also notify me outside this tab
          </button>
        )}
      </div>
    </div>
  );
}

function Subtasks({ task, editable, depth }: { task: Task; editable: boolean; depth: number }) {
  const app = useApp();
  const open = useOpenTasks();
  const completed = useCompletedTasks();
  const all = useMemo(() => [...(open.data ?? []), ...(completed.data ?? [])], [open.data, completed.data]);
  const children = (id: string) => all.filter((t) => t.data.parentId === id && !t.data.deletedAt).sort((a, b) => a.data.order - b.data.order || a.created_at.localeCompare(b.created_at));
  const kids = children(task.id);
  const rows = kids.flatMap((k) => [{ t: k, level: 0 }, ...(depth === 0 ? children(k.id).map((g) => ({ t: g, level: 1 })) : [])]);
  const done = kids.filter((k) => k.data.completedAt).length;
  if (depth >= 2 && kids.length === 0) return null;
  return (
    <section className="detail__section" aria-labelledby={`sub-${task.id}`}>
      <div className="row row--between">
        <h3 id={`sub-${task.id}`}>Subtasks</h3>
        {kids.length > 0 && (
          <span className="text-2 muted">
            {done} of {kids.length}
          </span>
        )}
      </div>
      {kids.length > 0 && (
        <div className="progress progress--thin detail__progress" role="progressbar" aria-label="Subtasks done" aria-valuenow={done} aria-valuemin={0} aria-valuemax={kids.length}>
          <div className="progress__bar" style={{ "--value": `${(done / kids.length) * 100}%` } as React.CSSProperties} />
        </div>
      )}
      {rows.length > 0 && (
        <ul className="tasks">
          {rows.map(({ t, level }) => (
            <li key={t.id} className={`task task--sub${level ? " task--sub2" : ""}${t.data.completedAt ? " is-done" : ""}`}>
              <input
                className={`check check--round p${t.data.priority}`}
                type="checkbox"
                checked={!!t.data.completedAt}
                disabled={!editable || isTemp(t.id)}
                aria-label={`${t.data.completedAt ? "Reopen" : "Complete"} ${t.data.title}`}
                onChange={() => void (t.data.completedAt ? app.writer.uncomplete(t.id) : app.writer.complete(t.id, { toast: false }))}
              />
              <button className="task__open task__title" onClick={() => app.openTask(t.id)}>
                {t.data.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {editable && depth < 2 && (
        <QuickAdd compact projectId={task.project_id} sectionId={task.data.sectionId} parentId={task.id} placeholder={depth === 1 ? "Add a step" : "Add a subtask"} />
      )}
    </section>
  );
}

function Comments({ task, canComment }: { task: Task; canComment: boolean }) {
  const app = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const comments = useComments(task.id, !isTemp(task.id));
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    const temp: Comment = { id: `tmp-${Date.now()}`, task_id: task.id, author: app.me.username, body: text, created_at: new Date().toISOString() };
    qc.setQueryData<Comment[]>(keys.comments(task.id), (l) => [...(l ?? []), temp]);
    setBody("");
    try {
      const c = await post<Comment>(`/api/tasks/${task.id}/comments`, { body: text });
      qc.setQueryData<Comment[]>(keys.comments(task.id), (l) => [...(l ?? []).filter((x) => x.id !== temp.id && x.id !== c.id), c]);
    } catch (e) {
      qc.setQueryData<Comment[]>(keys.comments(task.id), (l) => (l ?? []).filter((x) => x.id !== temp.id));
      setBody(text);
      toast({ text: `Couldn't post your comment. ${errorText(e)}`, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  const list = comments.data ?? [];
  return (
    <section className="detail__section stack stack--sm" aria-labelledby={`com-${task.id}`}>
      <h3 id={`com-${task.id}`}>Comments{list.length ? <span className="nav__count"> {list.length}</span> : null}</h3>
      {comments.isPending && !isTemp(task.id) ? <span className="skeleton skeleton--text" /> : null}
      {list.map((c) => (
        <div className={`comment${c.id.startsWith("tmp-") ? " is-pending" : ""}`} key={c.id}>
          <Avatar name={c.author} size="sm" />
          <div>
            <span className="comment__who">{c.author === app.me.username ? "You" : c.author}</span>
            <span className="comment__when">{ago(c.created_at, app.tz)}</span>
            <div className="comment__text prose" dangerouslySetInnerHTML={sanitizedHtml(c.body)} />
          </div>
        </div>
      ))}
      {canComment && (
        <form
          className="row comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Avatar name={app.me.username} size="sm" />
          <textarea
            className="textarea grow comment-form__input"
            rows={1}
            placeholder="Write a comment"
            aria-label="Write a comment"
            value={body}
            maxLength={50000}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn btn--sm" disabled={busy || !body.trim()}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}

const VERB: Record<string, string> = {
  created: "added this",
  updated: "changed this",
  completed: "completed this",
  commented: "commented",
  moved: "moved this to another project",
};

function History({ task }: { task: Task }) {
  const app = useApp();
  const [openList, setOpen] = useState(false);
  const activity = useActivity(openList ? task.project_id : null);
  const rows = useMemo(
    () =>
      (activity.data ?? [])
        .filter((r: ActivityRow) => {
          const t = r.data.task as { id?: string } | undefined;
          return t?.id === task.id || r.data.taskId === task.id || r.data.id === task.id;
        })
        .slice(0, 30),
    [activity.data, task.id],
  );
  return (
    <section className="detail__section">
      <button className="btn btn--sm btn--quiet detail__history-toggle" aria-expanded={openList} onClick={() => setOpen(!openList)}>
        <Icon name={openList ? "i-chev-d" : "i-chev-r"} />
        Activity
      </button>
      {openList && (
        <ul className="activity">
          {activity.isPending && <li className="skeleton skeleton--text" />}
          {!activity.isPending && rows.length === 0 && <li className="muted text-2">No changes recorded yet.</li>}
          {rows.map((r) => {
            const t = r.data.task as Task | undefined;
            const verb = r.kind === "updated" && t?.data.deletedAt ? "deleted this" : r.kind === "updated" && t && !t.data.completedAt && r.data ? VERB.updated : (VERB[r.kind] ?? r.kind);
            return (
              <li key={String(r.id)}>
                <span>
                  <strong>{r.actor === app.me.username ? "You" : r.actor}</strong> {verb}
                </span>
                <span className="faint">{ago(r.created_at, app.tz)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
