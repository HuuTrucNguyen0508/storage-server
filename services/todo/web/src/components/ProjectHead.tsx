// The head of a project page: name, who can see it, and the project's actions.

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { del, errorText, patch, post } from "../api/client";
import type { Project } from "../api/types";
import { useApp } from "../app/context";
import { keys } from "../data/queries";
import { cssColor } from "../lib/colors";
import { anchorBelow, ConfirmDialog, Icon, Menu, type MenuAnchor, navigate, useToast } from "./ui";

export function ProjectHead({ project, sortControl }: { project: Project; sortControl: ReactNode }) {
  const app = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "leave" | null>(null);
  const role = app.roleOf(project.id);
  const count = project.memberCount;
  const owner = role === "owner";

  const setArchived = async (archived: boolean) => {
    try {
      const p = await patch<Project>(`/api/projects/${project.id}`, { archived });
      qc.setQueryData<Project[]>(keys.projects, (l) => l?.map((x) => (x.id === p.id ? { ...x, ...p } : x)));
      toast({
        text: archived ? `Archived ${project.data.name}. Find it under Archived in the sidebar.` : `Restored ${project.data.name}.`,
        tone: "ok",
        action: archived ? { label: "Undo", run: () => void setArchived(false) } : undefined,
      });
    } catch (e) {
      toast({ text: `Couldn't change ${project.data.name}. ${errorText(e)}`, tone: "danger" });
    }
  };

  return (
    <div className="page-head list-head">
      <h1 className="project-title">
        <span className="nav__dot list-head__dot" style={{ background: cssColor(project.data.color, project.data.name) }} />
        {project.data.emoji && <span aria-hidden="true">{project.data.emoji}</span>}
        <span>{project.data.name}</span>
      </h1>
      {project.data.archived && <span className="badge">Archived</span>}
      {role === "viewer" && (
        <span className="badge badge--outline" title="You can see this project but not change it">
          <Icon name="i-eye" size="sm" />
          View only
        </span>
      )}
      <button className="btn btn--sm" onClick={() => app.openMembers(project.id)} aria-label={count > 1 ? `${count} members` : "Share project"}>
        <Icon name="i-users" />
        {count > 1 ? `${count} members` : "Share"}
      </button>
      <span className="grow" />
      {sortControl}
      <button className="btn btn--sm btn--quiet btn--icon" aria-label="Project options" aria-haspopup="menu" onClick={(e) => setMenu(anchorBelow(e.currentTarget, true, 220))}>
        <Icon name="i-more" />
      </button>
      {menu && (
        <Menu
          label={`${project.data.name} options`}
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            ...(app.canEdit(project.id) ? [{ label: "Edit project", icon: "i-pencil", onSelect: () => app.openProjectDialog(project) }] : []),
            { label: owner ? "Share" : "Members", icon: "i-users", onSelect: () => app.openMembers(project.id) },
            ...(app.canEdit(project.id)
              ? [{ label: project.data.archived ? "Restore from archive" : "Archive", icon: "i-archive", onSelect: () => void setArchived(!project.data.archived) }]
              : []),
            ...(owner
              ? [{ label: "Delete project", icon: "i-trash", danger: true, separatorBefore: true, onSelect: () => setConfirm("delete") }]
              : [{ label: "Leave project", icon: "i-external", danger: true, separatorBefore: true, onSelect: () => setConfirm("leave") }]),
          ]}
        />
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          title={`Delete ${project.data.name}?`}
          action="Delete project"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await del(`/api/projects/${project.id}`);
              qc.setQueryData<Project[]>(keys.projects, (l) => l?.filter((x) => x.id !== project.id));
              void qc.invalidateQueries({ queryKey: ["tasks"] });
              navigate("/today");
              toast({ text: `Deleted ${project.data.name}.`, tone: "ok" });
            } catch (e) {
              toast({ text: `Couldn't delete ${project.data.name}. ${errorText(e)}`, tone: "danger" });
            }
          }}
        >
          <p>Its tasks, sections and comments go too, for everyone it's shared with. This can't be undone. Archive it instead to keep the history.</p>
        </ConfirmDialog>
      )}
      {confirm === "leave" && (
        <ConfirmDialog
          title={`Leave ${project.data.name}?`}
          action="Leave project"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await post(`/api/projects/${project.id}/leave`, {});
              qc.setQueryData<Project[]>(keys.projects, (l) => l?.filter((x) => x.id !== project.id));
              void qc.invalidateQueries({ queryKey: ["tasks"] });
              navigate("/today");
              toast({ text: `You left ${project.data.name}.`, tone: "ok" });
            } catch (e) {
              toast({ text: `Couldn't leave ${project.data.name}. ${errorText(e)}`, tone: "danger" });
            }
          }}
        >
          <p>You'll stop seeing its tasks. The owner can add you again.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
