import { z } from "zod";
export const id = z.uuid();
export const timezone = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");
export const recurrence = z
  .object({
    kind: z.enum(["days", "weeks", "months", "years", "weekdays", "weekly"]),
    interval: z.number().int().min(1).max(999).default(1),
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    day: z.number().int().min(1).max(31).optional(),
    from: z.enum(["due", "completion"]).default("due"),
  })
  .strict()
  .refine(
    (v) => v.kind !== "weekly" || !!v.days?.length,
    "weekly requires days",
  );
export const projectInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    color: z.string().max(32).default("#6366f1"),
    emoji: z.string().max(32).default(""),
    archived: z.boolean().default(false),
    order: z.number().finite().default(0),
  })
  .strict();
export const sectionInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    order: z.number().finite().default(0),
  })
  .strict();
export const labelInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    color: z.string().max(32).default("#6366f1"),
  })
  .strict();
export const taskInput = z
  .object({
    title: z.string().trim().min(1).max(1000),
    description: z.string().max(100000).default(""),
    due: z.iso.datetime({ offset: true }).nullable().default(null),
    dateOnly: z.boolean().default(false),
    priority: z.number().int().min(1).max(4).default(4),
    labels: z.array(id).max(100).default([]),
    sectionId: id.nullable().default(null),
    parentId: id.nullable().default(null),
    assignee: z.string().max(100).nullable().default(null),
    order: z.number().finite().default(0),
    recurrence: recurrence.nullable().default(null),
    reminderAt: z.iso.datetime({ offset: true }).nullable().default(null),
    reminderOffsetMinutes: z
      .number()
      .int()
      .min(0)
      .max(525600)
      .nullable()
      .default(null),
  })
  .strict();
export const taskData = taskInput.extend({
  completedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  deletedAt: z.iso.datetime({ offset: true }).nullable().default(null),
});
// PATCH schemas must remove create defaults: Zod 4 partial() alone still applies defaults.
export const projectPatch = z
  .object({
    name: projectInput.shape.name.optional(),
    color: projectInput.shape.color.removeDefault().optional(),
    emoji: projectInput.shape.emoji.removeDefault().optional(),
    archived: projectInput.shape.archived.removeDefault().optional(),
    order: projectInput.shape.order.removeDefault().optional(),
  })
  .strict();
export const sectionPatch = z
  .object({
    name: sectionInput.shape.name.optional(),
    order: sectionInput.shape.order.removeDefault().optional(),
  })
  .strict();
export const labelPatch = z
  .object({
    name: labelInput.shape.name.optional(),
    color: labelInput.shape.color.removeDefault().optional(),
  })
  .strict();
export const taskPatch = z
  .object({
    title: taskData.shape.title.optional(),
    description: taskData.shape.description.removeDefault().optional(),
    due: taskData.shape.due.removeDefault().optional(),
    dateOnly: taskData.shape.dateOnly.removeDefault().optional(),
    priority: taskData.shape.priority.removeDefault().optional(),
    labels: taskData.shape.labels.removeDefault().optional(),
    sectionId: taskData.shape.sectionId.removeDefault().optional(),
    parentId: taskData.shape.parentId.removeDefault().optional(),
    assignee: taskData.shape.assignee.removeDefault().optional(),
    order: taskData.shape.order.removeDefault().optional(),
    recurrence: taskData.shape.recurrence.removeDefault().optional(),
    reminderAt: taskData.shape.reminderAt.removeDefault().optional(),
    reminderOffsetMinutes: taskData.shape.reminderOffsetMinutes
      .removeDefault()
      .optional(),
    completedAt: taskData.shape.completedAt.removeDefault().optional(),
    deletedAt: taskData.shape.deletedAt.removeDefault().optional(),
    version: z.number().int().positive(),
    projectId: id.optional(),
  })
  .strict();
export const taskRow = z.object({
  id,
  project_id: id,
  data: taskData,
  version: z.number().int(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type TaskData = z.infer<typeof taskData>;
export const jsonValue: z.ZodType<unknown> = z.json();
