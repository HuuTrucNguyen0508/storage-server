// Todo journey: create a project, quick-add tasks with inline syntax, list Today and
// Upcoming, search, edit, complete, comment, hold the live event stream open for a moment,
// then delete the project.
import { get, post, patch, del, verify } from "../lib/http.js";
import { json, think, uniq } from "../lib/util.js";
import { itemName, labelName, sweepable } from "../lib/names.js";

const APP = "todo";
const LABEL = labelName(); // one personal label per VU (quick-add creates it); teardown removes it

function liveStream() {
  // The stream never ends, so read it for one second. k6 reports the timeout as status 0
  // and still hands over what arrived (the first event is `resync`), so 0 is the expected
  // status here and the check looks at the body.
  const res = get(APP, "/api/events", { name: "GET /api/events", kind: "stream", timeout: "1s", headers: { Accept: "text/event-stream" }, expect: [0, 200] });
  verify(APP, res, { "live: stream opens with resync": (r) => String(r.body).includes("event: resync") });
}

export function journey() {
  const me = get(APP, "/api/me", { name: "GET /api/me" });
  verify(APP, me, { "me: 200": (r) => r.status === 200 && json(r) && json(r).username });
  const projects = get(APP, "/api/projects", { name: "GET /api/projects" });
  verify(APP, projects, { "projects: 200 list": (r) => r.status === 200 && Array.isArray(json(r)) });
  think();

  const u = uniq();
  const created = post(APP, "/api/projects", { name: "POST /api/projects", json: { name: itemName(u), color: "#3478d4", emoji: "🧪" } });
  const project = json(created);
  if (!verify(APP, created, { "project: created (201)": (r) => r.status === 201 && project && project.id })) return;
  const pid = project.id;

  try {
    think();
    const phrases = [
      `Pay rent today 9am p1 @${LABEL} every month`,
      `Review notes tomorrow p2 @${LABEL}`,
      `Call back next friday 14:30 p3`,
      `Water plants every weekday`,
    ];
    const parsed = post(APP, "/api/quick-add/parse", { name: "POST /api/quick-add/parse", json: { text: phrases[0] } });
    verify(APP, parsed, { "quick-add: preview parses priority": (r) => r.status === 200 && json(r) && json(r).priority === 1 });

    const tasks = [];
    for (const text of phrases) {
      const res = post(APP, "/api/quick-add", { name: "POST /api/quick-add", json: { text, projectId: pid } });
      const t = json(res);
      if (verify(APP, res, { "quick-add: task created (201)": (r) => r.status === 201 && t && t.id })) tasks.push(t);
      think(0.2, 0.8);
    }
    const plain = post(APP, `/api/projects/${pid}/tasks`, { name: "POST /api/projects/{id}/tasks", json: { title: `Plain task ${u}`, description: "Created by the load generator.", priority: 2 } });
    if (plain.status === 201) tasks.push(json(plain));

    const today = get(APP, `/api/tasks?view=today&project=${pid}`, { name: "GET /api/tasks?view=today" });
    verify(APP, today, { "today: lists the task due today": () => json(today) && json(today).tasks && json(today).tasks.length >= 1 });
    const upcoming = get(APP, `/api/tasks?view=upcoming&project=${pid}`, { name: "GET /api/tasks?view=upcoming" });
    verify(APP, upcoming, { "upcoming: grouped by day": () => json(upcoming) && json(upcoming).groups !== undefined });
    const all = get(APP, `/api/tasks?project=${pid}&sort=due`, { name: "GET /api/tasks" });
    verify(APP, all, { "all: every task is listed": () => json(all) && json(all).tasks && json(all).tasks.length === tasks.length });
    const found = get(APP, `/api/tasks?q=rent&project=${pid}`, { name: "GET /api/tasks?q=" });
    verify(APP, found, { "search: finds the rent task": () => json(found) && json(found).tasks && json(found).tasks.length >= 1 });
    const sections = get(APP, `/api/projects/${pid}/sections`, { name: "GET /api/projects/{id}/sections" });
    verify(APP, sections, { "sections: 200": (r) => r.status === 200 });
    think();

    if (tasks.length) {
      const first = tasks[0];
      const edited = patch(APP, `/api/tasks/${first.id}`, { name: "PATCH /api/tasks/{id}", json: { version: first.version, priority: 1, description: "Edited by the load generator." } });
      const editedBody = json(edited);
      verify(APP, edited, { "edit: version accepted": (r) => r.status === 200 && editedBody && editedBody.task });
      const version = editedBody && editedBody.task ? editedBody.task.version : first.version;
      const comment = post(APP, `/api/tasks/${first.id}/comments`, { name: "POST /api/tasks/{id}/comments", json: { body: `Paid for this month. (${u})` } });
      verify(APP, comment, { "comment: created (201)": (r) => r.status === 201 });
      const comments = get(APP, `/api/tasks/${first.id}/comments`, { name: "GET /api/tasks/{id}/comments" });
      verify(APP, comments, { "comments: lists the new comment": () => json(comments) && json(comments).length === 1 });
      const done = post(APP, `/api/tasks/${first.id}/complete`, { name: "POST /api/tasks/{id}/complete", json: { version } });
      const doneBody = json(done);
      verify(APP, done, { "complete: task done and next occurrence created": (r) => r.status === 200 && doneBody && doneBody.task && doneBody.task.data.completedAt && doneBody.next });
      const completed = get(APP, `/api/tasks?view=completed&project=${pid}`, { name: "GET /api/tasks?view=completed" });
      verify(APP, completed, { "completed: view lists it": () => json(completed) && json(completed).tasks && json(completed).tasks.length >= 1 });
    }
    liveStream();
    think();
  } finally {
    const gone = del(APP, `/api/projects/${pid}`, { name: "DELETE /api/projects/{id}", expect: [200] });
    verify(APP, gone, { "cleanup: project deleted": (r) => r.status === 200 });
  }
}

// After the run: delete projects and labels a killed iteration left behind.
export function sweep() {
  const projects = json(get(APP, "/api/projects", { name: "GET /api/projects" })) || [];
  for (const p of projects) {
    if (!p.inbox && sweepable(p.data.name)) del(APP, `/api/projects/${p.id}`, { name: "DELETE /api/projects/{id}", expect: [200] });
  }
  const labels = json(get(APP, "/api/labels", { name: "GET /api/labels" })) || [];
  for (const l of labels) {
    if (sweepable(l.data.name)) del(APP, `/api/labels/${l.id}`, { name: "DELETE /api/labels/{id}", expect: [200] });
  }
}
