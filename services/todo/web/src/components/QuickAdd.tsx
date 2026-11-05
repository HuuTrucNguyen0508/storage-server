// Quick add with the inline syntax, using the API's own parser so the preview
// shows exactly what will be saved: "Pay rent tomorrow 9am p1 #Home @bills every month".

import { useQueryClient } from "@tanstack/react-query";
import { forwardRef, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { parseQuickAdd } from "../../../api/src/quickadd/index.ts";
import { errorText, post } from "../api/client";
import type { Label, Priority, Project, Recurrence, Task } from "../api/types";
import { useApp } from "../app/context";
import { orderAtEnd } from "../data/model";
import { getCaches, keys } from "../data/queries";
import { colorOf, cssColor, PALETTE } from "../lib/colors";
import { dueInfo, fromLocalInputs } from "../lib/dates";
import { describeRecurrence } from "../lib/recurrence";
import { Icon, navigate, useToast } from "./ui";

export interface QuickAddHandle {
  focus: () => void;
}

export interface Chip {
  kind: "due" | "repeat" | "priority" | "project" | "label" | "section";
  text: string;
  tone?: "warn" | "new";
  dot?: string;
}

export interface Preview {
  title: string;
  chips: Chip[];
  project: Project | null;
  projectMissing: string | null;
  labels: { name: string; existing: Label | null }[];
  priority: Priority;
  due: string | null;
  dateOnly: boolean;
  recurrence: Recurrence | null;
}

/** What quick add recognized in `text`, resolved against the user's projects and labels. */
export function preview(
  text: string,
  ctx: { tz: string; today: string; projects: Project[]; labels: Label[]; canEdit: (id: string) => boolean; now?: Date },
): Preview {
  const p = parseQuickAdd(text, { timezone: ctx.tz, now: ctx.now });
  const chips: Chip[] = [];
  let project: Project | null = null;
  let projectMissing: string | null = null;
  if (p.project) {
    const name = p.project.toLowerCase();
    project = ctx.projects.find((x) => !x.data.archived && x.data.name.toLowerCase() === name && ctx.canEdit(x.id)) ?? null;
    if (!project && name === "inbox") project = ctx.projects.find((x) => x.inbox) ?? null;
    if (project) chips.push({ kind: "project", text: project.inbox ? "Inbox" : project.data.name, dot: cssColor(project.data.color, project.data.name) });
    else {
      projectMissing = p.project;
      chips.push({ kind: "project", text: `No project “${p.project}”`, tone: "warn" });
    }
  }
  if (p.due) chips.push({ kind: "due", text: dueInfo(p.due, p.dateOnly, ctx.tz, ctx.today).text });
  if (p.recurrence) chips.push({ kind: "repeat", text: describeRecurrence(p.recurrence) });
  if (p.priority !== 4) chips.push({ kind: "priority", text: `Priority ${p.priority}` });
  const labels = p.labels.map((name) => ({ name, existing: ctx.labels.find((l) => l.data.name.toLowerCase() === name.toLowerCase()) ?? null }));
  for (const l of labels)
    chips.push(
      l.existing
        ? { kind: "label", text: l.existing.data.name, dot: cssColor(l.existing.data.color, l.existing.data.name) }
        : { kind: "label", text: `New label ${l.name}`, tone: "new", dot: colorOf("", l.name).css },
    );
  return {
    title: p.title,
    chips,
    project,
    projectMissing,
    labels,
    priority: p.priority as Priority,
    due: p.due,
    dateOnly: p.dateOnly,
    recurrence: p.recurrence,
  };
}

const CHIP_ICON: Record<Chip["kind"], string> = {
  due: "i-calendar",
  repeat: "i-repeat",
  priority: "i-flag",
  project: "",
  label: "",
  section: "",
};

export function ChipRow({ chips, id }: { chips: Chip[]; id?: string }) {
  if (!chips.length) return null;
  return (
    <ul className="qa-chips" id={id} aria-label="Recognized">
      {chips.map((c, i) => (
        <li key={i} className={`qa-chip${c.tone ? " qa-chip--" + c.tone : ""}${c.kind === "priority" ? " qa-chip--" + c.text.slice(-1) : ""}`}>
          {c.tone === "warn" ? (
            <Icon name="i-alert" />
          ) : c.dot ? (
            <span className="nav__dot" style={{ background: c.dot }} />
          ) : CHIP_ICON[c.kind] ? (
            <Icon name={CHIP_ICON[c.kind]} />
          ) : null}
          {c.text}
        </li>
      ))}
    </ul>
  );
}

export interface QuickAddProps {
  projectId: string | null;
  sectionId?: string | null;
  parentId?: string | null;
  /** Day to use when the text names none (the Today view adds for today). */
  defaultDay?: string | null;
  placeholder?: string;
  compact?: boolean;
  onAdded?: (t: Task) => void;
}

export const QuickAdd = forwardRef<QuickAddHandle, QuickAddProps>(function QuickAdd(props, ref) {
  const app = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const chipsId = useId();
  const errId = useId();
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  const pv = useMemo(
    () => (text.trim() ? preview(text, { tz: app.tz, today: app.today, projects: app.projects, labels: app.labels, canEdit: app.canEdit }) : null),
    [text, app.tz, app.today, app.projects, app.labels, app.canEdit],
  );

  const fallbackProject = props.projectId ?? app.inbox?.id ?? null;

  const [missing, setMissing] = useState<string | null>(null);

  const createProjectAndAdd = async (name: string) => {
    setBusy(true);
    try {
      const order = orderAtEnd(app.projects.map((p) => p.data));
      const p: Project = { ...await post<Project>("/api/projects", { name, color: colorOf("", name).name, order }), role: "owner", memberCount: 1 };
      qc.setQueryData<Project[]>(keys.projects, (l) => [...(l ?? []).filter((x) => x.id !== p.id), p]);
      setMissing(null);
      await add(p);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void add(null);
  };

  const add = async (madeProject: Project | null) => {
    if (!pv) return;
    if (!pv.title) return setError("Type what needs doing, then the details.");
    if (pv.projectMissing && !madeProject) {
      setMissing(pv.projectMissing);
      return setError(`There's no project called “${pv.projectMissing}” you can add to.`);
    }
    const target = madeProject ?? pv.project;
    const projectId = target?.id ?? fallbackProject;
    if (!projectId || !app.canEdit(projectId)) return setError("You can only view this project, so you can't add tasks here.");
    setBusy(true);
    try {
      const labelIds: string[] = [];
      for (const l of pv.labels) {
        if (l.existing) labelIds.push(l.existing.id);
        else {
          const created = await post<Label>("/api/labels", { name: l.name, color: colorOf("", l.name).name ?? PALETTE[0].name });
          qc.setQueryData<Label[]>(keys.labels, (list) => [...(list ?? []), created]);
          labelIds.push(created.id);
        }
      }
      const sameList = (getCaches(qc).open ?? []).filter(
        (t) => t.project_id === projectId && (target ? t.data.sectionId === null : t.data.sectionId === (props.sectionId ?? null)),
      );
      let due = pv.due;
      let dateOnly = pv.dateOnly;
      if (!due && props.defaultDay) {
        due = fromLocalInputs(props.defaultDay, null, app.tz);
        dateOnly = true;
      }
      const sectionId = target && target.id !== props.projectId ? null : (props.sectionId ?? null);
      setText("");
      setError("");
      const created = await app.writer.create(projectId, {
        title: pv.title,
        priority: pv.priority,
        due,
        dateOnly,
        recurrence: pv.recurrence,
        labels: labelIds,
        sectionId,
        parentId: props.parentId ?? null,
        order: orderAtEnd(sameList.map((t) => t.data)),
      });
      if (created) {
        props.onAdded?.(created);
        if (projectId !== (props.projectId ?? projectId)) {
          const p = madeProject ?? app.projectById.get(projectId);
          toast({
            text: `Added “${created.data.title}” to ${p?.inbox ? "Inbox" : (p?.data.name ?? "another project")}.`,
            tone: "ok",
            action: { label: "Open", run: () => navigate(p?.inbox ? "/inbox" : `/p/${projectId}`) },
          });
        }
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const readOnly = !!props.projectId && !app.canEdit(props.projectId);
  if (readOnly) return null;

  return (
    <form className={`quickadd-wrap${props.compact ? " quickadd-wrap--compact" : ""}`} onSubmit={submit}>
      <div className="quickadd">
        <Icon name="i-plus" />
        <input
          ref={input}
          className="input"
          name="quickadd"
          autoComplete="off"
          spellCheck
          value={text}
          maxLength={2000}
          placeholder={props.placeholder ?? "Add a task. Try: Pay rent tomorrow 9am p1 #Home @bills every month"}
          aria-label={props.parentId ? "Add a subtask" : "Add a task"}
          aria-describedby={[pv?.chips.length ? chipsId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
            setMissing(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (text) {
                e.stopPropagation();
                setText("");
                setError("");
              } else input.current?.blur();
            }
          }}
        />
        {!props.compact && <span className="quickadd__hint hide-sm">{text ? "Enter to add" : <kbd className="kbd">Q</kbd>}</span>}
      </div>
      {pv && <ChipRow chips={pv.chips} id={chipsId} />}
      {error && (
        <p className="field__error qa-error" id={errId} role="alert">
          {error}
          {missing && (
            <>
              {" "}
              <button type="button" className="btn btn--sm qa-create" disabled={busy} onClick={() => void createProjectAndAdd(missing)}>
                Create {missing} and add
              </button>
            </>
          )}
        </p>
      )}
    </form>
  );
});

