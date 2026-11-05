// Shapes from ../../API.md. Field names follow the wire format.

export interface Me {
  username: string;
  name: string;
  email: string;
  timezone: string;
  groups: string[];
  authPublicUrl: string;
  homeUrl: string;
}

export interface ProjectData {
  name: string;
  color: string;
  emoji: string;
  archived: boolean;
  order: number;
}

export interface Project {
  id: string;
  owner: string;
  inbox: boolean;
  role: Role;
  memberCount: number;
  data: ProjectData;
}

export interface Section {
  id: string;
  project_id: string;
  data: { name: string; order: number };
}

export interface Label {
  id: string;
  owner: string;
  data: { name: string; color: string };
}

export type RecurrenceKind = "days" | "weeks" | "months" | "years" | "weekdays" | "weekly";

export interface Recurrence {
  kind: RecurrenceKind;
  interval: number;
  days?: number[];
  day?: number;
  from: "due" | "completion";
}

export type Priority = 1 | 2 | 3 | 4;

export interface TaskData {
  title: string;
  description: string;
  due: string | null;
  dateOnly: boolean;
  priority: Priority;
  labels: string[];
  sectionId: string | null;
  parentId: string | null;
  assignee: string | null;
  order: number;
  recurrence: Recurrence | null;
  reminderAt: string | null;
  reminderOffsetMinutes: number | null;
  completedAt: string | null;
  deletedAt: string | null;
}

export interface Task {
  id: string;
  project_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  data: TaskData;
}

export interface TaskResult {
  task: Task;
  next: Task | null;
}

export interface Comment {
  id: string;
  task_id: string;
  author: string;
  body: string;
  created_at: string;
}

export type Role = "owner" | "editor" | "viewer";

export interface Members {
  owner: string;
  members: { username: string; role: "editor" | "viewer" }[];
}

export interface ActivityRow {
  id: string | number;
  project_id: string | null;
  recipient: string | null;
  kind: string;
  actor: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface ParsedQuickAdd {
  title: string;
  priority: number;
  project: string | null;
  labels: string[];
  due: string | null;
  dateOnly: boolean;
  recurrence: Recurrence | null;
}

/** One record from GET /api/events. `kind` is the SSE `event:` field. */
export interface LiveEvent {
  kind: string;
  id: string;
  projectId: string | null;
  actor: string;
  data: Record<string, unknown>;
  time: string;
}

export type TaskCreate = Omit<TaskData, "completedAt" | "deletedAt">;
