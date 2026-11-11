import { beforeAll, afterAll, it, expect, vi } from "vitest";
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
it("writes a user's identity once per minute unless it changes", async () => {
  const identity = vi.spyOn(a.store, "identity");
  const me = async (name: string) =>
    (
      await a.app.inject({
        url: "/api/me",
        headers: { "remote-user": "carol", "remote-name": name },
      })
    ).json();
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 3; i++) expect((await me("Carol")).name).toBe("Carol");
    expect(identity).toHaveBeenCalledTimes(1);
    expect((await me("Carol R")).name).toBe("Carol R");
    expect(identity).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 61_000);
    await me("Carol R");
    expect(identity).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    identity.mockRestore();
  }
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
it("lists caller roles and member counts without separate membership requests", async () => {
  const p = (await call("POST", "/api/projects", { name: "metadata" })).body.id;
  await call("POST", `/api/projects/${p}/members`, {
    username: "bob",
    role: "editor",
  });
  for (const [user, role] of [
    ["alice", "owner"],
    ["bob", "editor"],
  ]) {
    const projects = (await call("GET", "/api/projects", undefined, user)).body;
    expect(projects.find((x: { id: string }) => x.id === p)).toMatchObject({
      role,
      memberCount: 2,
    });
  }
});
it("rejects imported cross-project sections and cyclic parents transactionally", async () => {
  const data = (await call("GET", "/api/export")).body;
  const p = (await call("POST", "/api/projects", { name: "import refs" })).body;
  const s = (
    await call("POST", `/api/projects/${p.id}/sections`, { name: "section" })
  ).body;
  const t = (
    await call("POST", `/api/projects/${p.id}/tasks`, { title: "reference" })
  ).body;
  const input = {
    ...data,
    projects: [...data.projects, p],
    sections: [...data.sections, s],
    tasks: [
      ...data.tasks,
      {
        ...t,
        project_id: data.projects[0].id,
        data: { ...t.data, sectionId: s.id },
      },
    ],
  };
  const before = (await call("GET", "/api/projects")).body.length;
  expect((await call("POST", "/api/import", input)).status).toBe(400);
  expect((await call("GET", "/api/projects")).body).toHaveLength(before);
  input.tasks[input.tasks.length - 1].data.sectionId = null;
  input.tasks[input.tasks.length - 1].data.parentId = t.id;
  expect((await call("POST", "/api/import", input)).status).toBe(400);
});
it("new streams checkpoint current history while reconnects replay from the supplied cursor", async () => {
  const address = a.app.server.listening
    ? `http://127.0.0.1:${(a.app.server.address() as { port: number }).port}`
    : await a.app.listen({ host: "127.0.0.1", port: 0 });
  const p = (await call("POST", "/api/projects", { name: "checkpoint" })).body
    .id;
  const t = (
    await call("POST", `/api/projects/${p}/tasks`, { title: "historical" })
  ).body;
  const max = String(
    (await a.pool.query("SELECT max(id) id FROM events")).rows[0].id,
  );
  const ctrl = new AbortController();
  const r = await fetch(address + "/api/events", {
    headers: headers(),
    signal: ctrl.signal,
  });
  const reader = r.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  expect(first).toContain(`id: ${max}\nevent: resync`);
  expect(first).not.toContain("historical");
  await call("PATCH", `/api/tasks/${t.id}`, { version: 1, title: "replayed" });
  const reconnect = new AbortController();
  const res = await fetch(address + "/api/events", {
    headers: { ...headers(), "Last-Event-ID": max },
    signal: reconnect.signal,
  });
  const replayReader = res.body!.getReader();
  let text = "";
  const timeout = setTimeout(() => reconnect.abort(), 5000);
  try {
    while (!text.includes("replayed")) {
      const chunk = await replayReader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
  } finally {
    clearTimeout(timeout);
    reconnect.abort();
  }
  expect(text).toContain("replayed");
});
it("counts a live stream as an active request only while it is open", async () => {
  const address = a.app.server.listening
    ? `http://127.0.0.1:${(a.app.server.address() as { port: number }).port}`
    : await a.app.listen({ host: "127.0.0.1", port: 0 });
  const active = async () =>
    (await a.metrics.active.get()).values[0]?.value ?? 0;
  const settle = async (want: number) => {
    for (let i = 0; i < 100 && (await active()) !== want; i++)
      await new Promise((r) => setTimeout(r, 20));
    return active();
  };
  // Every stream the earlier tests opened has been aborted, so none may still count.
  expect(await settle(0)).toBe(0);
  const ctrl = new AbortController();
  const r = await fetch(address + "/api/events", {
    headers: headers(),
    signal: ctrl.signal,
  });
  await r.body!.getReader().read();
  expect(await active()).toBe(1);
  ctrl.abort();
  expect(await settle(0)).toBe(0);
});
it("delivers a notification that arrives while the stream is reading", async () => {
  const address = b.app.server.listening
    ? `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}`
    : await b.app.listen({ host: "127.0.0.1", port: 0 });
  const p = (await call("POST", "/api/projects", { name: "busy read" })).body
    .id;
  const events = b.store.events.bind(b.store);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // The stream's first read finishes its query, then stalls until released.
  const spy = vi
    .spyOn(b.store, "events")
    .mockImplementationOnce(async (user, after) => {
      const rows = await events(user, after);
      await gate;
      return rows;
    });
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  let text = "";
  try {
    const r = await fetch(address + "/api/events", {
      headers: headers(),
      signal: ctrl.signal,
    });
    const reader = r.body!.getReader();
    await call("POST", `/api/projects/${p}/tasks`, { title: "during read" });
    await new Promise((r) => setTimeout(r, 300));
    release();
    while (!text.includes("during read")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
  } catch {
    // An abort means the event did not arrive within 5 s.
  } finally {
    clearTimeout(timeout);
    ctrl.abort();
    spy.mockRestore();
  }
  expect(text).toContain("during read");
});
