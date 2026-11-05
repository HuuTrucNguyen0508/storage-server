import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
let a: Awaited<ReturnType<typeof buildApp>>, b: typeof a;
const headers = (user = "alice") => ({
  "remote-user": user,
  "x-requested-with": "fetch",
});
async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  user = "alice",
  app = a,
) {
  const r = await app.app.inject({
    method,
    url,
    headers: headers(user),
    ...(payload ? { payload } : {}),
  });
  return { status: r.statusCode, body: r.json() };
}
let project: string, task: string;
let version = 1;
beforeAll(async () => {
  a = await buildApp(process.env);
  b = await buildApp(process.env);
});
afterAll(async () => {
  await Promise.all([a.app.close(), b.app.close()]);
});
it("requires identity, CSRF header and same origin", async () => {
  expect((await a.app.inject("/api/me")).statusCode).toBe(401);
  expect(
    (
      await a.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "x" },
        headers: { "remote-user": "alice" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await a.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "x" },
        headers: { ...headers(), origin: "https://pdf.lab.localhost" },
      })
    ).statusCode,
  ).toBe(403);
});
it("health and profile and projects", async () => {
  expect((await call("GET", "/healthz")).status).toBe(200);
  expect((await call("GET", "/readyz")).status).toBe(200);
  expect(
    (await call("PATCH", "/api/me", { timezone: "Europe/Paris" })).body
      .timezone,
  ).toBe("Europe/Paris");
  const r = await call("POST", "/api/projects", { name: "Home" });
  expect(r.status).toBe(201);
  project = r.body.id;
  expect(
    (
      await call("PATCH", `/api/projects/${project}`, {
        color: "#fff",
        order: 2,
        emoji: "x",
        archived: true,
      })
    ).status,
  ).toBe(200);
});
it("creates sections labels tasks and nested subtasks", async () => {
  const section = (
    await call("POST", `/api/projects/${project}/sections`, { name: "Work" })
  ).body;
  expect(
    (await call("PATCH", `/api/sections/${section.id}`, { order: 2 })).status,
  ).toBe(200);
  expect(
    (await call("GET", `/api/projects/${project}/sections`)).body,
  ).toHaveLength(1);
  const label = (await call("POST", "/api/labels", { name: "Bills" })).body;
  expect(
    (await call("PATCH", `/api/labels/${label.id}`, { color: "#fff" })).status,
  ).toBe(200);
  expect((await call("GET", "/api/labels")).body).toHaveLength(1);
  const r = await call("POST", `/api/projects/${project}/tasks`, {
    title: "Pay searchable rent",
    description: "Markdown needle",
    due: new Date().toISOString(),
    sectionId: section.id,
    labels: [label.id],
    recurrence: { kind: "days" },
  });
  expect(r.status).toBe(201);
  task = r.body.id;
  const child = (
    await call("POST", `/api/projects/${project}/tasks`, {
      title: "child",
      parentId: task,
    })
  ).body;
  expect(
    (
      await call("POST", `/api/projects/${project}/tasks`, {
        title: "grandchild",
        parentId: child.id,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call("PATCH", `/api/tasks/${task}`, {
        version: 1,
        parentId: child.id,
      })
    ).status,
  ).toBe(400);
  expect((await call("DELETE", `/api/sections/${section.id}`)).status).toBe(
    200,
  );
  version++;
  expect((await call("DELETE", `/api/labels/${label.id}`)).status).toBe(200);
  version++;
});
it("isolates all private resources", async () => {
  expect(
    (await call("GET", `/api/tasks/${task}`, undefined, "bob")).status,
  ).toBe(404);
  expect(
    (
      await call(
        "PATCH",
        `/api/tasks/${task}`,
        { version, title: "stolen" },
        "bob",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await call(
        "POST",
        `/api/projects/${project}/tasks`,
        { title: "x" },
        "bob",
      )
    ).status,
  ).toBe(404);
  expect(
    (await call("GET", `/api/tasks/${task}/comments`, undefined, "bob")).status,
  ).toBe(404);
  expect((await call("GET", "/api/labels", undefined, "bob")).body).toEqual([]);
  expect(await b.store.events("bob", "0")).toEqual([]);
});
it("filters today upcoming overdue completed and search", async () => {
  for (const view of ["today", "upcoming", "all"])
    expect(
      (await call("GET", `/api/tasks?view=${view}&q=needle`)).body.tasks.some(
        (t: { id: string }) => t.id === task,
      ),
    ).toBe(true);
  expect((await call("GET", "/api/tasks?view=overdue")).status).toBe(200);
});
it("conflicts, completes recurring tasks and uncompletes", async () => {
  expect(
    (await call("PATCH", `/api/tasks/${task}`, { version: 1, title: "wrong" }))
      .status,
  ).toBe(409);
  const c = await call("POST", `/api/tasks/${task}/complete`, { version });
  expect(c.status).toBe(200);
  expect(c.body.next.data.due).not.toBe(c.body.task.data.due);
  version = c.body.task.version;
  expect(
    (await call("GET", "/api/tasks?view=completed")).body.tasks,
  ).toHaveLength(1);
  const u = await call("POST", `/api/tasks/${task}/uncomplete`, { version });
  version = u.body.task.version;
  expect(u.status).toBe(200);
});
it("comments, activity, duplicate, delete and restore", async () => {
  expect(
    (await call("POST", `/api/tasks/${task}/comments`, { body: "hello" }))
      .status,
  ).toBe(201);
  expect((await call("GET", `/api/tasks/${task}/comments`)).body).toHaveLength(
    1,
  );
  expect(
    (await call("GET", `/api/projects/${project}/activity`)).body.length,
  ).toBeGreaterThan(0);
  expect(
    (await call("POST", `/api/tasks/${task}/duplicate`, { version })).status,
  ).toBe(201);
  const d = await call("POST", `/api/tasks/${task}/delete`, { version });
  version = d.body.task.version;
  expect(
    (await call("GET", "/api/tasks?view=deleted")).body.tasks,
  ).toHaveLength(1);
  const r = await call("POST", `/api/tasks/${task}/restore`, { version });
  version = r.body.task.version;
  expect(r.status).toBe(200);
});
it("shares with placeholder viewers and rejects writes then promotes editor", async () => {
  expect(
    (
      await call("POST", `/api/projects/${project}/members`, {
        username: "friend",
        role: "viewer",
      })
    ).status,
  ).toBe(200);
  expect(
    (await call("GET", `/api/tasks/${task}`, undefined, "friend")).status,
  ).toBe(200);
  expect(
    (
      await call(
        "POST",
        `/api/tasks/${task}/comments`,
        { body: "no" },
        "friend",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        "PATCH",
        `/api/tasks/${task}`,
        { version, title: "no" },
        "friend",
      )
    ).status,
  ).toBe(403);
  expect(
    (await call("GET", `/api/projects/${project}/members`)).body.members,
  ).toHaveLength(1);
  await call("POST", `/api/projects/${project}/members`, {
    username: "friend",
    role: "editor",
  });
  expect(
    (
      await call(
        "POST",
        `/api/tasks/${task}/comments`,
        { body: "yes" },
        "friend",
      )
    ).status,
  ).toBe(201);
  expect(
    (await call("POST", `/api/projects/${project}/leave`, {}, "friend")).status,
  ).toBe(200);
  expect(
    (await b.store.events("friend", "0")).every(
      (e) => e.project_id === null && e.kind === "resync",
    ),
  ).toBe(true);
});
it("quick add creates labels and parses without mutation", async () => {
  expect(
    (
      await call("POST", "/api/quick-add/parse", {
        text: "Pay rent tomorrow 9am p1 #Home @bills every month",
      })
    ).body.priority,
  ).toBe(1);
  expect(
    (
      await call("POST", "/api/quick-add", {
        text: "Pay rent today p1 #Home @bills every month",
      })
    ).status,
  ).toBe(201);
});
it("claims reminders once across replicas", async () => {
  const t = (
    await call("POST", `/api/projects/${project}/tasks`, {
      title: "remind",
      reminderAt: new Date(Date.now() - 1000).toISOString(),
    })
  ).body;
  await Promise.all([a.store.reminders(), b.store.reminders()]);
  const events = await a.pool.query(
    "SELECT * FROM events WHERE kind='reminder' AND data->>'taskId'=$1",
    [t.id],
  );
  expect(events.rowCount).toBe(1);
});
it("exports and imports owned data and CSV", async () => {
  const data = (await call("GET", "/api/export")).body;
  const r = await call("POST", "/api/import", data, "bob");
  expect(r.status).toBe(201);
  expect(r.body.tasks).toBe(data.tasks.length);
  const exported = (await call("GET", "/api/export", undefined, "bob")).body;
  expect(
    exported.tasks.map((t: { data: { title: string } }) => t.data.title).sort(),
  ).toEqual(
    data.tasks.map((t: { data: { title: string } }) => t.data.title).sort(),
  );
  expect(
    (await a.app.inject({ url: "/api/export?format=csv", headers: headers() }))
      .headers["content-type"],
  ).toContain("text/csv");
});
it("transfers ownership removes members deletes project and protects Inbox", async () => {
  await call("POST", `/api/projects/${project}/members`, {
    username: "bob",
    role: "editor",
  });
  expect(
    (
      await call("POST", `/api/projects/${project}/transfer`, {
        username: "bob",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        "POST",
        `/api/projects/${project}/remove-member`,
        { username: "alice" },
        "bob",
      )
    ).status,
  ).toBe(200);
  expect((await call("GET", `/api/tasks/${task}`)).status).toBe(404);
  expect(
    (await call("DELETE", `/api/projects/${project}`, undefined, "bob")).status,
  ).toBe(200);
  const inbox = (await call("GET", "/api/projects")).body.find(
    (p: { inbox: boolean }) => p.inbox,
  );
  expect((await call("DELETE", `/api/projects/${inbox.id}`)).status).toBe(400);
});
it("delivers SSE between replicas and revokes project delivery on removal", async () => {
  const project = (
    await call("POST", "/api/projects", { name: "stream project" })
  ).body.id;
  await call("POST", `/api/projects/${project}/members`, {
    username: "bob",
    role: "editor",
  });
  const address = await b.app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(address + "/api/events", {
    headers: headers("bob"),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let text = "";
  let found = false;
  const token = "stream-" + Date.now();
  await call("POST", `/api/projects/${project}/tasks`, { title: token });
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    while (!found) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
      found = text.includes(token);
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  expect(found).toBe(true);
  await call("POST", `/api/projects/${project}/remove-member`, {
    username: "bob",
  });
  const events = await b.store.events("bob", "0");
  expect(events.some((e) => e.project_id === project)).toBe(false);
});
it("moves tasks between projects with version checks and rejects private references", async () => {
  const p = (await call("POST", "/api/projects", { name: "move source" })).body
    .id;
  const destination = (
    await call("POST", "/api/projects", { name: "move destination" })
  ).body.id;
  const s = (
    await call("POST", `/api/projects/${p}/sections`, {
      name: "source section",
    })
  ).body.id;
  const t = (
    await call("POST", `/api/projects/${p}/tasks`, {
      title: "move me",
      sectionId: s,
    })
  ).body;
  expect(
    (
      await call("PATCH", `/api/tasks/${t.id}`, {
        version: 1,
        projectId: destination,
      })
    ).status,
  ).toBe(400);
  const moved = await call("PATCH", `/api/tasks/${t.id}`, {
    version: 1,
    projectId: destination,
    sectionId: null,
  });
  expect(moved.status).toBe(200);
  expect(moved.body.task.project_id).toBe(destination);
  const privateLabel = (
    await call("POST", "/api/labels", { name: "private" }, "bob")
  ).body.id;
  expect(
    (
      await call("PATCH", `/api/tasks/${t.id}`, {
        version: 2,
        labels: [privateLabel],
      })
    ).status,
  ).toBe(400);
  expect(
    (await call("PATCH", `/api/labels/${privateLabel}`, { color: "red" }))
      .status,
  ).toBe(404);
  expect(
    (
      await call("POST", `/api/projects/${destination}/tasks`, {
        title: "bad",
        assignee: "stranger",
      })
    ).status,
  ).toBe(400);
});
it("replays authorized event IDs after reconnect across replicas", async () => {
  const p = (await call("POST", "/api/projects", { name: "replay" })).body.id;
  await call("POST", `/api/projects/${p}/members`, {
    username: "bob",
    role: "editor",
  });
  const cursor = String(
    (await a.pool.query("SELECT max(id) id FROM events")).rows[0].id,
  );
  await call("POST", `/api/projects/${p}/tasks`, { title: "after cursor" });
  const events = await b.store.events("bob", cursor);
  expect(events).toHaveLength(1);
  expect(events[0].data.task.data.title).toBe("after cursor");
  expect(await a.store.events("unrelated", cursor)).toEqual([]);
});
it("partial edits preserve unrelated fields including recurrence and due date", async () => {
  const p = (
    await call("POST", "/api/projects", {
      name: "preserve",
      color: "#123456",
      emoji: "star",
      order: 17,
    })
  ).body;
  const renamed = (
    await call("PATCH", `/api/projects/${p.id}`, { name: "renamed" })
  ).body;
  expect(renamed.data).toMatchObject({
    color: "#123456",
    emoji: "star",
    order: 17,
  });
  const t = (
    await call("POST", `/api/projects/${p.id}/tasks`, {
      title: "before",
      description: "keep me",
      due: "2030-01-01T09:00:00Z",
      priority: 1,
      recurrence: { kind: "days" },
    })
  ).body;
  const updated = (
    await call("PATCH", `/api/tasks/${t.id}`, { version: 1, title: "after" })
  ).body.task;
  expect(updated.data).toMatchObject({
    description: "keep me",
    due: t.data.due,
    priority: 1,
    recurrence: t.data.recurrence,
  });
});
it("editors can preserve another users labels on shared tasks", async () => {
  const p = (await call("POST", "/api/projects", { name: "shared labels" }))
    .body.id;
  const l = (await call("POST", "/api/labels", { name: "alice label" })).body
    .id;
  const t = (
    await call("POST", `/api/projects/${p}/tasks`, {
      title: "shared",
      labels: [l],
    })
  ).body;
  await call("POST", `/api/projects/${p}/members`, {
    username: "bob",
    role: "editor",
  });
  const changed = await call(
    "PATCH",
    `/api/tasks/${t.id}`,
    { version: 1, title: "edited by bob" },
    "bob",
  );
  expect(changed.status).toBe(200);
  expect(changed.body.task.data.labels).toEqual([l]);
});
