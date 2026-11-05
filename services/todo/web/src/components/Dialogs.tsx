// Members (sharing), project and label editors, the move picker, shortcuts help.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorText, patch, post, del } from "../api/client";
import type { Label, Members, Project, Task } from "../api/types";
import { useApp } from "../app/context";
import { keys, useMembers } from "../data/queries";
import { orderAtEnd } from "../data/model";
import { getCaches } from "../data/queries";
import { cssColor, PALETTE } from "../lib/colors";
import { Avatar, ConfirmDialog, Dialog, navigate, useToast } from "./ui";

// ---- members ----

export function MembersDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const app = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const project = app.projectById.get(projectId);
  const members = useMembers(projectId);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "remove" | "transfer" | "leave"; user: string } | null>(null);
  if (!project) return null;
  const me = app.me.username;
  const isOwner = project.owner === me;
  const data: Members | undefined = members.data;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: keys.members(projectId) });
    await qc.invalidateQueries({ queryKey: keys.projects });
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = username.trim().replace(/^@/, "");
    if (!u) return setError("Type their username, like bob.");
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(u)) return setError("Usernames use letters, numbers, dots, dashes and underscores.");
    if (u === project.owner) return setError(u === me ? "You already own this project." : `${u} owns this project.`);
    setBusy(true);
    try {
      await post(`/api/projects/${projectId}/members`, { username: u, role });
      await refresh();
      setUsername("");
      setError("");
      toast({ text: `Shared ${project.data.name} with ${u}. They ${role === "editor" ? "can edit" : "can view"} it.`, tone: "ok" });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const setMemberRole = async (u: string, r: "editor" | "viewer") => {
    try {
      await post(`/api/projects/${projectId}/members`, { username: u, role: r });
      await refresh();
      toast({ text: `${u} ${r === "editor" ? "can edit" : "can view"} ${project.data.name} now.`, tone: "ok" });
    } catch (err) {
      toast({ text: `Couldn't change ${u}'s access. ${errorText(err)}`, tone: "danger" });
    }
  };

  return (
    <Dialog
      title={`${project.data.name} members`}
      size="sm"
      onClose={onClose}
      icon={<span className="nav__dot dialog__dot" style={{ background: cssColor(project.data.color, project.data.name) }} />}
      footer={
        <>
          {!isOwner && (
            <button className="btn btn--quiet btn--danger" onClick={() => setConfirm({ kind: "leave", user: me })}>
              Leave project
            </button>
          )}
          <button className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {isOwner && (
        <form className="form-row members-add" onSubmit={add}>
          <label className="field grow">
            <span className="field__label">Add a person</span>
            <input
              className="input"
              placeholder="Username"
              value={username}
              data-autofocus
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "members-err" : undefined}
              onChange={(e) => {
                setUsername(e.target.value);
                setError("");
              }}
            />
          </label>
          <label className="field members-add__role">
            <span className="field__label">Role</span>
            <span className="select">
              <select value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")}>
                <option value="editor">Can edit</option>
                <option value="viewer">Can view</option>
              </select>
            </span>
          </label>
          <button className="btn btn--primary members-add__btn" disabled={busy}>
            Add
          </button>
        </form>
      )}
      {error && (
        <p className="field__error" id="members-err" role="alert">
          {error}
        </p>
      )}
      {members.isPending ? (
        <span className="skeleton skeleton--text" />
      ) : (
        <ul className="list" aria-label="Members">
          {data && (
            <li className="list__item">
              <Avatar name={data.owner} />
              <div className="list__body">
                <div className="list__title">
                  {data.owner}
                  {data.owner === me ? " (you)" : ""}
                </div>
                <div className="list__meta">Owner. Can share, rename and delete the project.</div>
              </div>
            </li>
          )}
          {data?.members.map((m) => (
            <li className="list__item" key={m.username}>
              <Avatar name={m.username} />
              <div className="list__body">
                <div className="list__title">
                  {m.username}
                  {m.username === me ? " (you)" : ""}
                </div>
                <div className="list__meta">{m.role === "editor" ? "Can add, change and complete tasks." : "Can see tasks and comments, nothing more."}</div>
              </div>
              <div className="list__end">
                {isOwner ? (
                  <>
                    <label className="select select--quiet select--sm">
                      <select
                        aria-label={`${m.username}'s role`}
                        value={m.role}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "owner") setConfirm({ kind: "transfer", user: m.username });
                          else void setMemberRole(m.username, v as "editor" | "viewer");
                        }}
                      >
                        <option value="editor">Can edit</option>
                        <option value="viewer">Can view</option>
                        <option value="owner">Make owner</option>
                      </select>
                    </label>
                    <button className="btn btn--sm btn--quiet btn--icon" aria-label={`Remove ${m.username}`} onClick={() => setConfirm({ kind: "remove", user: m.username })}>
                      <svg className="icon" aria-hidden="true">
                        <use href="#i-x" />
                      </svg>
                    </button>
                  </>
                ) : (
                  <span className="badge">{m.role === "editor" ? "Can edit" : "Can view"}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-2 muted">
        {isOwner
          ? "Members see every task in this project, including ones assigned to others. Removing someone keeps the tasks they created."
          : "Only the owner can add or remove people."}
      </p>
      {confirm?.kind === "remove" && (
        <ConfirmDialog
          title={`Remove ${confirm.user}?`}
          action="Remove"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await post(`/api/projects/${projectId}/remove-member`, { username: confirm.user });
              await refresh();
              toast({ text: `Removed ${confirm.user} from ${project.data.name}.`, tone: "ok" });
            } catch (err) {
              toast({ text: `Couldn't remove ${confirm.user}. ${errorText(err)}`, tone: "danger" });
            }
          }}
        >
          <p>They stop seeing {project.data.name} right away. Tasks they created stay.</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === "transfer" && (
        <ConfirmDialog
          title={`Make ${confirm.user} the owner?`}
          action="Transfer ownership"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await post(`/api/projects/${projectId}/transfer`, { username: confirm.user });
              await refresh();
              toast({ text: `${confirm.user} owns ${project.data.name} now. You can still edit it.`, tone: "ok" });
            } catch (err) {
              toast({ text: `Couldn't transfer ${project.data.name}. ${errorText(err)}`, tone: "danger" });
            }
          }}
        >
          <p>They'll manage who can see it and can delete it. You stay on as an editor.</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === "leave" && (
        <ConfirmDialog
          title={`Leave ${project.data.name}?`}
          action="Leave project"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await post(`/api/projects/${projectId}/leave`, {});
              qc.setQueryData<Project[]>(keys.projects, (l) => l?.filter((x) => x.id !== projectId));
              void qc.invalidateQueries({ queryKey: ["tasks"] });
              onClose();
              navigate("/today");
              toast({ text: `You left ${project.data.name}.`, tone: "ok" });
            } catch (err) {
              toast({ text: `Couldn't leave ${project.data.name}. ${errorText(err)}`, tone: "danger" });
            }
          }}
        >
          <p>You'll stop seeing its tasks. The owner can add you again.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}

