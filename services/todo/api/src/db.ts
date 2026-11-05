import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { taskRow, taskData, type TaskData } from "./schema.js";
import { localParts, nextOccurrence } from "./quickadd/index.js";
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public current?: unknown,
  ) {
    super(message);
  }
}
export type Query = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;
export async function migrate(pool: pg.Pool) {
  let client: pg.PoolClient | undefined;
  for (let i = 0; i < 120; i++) {
    try {
      client = await pool.connect();
      break;
    } catch {
      await setTimeout(1000);
    }
  }
  if (!client) throw new Error("Database unavailable after 120 attempts");
  try {
    await client.query("SELECT pg_advisory_lock(7249123)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY)",
    );
    const db = drizzle(client);
    for (const file of (await readdir("migrations"))
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      if (
        (
          await client.query(
            "SELECT 1 FROM schema_migrations WHERE version=$1",
            [file],
          )
        ).rowCount
      )
        continue;
      await client.query("BEGIN");
      try {
        await db.execute(sql.raw(await readFile("migrations/" + file, "utf8")));
        await client.query("INSERT INTO schema_migrations VALUES($1)", [file]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(7249123)");
    client.release();
  }
}
export const projectRow = z.object({
  id: z.uuid(),
  owner: z.string(),
  data: z.object({
    name: z.string(),
    color: z.string(),
    emoji: z.string(),
    archived: z.boolean(),
    order: z.number(),
  }),
  inbox: z.boolean(),
});
export class Store {
  constructor(public pool: pg.Pool) {}
  async transaction<T>(fn: (q: Query) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async identity(user: string, name: string, email: string) {
    return this.transaction(async (q) => {
      await q.query(
        "INSERT INTO users(username,name,email) VALUES($1,$2,$3) ON CONFLICT(username) DO UPDATE SET name=excluded.name,email=excluded.email",
        [user, name, email],
      );
      await q.query(
        `INSERT INTO projects(id,owner,data,inbox) VALUES($1,$2,$3,true) ON CONFLICT(owner) WHERE inbox DO NOTHING`,
        [
          randomUUID(),
          user,
          {
            name: "Inbox",
            color: "#6366f1",
            emoji: "",
            archived: false,
            order: -1,
          },
        ],
      );
      return (await q.query("SELECT * FROM users WHERE username=$1", [user]))
        .rows[0];
    });
  }
  async role(
    q: Query,
    user: string,
    project: string,
    write = false,
    owner = false,
  ) {
    const r = await q.query(
      `SELECT p.owner,m.role FROM projects p LEFT JOIN members m ON m.project_id=p.id AND m.username=$1 WHERE p.id=$2 FOR UPDATE OF p`,
      [user, project],
    );
    const row = r.rows[0];
    if (!row || (row.owner !== user && !row.role))
      throw new ApiError(404, "Project not found");
    if (
      (owner && row.owner !== user) ||
      (write && row.owner !== user && row.role !== "editor")
    )
      throw new ApiError(403, "Insufficient project role");
    return row;
  }
  async visible(user: string) {
    return (
      await this.pool.query(
        `SELECT p.* FROM projects p WHERE p.owner=$1 OR EXISTS(SELECT 1 FROM members m WHERE m.project_id=p.id AND m.username=$1) ORDER BY (p.data->>'order')::float`,
        [user],
      )
    ).rows.map((v) => projectRow.parse(v));
  }
  async event(
    q: Query,
    project: string | null,
    user: string,
    kind: string,
    data: unknown,
    recipient: string | null = null,
  ) {
    // Allocate event IDs in commit order so SSE cursors cannot skip an uncommitted lower ID.
    await q.query("SELECT pg_advisory_xact_lock(7249124)");
    const r = await q.query(
      "INSERT INTO events(project_id,actor,kind,data,recipient) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [project, user, kind, data, recipient],
    );
    await q.query("SELECT pg_notify('todo_events',$1)", [String(r.rows[0].id)]);
  }
  async task(q: Query, user: string, id: string, write = false) {
    const row = (
      await q.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!row) throw new ApiError(404, "Task not found");
    const task = taskRow.parse(row);
    await this.role(q, user, task.project_id, write);
    return task;
  }
  async validateTask(
    q: Query,
    user: string,
    project: string,
    data: TaskData,
    id?: string,
  ) {
    if (
      data.sectionId &&
      !(
        await q.query("SELECT 1 FROM sections WHERE id=$1 AND project_id=$2", [
          data.sectionId,
          project,
        ])
      ).rowCount
    )
      throw new ApiError(400, "Section belongs to another project");
    if (data.parentId) {
      const parent = await this.task(q, user, data.parentId);
      if (parent.project_id !== project)
        throw new ApiError(400, "Parent belongs to another project");
      const cycle = await q.query(
        `WITH RECURSIVE ancestors AS (SELECT id,data->>'parentId' parent FROM tasks WHERE id=$1 UNION SELECT t.id,t.data->>'parentId' FROM tasks t JOIN ancestors a ON t.id::text=a.parent) SELECT 1 FROM ancestors WHERE id=$2`,
        [data.parentId, id ?? randomUUID()],
      );
      if (cycle.rowCount) throw new ApiError(400, "Subtask cycle");
    }
    if (data.assignee) {
      const r = await q.query(
        "SELECT 1 FROM projects WHERE id=$1 AND owner=$2 UNION SELECT 1 FROM members WHERE project_id=$1 AND username=$2",
        [project, data.assignee],
      );
      if (!r.rowCount) throw new ApiError(400, "Assignee must be a member");
    }
    if (data.labels.length) {
      const n = await q.query(
        "SELECT count(*)::int n FROM labels l WHERE l.id=ANY($1::uuid[]) AND (l.owner=$2 OR EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=$3 AND t.data->'labels' ? l.id::text))",
        [data.labels, user, project],
      );
      if (n.rows[0].n !== new Set(data.labels).size)
        throw new ApiError(400, "Unknown or private label");
    }
  }
  async create(q: Query, user: string, project: string, data: TaskData) {
    await this.role(q, user, project, true);
    await this.validateTask(q, user, project, data);
    if (
      data.due &&
      data.recurrence &&
      ["months", "years"].includes(data.recurrence.kind) &&
      !data.recurrence.day
    ) {
      const zone = (
        await q.query("SELECT timezone FROM users WHERE username=$1", [user])
      ).rows[0].timezone;
      data = {
        ...data,
        recurrence: {
          ...data.recurrence,
          day: localParts(new Date(data.due), zone).day,
        },
      };
    }
    const row = taskRow.parse(
      (
        await q.query(
          "INSERT INTO tasks(id,project_id,data) VALUES($1,$2,$3) RETURNING *",
          [randomUUID(), project, data],
        )
      ).rows[0],
    );
    await this.event(q, project, user, "created", { task: row });
    return row;
  }
  async update(
    user: string,
    id: string,
    version: number,
    patch: Partial<TaskData>,
    target?: string,
  ) {
    return this.transaction(async (q) => {
      const current = await this.task(q, user, id, true);
      if (current.version !== version)
        throw new ApiError(409, "Stale task version", current);
      const project = target ?? current.project_id;
      await this.role(q, user, project, true);
      const data = taskData.parse({ ...current.data, ...patch });
      await this.validateTask(q, user, project, data, id);
      if (project !== current.project_id) {
        const children = await q.query(
          "SELECT 1 FROM tasks WHERE data->>'parentId'=$1",
          [id],
        );
        if (children.rowCount)
          throw new ApiError(400, "Move subtasks before their parent");
        await this.event(q, current.project_id, user, "moved", {
          id,
          projectId: project,
        });
      }
      const row = taskRow.parse(
        (
          await q.query(
            "UPDATE tasks SET data=$2,project_id=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [id, data, project],
          )
        ).rows[0],
      );
      await this.event(
        q,
        project,
        user,
        data.completedAt && !current.data.completedAt ? "completed" : "updated",
        { task: row },
      );
      let next = null;
      if (data.completedAt && !current.data.completedAt && data.recurrence) {
        const profile = (
          await q.query("SELECT timezone FROM users WHERE username=$1", [user])
        ).rows[0];
        const due = nextOccurrence(
          data.recurrence,
          new Date(data.due ?? data.completedAt),
          new Date(data.completedAt),
          profile.timezone,
        );
        const delta =
          due.getTime() - new Date(data.due ?? data.completedAt).getTime();
        next = await this.create(q, user, project, {
          ...data,
          completedAt: null,
          deletedAt: null,
          due: due.toISOString(),
          reminderAt: data.reminderAt
            ? new Date(
                new Date(data.reminderAt).getTime() + delta,
              ).toISOString()
            : null,
        });
      }
      return { task: row, next };
    });
  }
  async events(user: string, after: string) {
    return (
      await this.pool.query(
        `SELECT e.* FROM events e WHERE e.id>$2 AND (e.recipient IS NULL OR e.recipient=$1) AND (e.project_id IS NULL AND e.recipient=$1 OR EXISTS(SELECT 1 FROM projects p WHERE p.id=e.project_id AND (p.owner=$1 OR EXISTS(SELECT 1 FROM members m WHERE m.project_id=p.id AND m.username=$1)))) ORDER BY e.id LIMIT 1000`,
        [user, after],
      )
    ).rows;
  }
  async reminders() {
    await this.transaction(async (q) => {
      const rows = await q.query(
        `SELECT t.*,p.owner FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.data->>'completedAt' IS NULL AND t.data->>'deletedAt' IS NULL AND coalesce((t.data->>'reminderAt')::timestamptz,(t.data->>'due')::timestamptz-(t.data->>'reminderOffsetMinutes')::int*interval '1 minute')<=now() AND t.reminder_claimed_at IS DISTINCT FROM coalesce((t.data->>'reminderAt')::timestamptz,(t.data->>'due')::timestamptz-(t.data->>'reminderOffsetMinutes')::int*interval '1 minute') LIMIT 100`,
      );
      for (const raw of rows.rows) {
        const t = taskRow.parse(raw);
        const at =
          t.data.reminderAt ??
          new Date(
            new Date(t.data.due ?? "").getTime() -
              (t.data.reminderOffsetMinutes ?? 0) * 60000,
          ).toISOString();
        const pending = await q.query(
          "UPDATE tasks SET reminder_claimed_at=$2 WHERE id=$1 AND version=$3 AND reminder_claimed_at IS DISTINCT FROM $2::timestamptz AND data->>'completedAt' IS NULL AND data->>'deletedAt' IS NULL RETURNING id",
          [t.id, at, t.version],
        );
        if (!pending.rowCount) continue;
        const claimed = await q.query(
          "INSERT INTO reminder_claims VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING task_id",
          [t.id, at],
        );
        if (claimed.rowCount) {
          const users = await q.query(
            "SELECT $1::text username UNION SELECT username FROM members WHERE project_id=$2",
            [raw.owner, t.project_id],
          );
          for (const u of users.rows)
            await this.event(
              q,
              t.project_id,
              "system",
              "reminder",
              { taskId: t.id, reminderAt: at },
              u.username,
            );
        }
      }
    });
  }
}
