// What every screen needs: who is signed in, their projects and roles, labels,
// the timezone and today's date in it, the writer, and the shell's actions.

import { createContext, useContext } from "react";
import type { Label, Me, Project, Role, Section, Task } from "../api/types";
import type { Access } from "../data/queries";
import type { TaskWriter } from "../data/writer";
import type { StreamState } from "../lib/sse";

export interface ListModel {
  /** Groups in display order; ids are "g:<projectId>:<sectionId or ->". */
  groups: { id: string; projectId: string; sectionId: string | null; taskIds: string[] }[];
  /** Whether rows can be reordered here (manual sort, a project list). */
  canReorder: boolean;
}

export interface AppCtx {
  me: Me;
  tz: string;
  today: string;
  projects: Project[];
  projectById: Map<string, Project>;
  inbox: Project | null;
  access: Map<string, Access>;
  roleOf: (projectId: string) => Role | null;
  canEdit: (projectId: string) => boolean;
  labels: Label[];
  labelById: Map<string, Label>;
  sections: Map<string, Section[]>;
  writer: TaskWriter;
  live: StreamState;
  openTask: (id: string | null, focus?: "title") => void;
  openQuickAdd: () => void;
  openMembers: (projectId: string) => void;
  openProjectDialog: (project: Project | null) => void;
  openLabelDialog: (label: Label | null) => void;
  openMoveDialog: (task: Task) => void;
  listModel: { current: ListModel | null };
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(AppContext);
  if (!c) throw new Error("useApp outside the app");
  return c;
}