// ---- project editor ----

const EMOJI = ["", "🏠", "📦", "✈️", "🛒", "💼", "📚", "🔧", "🎉", "💡", "🌱", "🧾"];

export function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const app = useApp();
  const qc = useQueryClient();
  const [name, setName] = useState(project?.data.name ?? "");
  const [color, setColor] = useState<string>(project ? (PALETTE.find((p) => p.name === project.data.color)?.name ?? "") : "ochre");
  const [emoji, setEmoji] = useState(project?.data.emoji ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError("Give the project a name.");
    if (!project && app.projects.some((p) => !p.inbox && p.data.name.toLowerCase() === n.toLowerCase()))
      return setError(`You already have a project called ${n}. Quick add finds projects by name, so pick another.`);
    setBusy(true);
    try {
      const body = { name: n, color: color || project?.data.color || "ochre", emoji };
      if (project) {
        const p = await patch<Project>(`/api/projects/${project.id}`, body);
        qc.setQueryData<Project[]>(keys.projects, (l) => l?.map((x) => (x.id === p.id ? { ...x, ...p } : x)));
      } else {
        const order = orderAtEnd(app.projects.map((p) => p.data));
        const p = await post<Project>("/api/projects", { ...body, order });
        qc.setQueryData<Project[]>(keys.projects, (l) => [...(l ?? []).filter((x) => x.id !== p.id), { ...p, role: "owner", memberCount: 1 }]);
        navigate(`/p/${p.id}`);
      }
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={project ? `Edit ${project.data.name}` : "New project"}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="project-form" disabled={busy}>
            {project ? "Save changes" : "Create project"}
          </button>
        </>
      }
    >
      <form id="project-form" className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="input"
            data-autofocus
            value={name}
            maxLength={200}
            aria-invalid={error ? true : undefined}
            aria-describedby="project-help"
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
          />
          <span className="field__help" id="project-help">
            In quick add, type #{name.trim().split(/\s+/)[0] || "Name"} to add a task here{name.trim().includes(" ") ? " (single-word names are easiest to type)" : ""}.
          </span>
        </label>
        <fieldset className="field swatches">
          <legend className="field__label">Color</legend>
          <div className="row">
            {PALETTE.map((p) => (
              <label key={p.name} className="swatch" title={p.label}>
                <input className="sr-only" type="radio" name="color" checked={color === p.name} onChange={() => setColor(p.name)} />
                <span className="swatch__dot" style={{ background: p.css }} />
                <span className="sr-only">{p.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field swatches">
          <legend className="field__label">Emoji</legend>
          <div className="row emoji-row">
            {EMOJI.map((em) => (
              <label key={em || "none"} className="swatch swatch--emoji">
                <input className="sr-only" type="radio" name="emoji" checked={emoji === em} onChange={() => setEmoji(em)} />
                <span className="swatch__dot">{em || "None"}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

// ---- label editor ----

export function LabelDialog({ label, onClose }: { label: Label | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const app = useApp();
  const [name, setName] = useState(label?.data.name ?? "");
  const [color, setColor] = useState<string>(label ? (PALETTE.find((p) => p.name === label.data.color)?.name ?? "") : "cobalt");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim().replace(/^@/, "").replace(/\s+/g, "-");
    if (!n) return setError("Give the label a name.");
    if (app.labels.some((l) => l.id !== label?.id && l.data.name.toLowerCase() === n.toLowerCase())) return setError(`You already have a label called ${n}.`);
    try {
      const body = { name: n, color: color || label?.data.color || "cobalt" };
      const l = label ? await patch<Label>(`/api/labels/${label.id}`, body) : await post<Label>("/api/labels", body);
      qc.setQueryData<Label[]>(keys.labels, (list) => [...(list ?? []).filter((x) => x.id !== l.id), l]);
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Dialog
      title={label ? `Edit label ${label.data.name}` : "New label"}
      size="sm"
      onClose={onClose}
      footer={
        <>
          {label && (
            <button className="btn btn--quiet btn--danger" type="button" onClick={() => setConfirmDelete(true)}>
              Delete label
            </button>
          )}
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="label-form">
            {label ? "Save changes" : "Create label"}
          </button>
        </>
      }
    >
      <form id="label-form" className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Name</span>
          <input className="input" data-autofocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-describedby="label-help" />
          <span className="field__help" id="label-help">
            One word. In quick add, type @{name.trim().replace(/\s+/g, "-") || "name"}. Labels are yours alone; others don't see them.
          </span>
        </label>
        <fieldset className="field swatches">
          <legend className="field__label">Color</legend>
          <div className="row">
            {PALETTE.map((p) => (
              <label key={p.name} className="swatch" title={p.label}>
                <input className="sr-only" type="radio" name="lcolor" checked={color === p.name} onChange={() => setColor(p.name)} />
                <span className="swatch__dot" style={{ background: p.css }} />
                <span className="sr-only">{p.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </form>
      {confirmDelete && label && (
        <ConfirmDialog
          title={`Delete label ${label.data.name}?`}
          action="Delete label"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await del(`/api/labels/${label.id}`);
              qc.setQueryData<Label[]>(keys.labels, (list) => (list ?? []).filter((x) => x.id !== label.id));
              void qc.invalidateQueries({ queryKey: ["tasks"] });
              onClose();
              toast({ text: `Deleted label ${label.data.name}.`, tone: "ok" });
            } catch (err) {
              toast({ text: `Couldn't delete the label. ${errorText(err)}`, tone: "danger" });
            }
          }}
        >
          <p>It comes off every task that has it. The tasks stay.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}

// ---- move picker (keyboard and phone alternative to dragging) ----

export function MoveDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const app = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const targets = app.projects.filter((p) => app.canEdit(p.id) && !p.data.archived);
  const [projectId, setProjectId] = useState(task.project_id);
  const [sectionId, setSectionId] = useState<string>(task.data.sectionId ?? "");
  const sections = app.sections.get(projectId) ?? [];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const sid = sectionId || null;
    const from = { projectId: task.project_id, sectionId: task.data.sectionId };
    const order = orderAtEnd((getCaches(qc).open ?? []).filter((t) => t.project_id === projectId && (t.data.sectionId ?? null) === sid).map((t) => t.data));
    onClose();
    const ok = await app.writer.moveToProject(task.id, projectId, sid, order);
    if (ok) {
      const p = app.projectById.get(projectId);
      toast({
        text: `Moved “${task.data.title}” to ${p?.inbox ? "Inbox" : p?.data.name}${sid ? ` / ${sections.find((s) => s.id === sid)?.data.name}` : ""}.`,
        tone: "ok",
        action: { label: "Undo", run: () => void app.writer.moveToProject(task.id, from.projectId, from.sectionId) },
      });
    }
  };
  return (
    <Dialog
      title={`Move “${task.data.title}”`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="move-form">
            Move
          </button>
        </>
      }
    >
      <form id="move-form" className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Project</span>
          <span className="select">
            <select
              data-autofocus
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSectionId("");
              }}
            >
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.inbox ? "Inbox" : `${p.data.emoji ? p.data.emoji + " " : ""}${p.data.name}`}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="field">
          <span className="field__label">Section</span>
          <span className="select">
            <select value={sectionId} onChange={(e) => setSectionId(e.target.value)} disabled={!sections.length}>
              <option value="">No section</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.data.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        {task.data.parentId && projectId !== task.project_id && <p className="text-2 muted">It stops being a subtask when it moves to another project.</p>}
      </form>
    </Dialog>
  );
}

// ---- shortcuts ----

export const SHORTCUTS: [string, string][] = [
  ["Q", "Add a task"],
  ["/", "Search"],
  ["J  or  ↓", "Next task"],
  ["K  or  ↑", "Previous task"],
  ["X  or  Space", "Complete or reopen the selected task"],
  ["E  or  Enter", "Open the selected task"],
  ["Alt + ↑ / ↓", "Move the selected task up or down"],
  ["Esc", "Close the panel or dialog"],
  ["?", "Show these shortcuts"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" size="sm" onClose={onClose}>
      <table className="table table--compact shortcuts">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k}>
              <td>
                {k.split(/\s{2}or\s{2}/).map((part, i) => (
                  <span key={part}>
                    {i > 0 && <span className="muted"> or </span>}
                    <kbd className="kbd">{part}</kbd>
                  </span>
                ))}
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-2 muted">To drag with the keyboard, focus a row's grip, press Space, use the arrow keys, and press Space again to drop.</p>
    </Dialog>
  );
}
