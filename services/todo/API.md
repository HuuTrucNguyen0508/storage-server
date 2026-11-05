# Todo API

Base URL `https://todo.${DOMAIN}`. Requests use the Authelia session cookie. All mutations require `X-Requested-With: fetch` and JSON bodies with `Content-Type: application/json`. When present, `Origin` must equal the todo origin. There are no CORS headers. Dev authentication is documented in README.md.

IDs are UUIDs. Timestamps are RFC 3339 UTC strings. GET never changes application content, although authenticated requests provision the user's local identity and Inbox. Errors are `{error:string}`, validation errors add `issues`, version conflicts add `current:Task`. Status codes shared by all API endpoints: 400 invalid input, 401 missing identity, 403 request-forgery failure or insufficient role, 404 absent or inaccessible resource, 409 stale task version, 500 internal failure. Viewers can GET and parse quick-add, but cannot change a project or its tasks/comments. Owners alone manage membership and deletion. List results include accessible owned and shared projects, unless specified otherwise.

## Shapes

`Project = {id,owner:string,inbox:boolean,data:ProjectData}`.

`ProjectData = {name:string,color:string,emoji:string,archived:boolean,order:number}`. Create requires `name`; defaults are `#6366f1`, empty emoji, false, 0. Order values are numeric ranks; reorder with PATCH. Inbox cannot be deleted or transferred.

`Section = {id,project_id,data:{name:string,order:number}}`. Defaults: order 0.

`Label = {id,owner:string,data:{name:string,color:string}}`. Labels belong to a user. Other users cannot list or edit them. Color defaults to `#6366f1`.

`Task = {id,project_id,version:number,created_at,updated_at,data:TaskData}`.

```ts
interface TaskData {
  title: string;                 // required, 1..1000 characters
  description: string;           // Markdown source, default ""
  due: string | null;            // UTC instant, default null
  dateOnly: boolean;             // all-day intent, default false
  priority: 1 | 2 | 3 | 4;        // P1 most urgent, default 4
  labels: string[];              // personal label UUIDs; existing shared-task labels may be retained, default []
  sectionId: string | null;      // same project, default null
  parentId: string | null;       // same project, arbitrary nesting, no cycles
  assignee: string | null;       // owner or member username
  order: number;                 // manual numeric rank, default 0
  recurrence: Recurrence | null;
  reminderAt: string | null;     // absolute UTC reminder
  reminderOffsetMinutes: number | null; // before due, absolute takes precedence
  completedAt: string | null;    // default null, set by complete
  deletedAt: string | null;      // default null, set by delete
}
interface Recurrence {
  kind: 'days' | 'weeks' | 'months' | 'years' | 'weekdays' | 'weekly';
  interval: number;              // integer 1..999, default 1
  days?: number[];               // weekly requires at least one, Sunday=0
  day?: number;                  // monthly day 1..31, clamped to month end
  from: 'due' | 'completion';    // default due
}
```

Daily is `{kind:"days"}`, monthly `{kind:"months",day:15}`, yearly `{kind:"years"}`, every N units uses `interval:N`, weekdays uses `kind:"weekdays"`, chosen weekdays use `{kind:"weekly",days:[1,3,5]}`. Recurrence preserves local wall time in the completing user's profile timezone across DST. Ambiguous/nonexistent local times are resolved by the calendar helper, so prefer daytime reminders. Completion leaves the completed occurrence unchanged and creates the next task with a new ID and version 1. Reopening a completed occurrence does not remove its already-created successor.

A task create body is TaskData excluding `completedAt` and `deletedAt`. Only title is required. Task PATCH requires `version`, accepts partial TaskData and optional `projectId`. Moving a task requires write access to both projects. Its section and parent must belong to the destination. A parent with children cannot move until its children move first. Duplicate copies the selected task's data, resets completion/deletion, and appends ` (copy)` to its title; children are independent tasks.

`Comment = {id,task_id,author:string,body:string,created_at}`.

`Event = {id:string,projectId:string|null,actor:string,data:object,time:string}`.

## Endpoints

