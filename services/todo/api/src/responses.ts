import { z } from "zod";
import {
  id,
  taskRow,
  sectionInput,
  labelInput,
  timezone,
  recurrence,
} from "./schema.js";
import { projectRow } from "./db.js";
const ok = z.object({ ok: z.literal(true) });
const profile = z.object({
  username: z.string(),
  name: z.string(),
  email: z.string(),
  timezone,
});
const section = z.object({ id, project_id: id, data: sectionInput });
const label = z.object({ id, owner: z.string(), data: labelInput });
const comment = z.object({
  id,
  task_id: id,
  author: z.string(),
  body: z.string(),
  created_at: z.coerce.date(),
});
const member = z.object({
  username: z.string(),
  role: z.enum(["editor", "viewer"]),
});
const activity = z.object({
  id: z.string(),
  project_id: id.nullable(),
  recipient: z.string().nullable(),
  kind: z.string(),
  actor: z.string(),
  data: z.json(),
  created_at: z.coerce.date(),
});
export const exportSchema = z.object({
  format: z.literal(1),
  timezone,
  projects: z.array(projectRow),
  sections: z.array(section),
  labels: z.array(label),
  members: z.array(member.extend({ project_id: id })),
  tasks: z.array(taskRow),
  comments: z.array(comment),
});
const update = z.object({ task: taskRow, next: taskRow.nullable() });
const shapes: Record<string, z.ZodType> = {
  "GET /healthz": z.object({ status: z.literal("ok") }),
  "GET /readyz": z.object({ status: z.literal("ready") }),
  "GET /api/me": profile.extend({
    groups: z.array(z.string()),
    authPublicUrl: z.string(),
    homeUrl: z.string(),
  }),
  "PATCH /api/me": profile,
  "GET /api/projects": z.array(projectRow),
  "POST /api/projects": projectRow,
  "PATCH /api/projects/:id": projectRow,
  "DELETE /api/projects/:id": ok,
  "GET /api/projects/:id/sections": z.array(section),
  "POST /api/projects/:id/sections": section,
  "PATCH /api/sections/:id": section,
  "DELETE /api/sections/:id": ok,
  "GET /api/labels": z.array(label),
  "POST /api/labels": label,
  "PATCH /api/labels/:id": label,
  "DELETE /api/labels/:id": ok,
  "POST /api/projects/:id/tasks": taskRow,
  "GET /api/tasks/:id": taskRow,
  "PATCH /api/tasks/:id": update,
  "GET /api/tasks": z.object({
    tasks: z.array(taskRow),
    groups: z.record(z.string(), z.array(taskRow)).optional(),
  }),
  "GET /api/tasks/:id/comments": z.array(comment),
  "POST /api/tasks/:id/comments": comment,
  "GET /api/projects/:id/members": z.object({
    owner: z.string(),
    members: z.array(member),
  }),
  "POST /api/projects/:id/members": member,
  "POST /api/projects/:id/remove-member": ok,
  "POST /api/projects/:id/leave": ok,
  "POST /api/projects/:id/transfer": ok,
  "GET /api/projects/:id/activity": z.array(activity),
  "POST /api/quick-add/parse": z.object({
    title: z.string(),
    priority: z.number().int().min(1).max(4),
    project: z.string().nullable(),
    labels: z.array(z.string()),
    due: z.iso.datetime().nullable(),
    dateOnly: z.boolean(),
    recurrence: recurrence.nullable(),
  }),
  "POST /api/quick-add": taskRow,
  "GET /api/export": exportSchema,
  "POST /api/import": ok.extend({
    projects: z.number().int(),
    tasks: z.number().int(),
    idMap: z.record(z.string(), id),
  }),
};
for (const action of ["complete", "uncomplete", "delete", "restore"])
  shapes[`POST /api/tasks/:id/${action}`] = update;
shapes["POST /api/tasks/:id/duplicate"] = taskRow;
export function responseSchema(method: string, path: string) {
  const shape = shapes[`${method} ${path}`];
  if (!shape) throw new Error(`Missing response schema: ${method} ${path}`);
  return shape;
}
