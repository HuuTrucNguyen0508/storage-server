import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import pg from "pg";
import { z } from "zod";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { context, trace } from "@opentelemetry/api";
import { Store, ApiError, migrate, projectRow } from "./db.js";
import {
  id,
  projectInput,
  projectPatch,
  sectionPatch,
  labelPatch,
  sectionInput,
  labelInput,
  taskInput,
  taskData,
  taskPatch,
  timezone,
  jsonValue,
  taskRow,
} from "./schema.js";
import { dayKey, localParts, parseQuickAdd } from "./quickadd/index.js";
import { metrics } from "./metrics.js";
import { responseSchema, exportSchema } from "./responses.js";
declare module "fastify" {
  interface FastifyRequest {
    user: string;
    started: number;
  }
}
const configSchema = z.object({
  DATABASE_URL: z.string(),
  AUTH_MODE: z.enum(["header", "dev"]).default("header"),
  APP_ENV: z.string().default("production"),
  DEV_USER: z.string().default("alice"),
  DEV_GROUPS: z.string().default(""),
  EXPECTED_ORIGIN: z.url().default("https://todo.lab.localhost"),
  WEB_ROOT: z.string().default("../web/dist"),
  AUTH_PUBLIC_URL: z.string().default("https://auth.lab.localhost"),
  HOME_URL: z.string().default("https://home.lab.localhost/"),
});
export async function buildApp(env: NodeJS.ProcessEnv = process.env) {
  const cfg = configSchema.parse(env);
  if (cfg.AUTH_MODE === "dev" && cfg.APP_ENV !== "development")
    throw new Error("AUTH_MODE=dev requires APP_ENV=development");
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 15 });
  await migrate(pool);
  const store = new Store(pool);
  const m = metrics();
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: true,
    logger: {
      base: { service: "todo", pod: process.env.HOSTNAME ?? "local" },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      redact: ["req.headers.cookie", "req.headers.authorization"],
    },
  });
  app.decorateRequest("user", "");
  app.decorateRequest("started", 0);
  app.addHook("onRequest", async (req, reply) => {
    req.started = performance.now();
    m.active.inc();
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const type = req.headers["content-type"]?.split(";")[0];
      if (
        req.headers["x-requested-with"] !== "fetch" ||
        (req.headers.origin !== undefined &&
          req.headers.origin !== cfg.EXPECTED_ORIGIN) ||
        ((Number(req.headers["content-length"] ?? 0) > 0 ||
          req.headers["transfer-encoding"]) &&
          type !== "application/json")
      )
        throw new ApiError(403, "Request forgery check failed");
    }
    if (req.url.startsWith("/api/")) {
      const header = req.headers["remote-user"];
      req.user =
        cfg.AUTH_MODE === "dev"
          ? cfg.DEV_USER
          : typeof header === "string"
            ? header
            : "";
      if (!req.user) throw new ApiError(401, "Sign in required");
      await store.identity(
        req.user,
        String(req.headers["remote-name"] ?? req.user),
        String(req.headers["remote-email"] ?? ""),
      );
    }
  });
  app.addHook("onResponse", async (req, reply) => {
    m.active.dec();
    const span = trace.getSpan(context.active())?.spanContext();
    m.duration.observe({
      labels: {
        method: req.method,
        route: req.routeOptions.url ?? "unmatched",
        status_code: String(reply.statusCode),
      },
      value: (performance.now() - req.started) / 1000,
      exemplarLabels: span ? { trace_id: span.traceId } : undefined,
    });
    app.log.info(
      {
        trace_id: span?.traceId ?? "",
        span_id: span?.spanId ?? "",
        user: req.user,
        method: req.method,
        route: req.routeOptions.url ?? "unmatched",
        path: req.url.split("?")[0],
        status: reply.statusCode,
        duration_ms: performance.now() - req.started,
        bytes: Number(reply.getHeader("content-length") ?? 0),
      },
      "request",
    );
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError)
      return reply.code(err.statusCode).send({
        error: err.message,
        ...(err.current ? { current: err.current } : {}),
      });
    if (err instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: "Validation failed", issues: err.issues });
    const e = z
      .object({ statusCode: z.number().optional() })
      .passthrough()
      .safeParse(err);
    if (e.success && e.data.statusCode && e.data.statusCode < 500)
      return reply
        .code(e.data.statusCode)
        .send({ error: err instanceof Error ? err.message : "Request failed" });
    app.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "Internal server error" });
  });
  function route(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ) {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        const out = await fn(req, reply);
        if (reply.sent || out === reply) return;
        return responseSchema(method, url).parse(
          jsonValue.parse(JSON.parse(JSON.stringify(out))),
        );
      },
    });
  }
  const params = (req: FastifyRequest) =>
    z.object({ id, child: id.optional() }).parse(req.params);
  const version = (req: FastifyRequest) =>
    z.object({ version: z.number().int().positive() }).strict().parse(req.body)
      .version;
  route("GET", "/healthz", async () => ({ status: "ok" }));
  route("GET", "/readyz", async () => {
    await pool.query("SELECT 1");
    return { status: "ready" };
  });
  route("GET", "/api/me", async (req) => ({
    ...(await pool.query("SELECT * FROM users WHERE username=$1", [req.user]))
      .rows[0],
    authPublicUrl: cfg.AUTH_PUBLIC_URL,
    homeUrl: cfg.HOME_URL,
    groups: String(
      cfg.AUTH_MODE === "dev"
        ? cfg.DEV_GROUPS
        : (req.headers["remote-groups"] ?? ""),
    )
      .split(",")
      .filter(Boolean),
  }));
  route("PATCH", "/api/me", async (req) => {
    const b = z.object({ timezone }).strict().parse(req.body);
    return (
      await pool.query(
        "UPDATE users SET timezone=$2 WHERE username=$1 RETURNING *",
        [req.user, b.timezone],
      )
    ).rows[0];
  });
  route("GET", "/api/projects", async (req) => store.visible(req.user));
  route("POST", "/api/projects", async (req, reply) => {
    const b = projectInput.parse(req.body);
    reply.code(201);
    return store.transaction(async (q) => {
      const p = projectRow.parse(
        (
          await q.query(
            "INSERT INTO projects(id,owner,data) VALUES($1,$2,$3) RETURNING *",
            [randomUUID(), req.user, b],
          )
        ).rows[0],
      );
      await store.event(q, p.id, req.user, "project.created", { project: p });
      return p;
    });
  });
  route("PATCH", "/api/projects/:id", async (req) => {
    const { id } = params(req);
    const b = projectPatch.parse(req.body);
    return store.transaction(async (q) => {
      await store.role(q, req.user, id, true);
      const p = projectRow.parse(
        (
          await q.query(
            "UPDATE projects SET data=data||$2::jsonb WHERE id=$1 RETURNING *",
            [id, b],
          )
        ).rows[0],
      );
      await store.event(q, id, req.user, "project.updated", { project: p });
      return p;
    });
  });
  route("DELETE", "/api/projects/:id", async (req) =>
    store.transaction(async (q) => {
      const { id } = params(req);
      await store.role(q, req.user, id, false, true);
      const p = projectRow.parse(
        (await q.query("SELECT * FROM projects WHERE id=$1", [id])).rows[0],
      );
      if (p.inbox) throw new ApiError(400, "Inbox cannot be deleted");
      const recipients = (
        await q.query(
          "SELECT username FROM members WHERE project_id=$1 UNION SELECT owner username FROM projects WHERE id=$1",
          [id],
        )
      ).rows;
      for (const u of recipients)
        await store.event(q, null, req.user, "resync", {}, u.username);
      await q.query("DELETE FROM projects WHERE id=$1", [id]);
      return { ok: true };
    }),
  );
  for (const entity of ["sections", "labels"]) {
    route(
      "GET",
      entity === "sections" ? "/api/projects/:id/sections" : "/api/labels",
      async (req) => {
        if (entity === "sections") {
          const { id } = params(req);
          await store.role(pool, req.user, id);
          return (
            await pool.query(
              "SELECT * FROM sections WHERE project_id=$1 ORDER BY (data->>'order')::float",
              [id],
            )
          ).rows;
        }
        return (
          await pool.query("SELECT * FROM labels WHERE owner=$1", [req.user])
        ).rows;
      },
    );
    route(
      "POST",
      entity === "sections" ? "/api/projects/:id/sections" : "/api/labels",
      async (req, reply) => {
        reply.code(201);
        const b = (entity === "sections" ? sectionInput : labelInput).parse(
          req.body,
        );
        return store.transaction(async (q) => {
          const owner = entity === "sections" ? params(req).id : req.user;
          if (entity === "sections") await store.role(q, req.user, owner, true);
          const r = (
            await q.query(
              `INSERT INTO ${entity}(id,${entity === "sections" ? "project_id" : "owner"},data) VALUES($1,$2,$3) RETURNING *`,
              [randomUUID(), owner, b],
            )
          ).rows[0];
          if (entity === "sections")
            await store.event(q, owner, req.user, "section.created", r);
          return r;
        });
      },
    );
    for (const method of ["PATCH", "DELETE"] satisfies ("PATCH" | "DELETE")[])
      route(method, `/api/${entity}/:id`, async (req) =>
        store.transaction(async (q) => {
          const { id } = params(req);
          const r = (
            await q.query(`SELECT * FROM ${entity} WHERE id=$1 FOR UPDATE`, [
              id,
            ])
          ).rows[0];
          if (!r) throw new ApiError(404, "Not found");
          if (entity === "sections")
            await store.role(q, req.user, r.project_id, true);
          else if (r.owner !== req.user) throw new ApiError(404, "Not found");
          if (entity === "sections")
            await store.event(q, r.project_id, req.user, "resync", {});
          else {
            await store.event(q, null, req.user, "resync", {}, req.user);
            const affected = await q.query(
              "SELECT DISTINCT project_id FROM tasks WHERE data->'labels' ? $1",
              [id],
            );
            for (const p of affected.rows)
              await store.event(q, p.project_id, req.user, "resync", {});
          }
          if (method === "DELETE") {
            if (entity === "sections")
              await q.query(
                `UPDATE tasks SET data=jsonb_set(data,'{sectionId}','null'),version=version+1 WHERE project_id=$1 AND data->>'sectionId'=$2`,
                [r.project_id, id],
              );
            else
              await q.query(
                `UPDATE tasks SET data=jsonb_set(data,'{labels}',(data->'labels')-$1),version=version+1 WHERE data->'labels' ? $1`,
                [id],
              );
            await q.query(`DELETE FROM ${entity} WHERE id=$1`, [id]);
            return { ok: true };
          }
          const b = (entity === "sections" ? sectionPatch : labelPatch).parse(
            req.body,
          );
          return (
            await q.query(
              `UPDATE ${entity} SET data=data||$2::jsonb WHERE id=$1 RETURNING *`,
              [id, b],
            )
          ).rows[0];
        }),
      );
  }
  route("POST", "/api/projects/:id/tasks", async (req, reply) => {
    const b = taskData.parse(taskInput.parse(req.body));
    reply.code(201);
    const t = await store.transaction((q) =>
      store.create(q, req.user, params(req).id, b),
    );
    m.created.inc();
    return t;
  });
  route("GET", "/api/tasks/:id", async (req) =>
    store.transaction((q) => store.task(q, req.user, params(req).id)),
  );
  route("PATCH", "/api/tasks/:id", async (req) => {
    const { version, projectId, ...patch } = taskPatch.parse(req.body);
    const result = await store.update(
      req.user,
      params(req).id,
      version,
      patch,
      projectId,
    );
    if (patch.completedAt) m.completed.inc();
    if (result.next) m.created.inc();
    return result;
  });
  for (const action of [
    "complete",
    "uncomplete",
    "delete",
    "restore",
    "duplicate",
  ])
    route("POST", `/api/tasks/:id/${action}`, async (req, reply) => {
      const v = version(req);
      if (action === "duplicate") {
        reply.code(201);
        return store.transaction(async (q) => {
          const t = await store.task(q, req.user, params(req).id, true);
          if (t.version !== v) throw new ApiError(409, "Stale task version", t);
          const copy = await store.create(q, req.user, t.project_id, {
            ...t.data,
            title: t.data.title + " (copy)",
            completedAt: null,
            deletedAt: null,
          });
          m.created.inc();
          return copy;
        });
      }
      const patch =
        action === "complete"
          ? { completedAt: new Date().toISOString() }
          : action === "uncomplete"
            ? { completedAt: null }
            : action === "delete"
              ? { deletedAt: new Date().toISOString() }
              : { deletedAt: null };
      const result = await store.update(req.user, params(req).id, v, patch);
      if (action === "complete") m.completed.inc();
      if (result.next) m.created.inc();
      return result;
    });
  route("GET", "/api/tasks", async (req) => {
    const f = z
      .object({
        view: z
          .enum([
            "inbox",
            "today",
            "upcoming",
            "overdue",
            "completed",
            "all",
            "deleted",
          ])
          .default("all"),
        project: id.optional(),
        label: id.optional(),
        priority: z.coerce.number().int().min(1).max(4).optional(),
        assignee: z.string().optional(),
        q: z.string().max(1000).optional(),
        sort: z
          .enum(["manual", "due", "priority", "created"])
          .default("manual"),
      })
      .strict()
      .parse(req.query);
    const profile = (
      await pool.query("SELECT timezone FROM users WHERE username=$1", [
        req.user,
      ])
    ).rows[0];
    const today = dayKey(new Date(), profile.timezone);
    const localToday = localParts(new Date(), profile.timezone);
    const endKey = dayKey(
      new Date(
        Date.UTC(localToday.year, localToday.month - 1, localToday.day + 7, 12),
      ),
      "UTC",
    );
    const rows = (
      await pool.query(
        `SELECT t.* FROM tasks t JOIN projects p ON p.id=t.project_id WHERE (p.owner=$1 OR EXISTS(SELECT 1 FROM members m WHERE m.project_id=p.id AND m.username=$1)) AND ($2::uuid IS NULL OR p.id=$2) AND ($3::text IS NULL OR t.data->'labels' ? $3) AND ($4::int IS NULL OR (t.data->>'priority')::int=$4) AND ($5::text IS NULL OR t.data->>'assignee'=$5) AND ($6::text IS NULL OR t.search @@ websearch_to_tsquery('simple',$6)) AND ($7!='inbox' OR p.inbox AND p.owner=$1)`,
        [
          req.user,
          f.project ?? null,
          f.label ?? null,
          f.priority ?? null,
          f.assignee ?? null,
          f.q ?? null,
          f.view,
        ],
      )
    ).rows
      .map((x) => taskRow.parse(x))
      .filter((t) => {
        if (f.view === "deleted") return !!t.data.deletedAt;
        if (t.data.deletedAt) return false;
        if (f.view === "completed") return !!t.data.completedAt;
        if (t.data.completedAt) return false;
        const day = t.data.due
          ? dayKey(new Date(t.data.due), profile.timezone)
          : null;
        if (f.view === "today") return !!day && day <= today;
        if (f.view === "overdue") return !!day && day < today;
        if (f.view === "upcoming") return !!day && day >= today && day < endKey;
        return true;
      });
    rows.sort((a, b) =>
      f.sort === "priority"
        ? a.data.priority - b.data.priority
        : f.sort === "created"
          ? a.created_at.getTime() - b.created_at.getTime()
          : f.sort === "due"
            ? (a.data.due ?? "9999").localeCompare(b.data.due ?? "9999")
            : a.data.order - b.data.order,
    );
    if (f.view === "upcoming") {
      const groups: Record<string, typeof rows> = {};
      for (const t of rows) {
        const key = dayKey(new Date(t.data.due ?? ""), profile.timezone);
        (groups[key] ??= []).push(t);
      }
      return { tasks: rows, groups };
    }
    return { tasks: rows };
  });
  route("GET", "/api/tasks/:id/comments", async (req) =>
    store.transaction(async (q) => {
      await store.task(q, req.user, params(req).id);
      return (
        await q.query(
          "SELECT * FROM comments WHERE task_id=$1 ORDER BY created_at",
          [params(req).id],
        )
      ).rows;
    }),
  );
  route("POST", "/api/tasks/:id/comments", async (req, reply) => {
    const b = z
      .object({ body: z.string().trim().min(1).max(50000) })
      .strict()
      .parse(req.body);
    reply.code(201);
    return store.transaction(async (q) => {
      const t = await store.task(q, req.user, params(req).id, true);
      const c = (
        await q.query(
          "INSERT INTO comments(id,task_id,author,body) VALUES($1,$2,$3,$4) RETURNING *",
          [randomUUID(), t.id, req.user, b.body],
        )
      ).rows[0];
      await store.event(q, t.project_id, req.user, "commented", {
        taskId: t.id,
        comment: c,
      });
      return c;
    });
  });
  route("GET", "/api/projects/:id/members", async (req) =>
    store.transaction(async (q) => {
      const p = await store.role(q, req.user, params(req).id);
      return {
        owner: p.owner,
        members: (
          await q.query(
            "SELECT username,role FROM members WHERE project_id=$1",
            [params(req).id],
          )
        ).rows,
      };
    }),
  );
  route("POST", "/api/projects/:id/members", async (req) => {
    const b = z
      .object({
        username: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
        role: z.enum(["editor", "viewer"]),
      })
      .strict()
      .parse(req.body);
    return store.transaction(async (q) => {
      const { id } = params(req);
      const p = await store.role(q, req.user, id, false, true);
      if (p.owner === b.username)
        throw new ApiError(400, "Owner cannot be a member");
      await q.query(
        "INSERT INTO users(username) VALUES($1) ON CONFLICT DO NOTHING",
        [b.username],
      );
      await q.query(
        "INSERT INTO members VALUES($1,$2,$3) ON CONFLICT(project_id,username) DO UPDATE SET role=excluded.role",
        [id, b.username, b.role],
      );
      await store.event(q, id, req.user, "shared", b);
      return b;
    });
  });
  route("POST", "/api/projects/:id/remove-member", async (req) => {
    const b = z.object({ username: z.string() }).strict().parse(req.body);
    return store.transaction(async (q) => {
      const { id } = params(req);
      await store.role(q, req.user, id, false, true);
      await q.query("DELETE FROM members WHERE project_id=$1 AND username=$2", [
        id,
        b.username,
      ]);
      await store.event(q, null, req.user, "resync", {}, b.username);
      await store.event(q, id, req.user, "member.removed", b);
      return { ok: true };
    });
  });
  route("POST", "/api/projects/:id/leave", async (req) =>
    store.transaction(async (q) => {
      const { id } = params(req);
      const p = await store.role(q, req.user, id);
      if (p.owner === req.user)
        throw new ApiError(400, "Transfer ownership before leaving");
      await q.query("DELETE FROM members WHERE project_id=$1 AND username=$2", [
        id,
        req.user,
      ]);
      await store.event(q, null, req.user, "resync", {}, req.user);
      await store.event(q, id, req.user, "member.left", {});
      return { ok: true };
    }),
  );
  route("POST", "/api/projects/:id/transfer", async (req) => {
    const b = z.object({ username: z.string() }).strict().parse(req.body);
    return store.transaction(async (q) => {
      const { id } = params(req);
      await store.role(q, req.user, id, false, true);
      const p = projectRow.parse(
        (await q.query("SELECT * FROM projects WHERE id=$1", [id])).rows[0],
      );
      if (p.inbox) throw new ApiError(400, "Inbox cannot be transferred");
      if (
        !(
          await q.query(
            "SELECT 1 FROM members WHERE project_id=$1 AND username=$2",
            [id, b.username],
          )
        ).rowCount
      )
        throw new ApiError(400, "New owner must be a member");
      await q.query("DELETE FROM members WHERE project_id=$1 AND username=$2", [
        id,
        b.username,
      ]);
      await q.query("UPDATE projects SET owner=$2 WHERE id=$1", [
        id,
        b.username,
      ]);
      await q.query("INSERT INTO members VALUES($1,$2,'editor')", [
        id,
        req.user,
      ]);
      await store.event(q, id, req.user, "ownership.transferred", b);
      return { ok: true };
    });
  });
  route("GET", "/api/projects/:id/activity", async (req) =>
    store.transaction(async (q) => {
      await store.role(q, req.user, params(req).id);
      return (
        await q.query(
          "SELECT * FROM events WHERE project_id=$1 AND (recipient IS NULL OR recipient=$2) ORDER BY id DESC LIMIT 500",
          [params(req).id, req.user],
        )
      ).rows;
    }),
  );
  route("POST", "/api/quick-add/parse", async (req) => {
    const b = z
      .object({
        text: z.string().min(1).max(2000),
        now: z.iso.datetime().optional(),
        timezone: timezone.optional(),
      })
      .strict()
      .parse(req.body);
    const p = (
      await pool.query("SELECT timezone FROM users WHERE username=$1", [
        req.user,
      ])
    ).rows[0];
    return parseQuickAdd(b.text, {
      now: b.now ? new Date(b.now) : undefined,
      timezone: b.timezone ?? p.timezone,
    });
  });
  route("POST", "/api/quick-add", async (req, reply) => {
    const b = z
      .object({ text: z.string().min(1).max(2000), projectId: id.optional() })
      .strict()
      .parse(req.body);
    const profile = (
      await pool.query("SELECT timezone FROM users WHERE username=$1", [
        req.user,
      ])
    ).rows[0];
    const parsed = parseQuickAdd(b.text, { timezone: profile.timezone });
    const projects = await store.visible(req.user);
    const project = b.projectId
      ? projects.find((p) => p.id === b.projectId)
      : parsed.project
        ? projects.find(
            (p) => p.data.name.toLowerCase() === parsed.project?.toLowerCase(),
          )
        : projects.find((p) => p.inbox && p.owner === req.user);
    if (!project) throw new ApiError(400, "Project not found");
    const labels: string[] = [];
    for (const name of parsed.labels) {
      const l = (
        await pool.query(
          "SELECT id FROM labels WHERE owner=$1 AND lower(data->>'name')=lower($2)",
          [req.user, name],
        )
      ).rows[0];
      if (l) labels.push(l.id);
      else {
        const lid = randomUUID();
        await pool.query("INSERT INTO labels VALUES($1,$2,$3)", [
          lid,
          req.user,
          { name, color: "#6366f1" },
        ]);
        labels.push(lid);
      }
    }
    const { project: _project, ...fields } = parsed;
    void _project;
    const data = taskData.parse({ ...fields, labels });
    reply.code(201);
    const result = await store.transaction((q) =>
      store.create(q, req.user, project.id, data),
    );
    m.created.inc();
    return result;
  });
  async function exportData(user: string) {
    return store.transaction(async (q) => {
      await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const projects = (
        await q.query("SELECT * FROM projects WHERE owner=$1", [user])
      ).rows;
      const ids = projects.map((p) => p.id);
      return exportSchema.parse({
        format: 1,
        timezone: (
          await q.query("SELECT timezone FROM users WHERE username=$1", [user])
        ).rows[0].timezone,
        projects,
        members: (
          await q.query(
            "SELECT * FROM members WHERE project_id=ANY($1::uuid[])",
            [ids],
          )
        ).rows,
        sections: (
          await q.query(
            "SELECT * FROM sections WHERE project_id=ANY($1::uuid[])",
            [ids],
          )
        ).rows,
        labels: (await q.query("SELECT * FROM labels WHERE owner=$1", [user]))
          .rows,
        tasks: (
          await q.query(
            "SELECT * FROM tasks WHERE project_id=ANY($1::uuid[])",
            [ids],
          )
        ).rows,
        comments: (
          await q.query(
            "SELECT c.* FROM comments c JOIN tasks t ON t.id=c.task_id WHERE t.project_id=ANY($1::uuid[])",
            [ids],
          )
        ).rows,
      });
    });
  }
  route("GET", "/api/export", async (req, reply) => {
    const query = z
      .object({ format: z.enum(["json", "csv"]).default("json") })
      .parse(req.query);
    const data = await exportData(req.user);
    reply.header(
      "Content-Disposition",
      `attachment; filename="todo.${query.format}"`,
    );
    if (query.format === "json") return data;
    const escape = (s: unknown) =>
      '"' + String(s ?? "").replace(/"/g, '""') + '"';
    return reply
      .type("text/csv")
      .send(
        [
          "id,project,title,description,due,priority,completedAt",
          ...data.tasks.map((t) =>
            [
              t.id,
              t.project_id,
              t.data.title,
              t.data.description,
              t.data.due,
              t.data.priority,
              t.data.completedAt,
            ]
              .map(escape)
              .join(","),
          ),
        ].join("\r\n"),
      );
  });
  route("POST", "/api/import", async (req, reply) => {
    const b = exportSchema.parse(req.body);
    reply.code(201);
    return store.transaction(async (q) => {
      const all = [
        ...b.projects,
        ...b.sections,
        ...b.labels,
        ...b.tasks,
        ...b.comments,
      ];
      if (new Set(all.map((x) => x.id)).size !== all.length)
        throw new ApiError(400, "Duplicate import ID");
      const projectIds = new Set(b.projects.map((x) => x.id));
      const taskIds = new Set(b.tasks.map((x) => x.id));
      if (
        b.members.some((x) => !projectIds.has(x.project_id)) ||
        b.sections.some((x) => !projectIds.has(x.project_id)) ||
        b.tasks.some((x) => !projectIds.has(x.project_id)) ||
        b.comments.some((x) => !taskIds.has(x.task_id))
      )
        throw new ApiError(400, "Dangling import reference");
      const map = new Map<string, string>();
      for (const p of b.projects)
        map.set(
          p.id,
          p.inbox
            ? (
                await q.query(
                  "SELECT id FROM projects WHERE owner=$1 AND inbox",
                  [req.user],
                )
              ).rows[0].id
            : randomUUID(),
        );
      for (const s of [...b.sections, ...b.labels, ...b.tasks, ...b.comments]) {
        if (map.has(s.id)) throw new ApiError(400, "Duplicate import ID");
        map.set(s.id, randomUUID());
      }
      const mapped = (value: string) => {
        const v = map.get(value);
        if (!v) throw new ApiError(400, "Dangling import reference");
        return v;
      };
      for (const p of b.projects)
        if (!p.inbox)
          await q.query(
            "INSERT INTO projects(id,owner,data) VALUES($1,$2,$3)",
            [mapped(p.id), req.user, p.data],
          );
      for (const member of b.members) {
        await q.query(
          "INSERT INTO users(username) VALUES($1) ON CONFLICT DO NOTHING",
          [member.username],
        );
        if (member.username !== req.user)
          await q.query(
            "INSERT INTO members VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [mapped(member.project_id), member.username, member.role],
          );
      }
      for (const l of b.labels)
        await q.query("INSERT INTO labels VALUES($1,$2,$3)", [
          mapped(l.id),
          req.user,
          l.data,
        ]);
      for (const s of b.sections)
        await q.query("INSERT INTO sections VALUES($1,$2,$3)", [
          mapped(s.id),
          mapped(s.project_id),
          s.data,
        ]);
      for (const t of b.tasks) {
        const data = {
          ...t.data,
          sectionId: t.data.sectionId ? mapped(t.data.sectionId) : null,
          parentId: t.data.parentId ? mapped(t.data.parentId) : null,
          labels: t.data.labels.filter((l) => map.has(l)).map(mapped),
          assignee:
            t.data.assignee ===
            b.projects.find((p) => p.id === t.project_id)?.owner
              ? req.user
              : t.data.assignee,
        };
        await q.query(
          "INSERT INTO tasks(id,project_id,data,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)",
          [
            mapped(t.id),
            mapped(t.project_id),
            data,
            t.version,
            t.created_at,
            t.updated_at,
          ],
        );
      }
      // Validate after insertion so forward parent references work, while cycles,
      // cross-project references and invalid assignees roll back the whole import.
      for (const t of b.tasks) {
        const row = taskRow.parse(
          (await q.query("SELECT * FROM tasks WHERE id=$1", [mapped(t.id)]))
            .rows[0],
        );
        await store.validateTask(q, req.user, row.project_id, row.data, row.id);
      }
      for (const c of b.comments) {
        await q.query(
          "INSERT INTO users(username) VALUES($1) ON CONFLICT DO NOTHING",
          [c.author],
        );
        await q.query("INSERT INTO comments VALUES($1,$2,$3,$4,$5)", [
          mapped(c.id),
          mapped(c.task_id),
          c.author,
          c.body,
          c.created_at,
        ]);
      }
      await q.query("UPDATE users SET timezone=$2 WHERE username=$1", [
        req.user,
        b.timezone,
      ]);
      for (const p of b.projects)
        await store.event(q, mapped(p.id), req.user, "imported", {});
      return {
        ok: true,
        projects: b.projects.length,
        tasks: b.tasks.length,
        idMap: Object.fromEntries(map),
      };
    });
  });
  const streams = new Set<() => void>();
  const listener = await pool.connect();
  await listener.query("LISTEN todo_events");
  const wake = new Set<() => void>();
  listener.on("notification", () => {
    for (const fn of wake) fn();
  });
  listener.on("error", (err) =>
    app.log.error(
      { err },
      "Postgres LISTEN failed; periodic SSE resync remains active",
    ),
  );
  app.get("/api/events", async (req, reply) => {
    const last = z
      .string()
      .regex(/^\d+$/)
      .parse(
        req.headers["last-event-id"] ??
          String(
            (await pool.query("SELECT coalesce(max(id),0) id FROM events"))
              .rows[0].id,
          ),
      );
    app.log.info(
      { user: req.user, path: "/api/events", trace_id: "", span_id: "" },
      "stream connected",
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Security-Policy": "default-src 'none'",
    });
    m.live.inc();
    let cursor = last;
    let busy = false;
    let ended = false;
    const send = async () => {
      if (busy || ended) return;
      busy = true;
      try {
        const events = await store.events(req.user, cursor);
        for (const e of events) {
          if (ended) break;
          cursor = String(e.id);
          app.log.info(
            {
              user: req.user,
              event_id: cursor,
              kind: e.kind,
              project_id: e.project_id,
              trace_id: "",
              span_id: "",
            },
            "stream event",
          );
          if (reply.raw.writableLength > 1024 * 1024) {
            reply.raw.write("event: resync\ndata: {}\n\n");
            close();
            break;
          }
          reply.raw.write(
            `id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify({ id: String(e.id), projectId: e.project_id, actor: e.actor, data: e.data, time: e.created_at })}\n\n`,
          );
        }
      } catch (err) {
        app.log.error({ err }, "stream failed");
        close();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      if (!ended) reply.raw.write(": heartbeat\n\n");
      void send();
    }, 1000);
    const close = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      wake.delete(trigger);
      streams.delete(close);
      m.live.dec();
      // A hijacked reply skips onResponse, so the stream ends its own active request.
      m.active.dec();
      reply.raw.end();
    };
    const trigger = () => {
      void send();
    };
    wake.add(trigger);
    streams.add(close);
    req.raw.on("close", close);
    reply.raw.write(
      `${req.headers["last-event-id"] === undefined ? `id: ${cursor}\n` : ""}event: resync\ndata: {}\n\n`,
    );
    await send();
  });
  const webRoot = resolve(cfg.WEB_ROOT);
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.method !== "GET")
        return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  let ticking = false;
  const reminders = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void store
      .reminders()
      .catch((err) => app.log.error({ err }, "reminder poll failed"))
      .finally(() => {
        ticking = false;
      });
  }, 250);
  const metricServer = createServer(async (req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const [open, projects] = await Promise.all([
        pool.query(
          "SELECT count(*)::int n FROM tasks WHERE data->>'completedAt' IS NULL AND data->>'deletedAt' IS NULL",
        ),
        pool.query("SELECT count(*)::int n FROM projects"),
      ]);
      m.open.set(open.rows[0].n);
      m.projects.set(projects.rows[0].n);
      res.setHeader("Content-Type", m.registry.contentType);
      res.end(await m.registry.metrics());
    } catch {
      res.writeHead(503);
      res.end();
    }
  });
  app.addHook("preClose", async () => {
    for (const close of streams) close();
  });
  app.addHook("onClose", async () => {
    clearInterval(reminders);
    await new Promise<void>((r) => {
      if (metricServer.listening) metricServer.close(() => r());
      else r();
    });
    listener.release();
    await pool.end();
    m.registry.clear();
  });
  return { app, store, pool, metrics: m, metricServer };
}