| Method | Path | Request | Success |
|---|---|---|---|
| GET | `/healthz` | none, unauthenticated | 200 `{status:"ok"}` |
| GET | `/readyz` | none, unauthenticated | 200 `{status:"ready"}`, 500 if database unreachable |
| GET | `/api/me` | none | 200 `{username,name,email,timezone,groups:string[],authPublicUrl,homeUrl}` |
| PATCH | `/api/me` | `{timezone: IANA zone}` | 200 `{username,name,email,timezone}` |
| GET | `/api/projects` | none | 200 `(Project & {role:"owner"|"editor"|"viewer",memberCount:number})[]`, ordered by rank; count includes the owner |
| POST | `/api/projects` | ProjectData | 201 Project |
| PATCH | `/api/projects/:id` | partial ProjectData | 200 Project |
| DELETE | `/api/projects/:id` | none | 200 `{ok:true}`; cascades sections/tasks/comments/activity |
| GET | `/api/projects/:id/sections` | none | 200 `Section[]` ordered by rank |
| POST | `/api/projects/:id/sections` | `{name,order?}` | 201 Section |
| PATCH | `/api/sections/:id` | `{name?,order?}` | 200 Section |
| DELETE | `/api/sections/:id` | none | 200 `{ok:true}`; tasks become unsectioned and versions increase |
| GET | `/api/labels` | none | 200 own `Label[]` |
| POST | `/api/labels` | `{name,color?}` | 201 Label |
| PATCH | `/api/labels/:id` | `{name?,color?}` | 200 Label |
| DELETE | `/api/labels/:id` | none | 200 `{ok:true}`; removes label from tasks and increments versions |
| POST | `/api/projects/:id/tasks` | task create body | 201 Task |
| GET | `/api/tasks/:id` | none | 200 Task, including soft-deleted task |
| PATCH | `/api/tasks/:id` | `{version,...partialTaskData,projectId?}` | 200 `{task:Task,next:Task|null}` |
| POST | `/api/tasks/:id/complete` | `{version}` | 200 `{task,next}` |
| POST | `/api/tasks/:id/uncomplete` | `{version}` | 200 `{task,next:null}` |
| POST | `/api/tasks/:id/delete` | `{version}` | 200 `{task,next:null}` soft deletion |
| POST | `/api/tasks/:id/restore` | `{version}` | 200 `{task,next:null}` |
| POST | `/api/tasks/:id/duplicate` | `{version}` | 201 Task |
| GET | `/api/tasks` | query below | 200 `{tasks:Task[],groups?:Record<date,Task[]>}` |
| GET | `/api/tasks/:id/comments` | none | 200 `Comment[]` oldest first |
| POST | `/api/tasks/:id/comments` | `{body:string}` | 201 Comment |
| GET | `/api/projects/:id/members` | none | 200 `{owner:string,members:{username,role}[]}` |
| POST | `/api/projects/:id/members` | `{username,role:"editor"|"viewer"}` | 200 same body, creates placeholder identity if needed; upserts role |
| POST | `/api/projects/:id/remove-member` | `{username}` | 200 `{ok:true}` |
| POST | `/api/projects/:id/leave` | `{}` | 200 `{ok:true}`; owner must transfer first |
| POST | `/api/projects/:id/transfer` | `{username}` | 200 `{ok:true}`; target must already be member, former owner becomes editor |
| GET | `/api/projects/:id/activity` | none | 200 latest 500 database event rows `{id,project_id,recipient,kind,actor,data,created_at}[]`, newest first |
| POST | `/api/quick-add/parse` | `{text,timezone?,now?:UTC timestamp}` | 200 ParsedQuickAdd below, no task creation |
| POST | `/api/quick-add` | `{text,projectId?:UUID}` | 201 Task; creates unknown personal labels |
| GET | `/api/events` | optional `Last-Event-ID` header | 200 event stream |
| GET | `/api/export` | `format=json` default or `csv` | 200 attachment, shapes below |
| POST | `/api/import` | JSON export | 201 `{ok:true,projects:number,tasks:number,idMap:Record<oldId,newId>}` |

`GET /api/tasks` accepts `view=inbox|today|upcoming|overdue|completed|all|deleted` default all; `project=<UUID>`, `label=<UUID>`, `priority=1..4`, `assignee=<username>`, `q=<search text>`; `sort=manual|due|priority|created` default manual. Search uses indexed PostgreSQL `tsvector` with `websearch_to_tsquery('simple',q)` over title and description. Today includes overdue. Overdue means local calendar day before today. Upcoming includes today and the following six local days, with date-keyed groups. Completed and deleted have separate views; all excludes both. Manual order is global numeric rank; clients group by project/section/parent. Sort due puts undated tasks last.

`ParsedQuickAdd = {title,priority,project:string|null,labels:string[],due:string|null,dateOnly:boolean,recurrence:Recurrence|null}`. Project/labels are names in the parser output, UUIDs in persisted TaskData. `projectId` overrides the parsed `#Project`. With neither, creation uses the caller's Inbox. Unknown project returns 400. Parser module `api/src/quickadd/index.ts` has no dependencies and can be imported by the web app. Supports today/tomorrow, weekday/next weekday, ISO dates, 12h/24h times, p1..p4, #project, @label, every N days/weeks/months/years, every weekdays and every named weekday. Names following #/@ are single tokens.

JSON export version 1 is `{format:1,timezone,projects:Project[],sections:Section[],labels:Label[],members:{project_id,username,role}[],tasks:Task[],comments:Comment[]}`. It exports owned projects and personal labels. Shared projects owned by someone else are excluded. Import creates fresh UUIDs and returns the mapping; the imported Inbox merges into the existing Inbox. Content, task timestamps/version/history, comments and project members are preserved. The old project owner becomes the importing user; other usernames are preserved as placeholders. Import rejects duplicate IDs, dangling or incorrectly typed references, cross-project task references, parent cycles and invalid assignees. Import is transactional and additive, so importing twice makes two copies. CSV columns are `id,project,title,description,due,priority,completedAt`, all fields quoted with RFC 4180 escaping.

## Live events

```text
id: 123
event: created
data: {"id":"123","projectId":"uuid","actor":"alice","data":{"task":{}},"time":"..."}
```

Events include `created`, `updated`, `completed`, `moved`, `commented`, `shared`, `project.created`, `project.updated`, `section.created`, `member.removed`, `member.left`, `ownership.transferred`, `imported`, `reminder`, `resync`. Task changes include `data.task`; reminders include `{taskId,reminderAt}`. Events use a PostgreSQL durable ID, are read in batches of 1000, and are woken through LISTEN/NOTIFY across replicas. A one-second poll covers a lost notification. Every batch rechecks current membership. Every connection begins with `event: resync` and `data: {}` telling clients to refetch. A fresh connection without `Last-Event-ID` includes the latest committed event ID on that resync and only delivers subsequent events. A reconnect with `Last-Event-ID` replays authorized records after that cursor; its initial resync has no ID so it cannot advance the client past replayed records. Heartbeat comments arrive every second. Reconnect with the last received numeric event ID. Slow clients over 1 MiB buffered are disconnected after resync. On membership removal the removed user receives a private resync and no more project records. Reminder claims are unique by task and scheduled instant in PostgreSQL, so replicas cannot create duplicate reminders; replay can redeliver an event and clients must deduplicate by ID. Events are currently retained without expiration.

## Typical flows

Set `BASE=https://todo.lab.localhost`, use `curl --cacert .local/ca.crt -b alice.cookies -H 'X-Requested-With: fetch' -H 'Content-Type: application/json'`. Login first at the auth host using the platform handoff's `/api/firstfactor` sequence.

1. `POST /api/projects` body `{"name":"Home","color":"#3478d4","emoji":"🏠"}`. Save returned `.id` as PROJECT.
2. `POST /api/quick-add/parse` body `{"text":"Pay rent today 9am p1 #Home @bills every month"}`. Show the preview.
3. `POST /api/quick-add` with that same body. Save returned `.id` as TASK and `.version` as VERSION.
4. `GET /api/tasks?view=today&project=PROJECT`. Result contains TASK in `.tasks`.
5. `POST /api/tasks/TASK/complete` body `{"version":VERSION}`. The completed occurrence is `.task`; the next monthly occurrence is `.next`. Keep both IDs.
6. `POST /api/tasks/TASK/comments` body `{"body":"Paid for this month."}`. Fetch `GET /api/tasks/TASK/comments` to show author and time.
7. `POST /api/projects/PROJECT/members` body `{"username":"bob","role":"editor"}`. Bob now sees the project in `GET /api/projects` and opens `GET /api/events`.
8. Alice `PATCH /api/tasks/NEXT_ID` with `{"version":1,"title":"Pay next rent"}`. Bob receives an updated event, even if connected to another replica.
9. Bob GETs the task to obtain its version, then PATCHes it. A stale version returns 409 with `current` to display before retrying.
10. For undo, POST `/api/tasks/TASK/delete`, then `/restore`, using the version returned from each preceding operation.
