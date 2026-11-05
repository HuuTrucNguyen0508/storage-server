# Todo web

The React UI for the todo app. The API in `../api` serves the built `dist/`
on the same origin (see `../API.md`). React 19, Vite, TypeScript strict,
TanStack Query, dnd-kit. Styles come from the shared design system
(`docs/design/direction.md`) through direct imports from `packages/ui`.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm typecheck        # tsc, strict
pnpm lint             # eslint (forbids eval, new Function and unsanitized HTML)
pnpm test             # vitest: model, live events, writer, components, access and stream checkpoints
pnpm build            # dist/
e2e/run-local.sh      # headless smoke test against the real API (Docker Postgres, AUTH_MODE=dev)
e2e/cluster-proof.sh  # headless proof in the lab cluster through Traefik and Authelia
```

`e2e/run-local.sh` starts PostgreSQL in Docker and two API processes on one
database: alice on `http://127.0.0.1:18090`, bob on `:18091`. `KEEP=1` leaves
them running for manual testing and `STOP=1` stops them. The API registers
static asset routes at startup, so restart it (rerun the script) after a
rebuild. `e2e/cluster-proof.sh` needs a deployed app (`make deploy-todo`) and
writes screenshots to `docs/shots/`.

## Layout

| Path | What it holds |
|---|---|
| `src/api/` | wire types (`types.ts`) and the fetch helper (`client.ts`): `X-Requested-With: fetch`, `redirect: "manual"`, a redirect reloads the page through sign-in |
| `src/data/model.ts` | pure cache logic: where a task lives (open, completed, gone), the live event reducer, view rules, tree rows, manual order ranks |
| `src/data/queries.ts` | TanStack Query hooks; the open and completed lists every view is derived from; roles/counts from the project list; members on demand |
| `src/data/writer.ts` | every task write: optimistic change, one write per task at a time with the latest version, 409 shows the stored copy with a notice, failures roll back and offer Retry, undo |
| `src/data/live.ts` | the event stream: resume from the last event ID, apply events, resync, reminders |
| `src/lib/` | SSE parser and reconnecting stream, dates in the profile timezone, recurrence wording, Markdown (raw HTML off, DOMPurify), colors |
| `src/app/` | the shell: top bar, routes, shortcuts, drag and drop, dialogs |
| `src/components/` | list view, rows, quick add, detail panel, recurrence editor, dialogs, sidebar, settings |
| `../../../packages/ui/` | shared styles and fonts, copied directly into the root-context Docker build |

## How it works

- **One cache, many views.** The client loads open tasks (`view=all`) and
  completed tasks once and derives Inbox, Today, Upcoming, Overdue, projects,
  labels and filters itself, with the API's own calendar code
  (`../api/src/quickadd`) so "today" matches the server. Search uses the
  server's full-text search.
- **Quick add** uses the API's parser for the live preview and then creates
  the task through `POST /api/projects/:id/tasks`, so it can set the section,
  parent and position. Unknown `@labels` are created first; an unknown
  `#project` offers to create it.
- **Live updates** come from `GET /api/events`, read with `fetch` so the
  client sends `Last-Event-ID` itself and notices an expired session. Task
  events are applied by version, so replays and echoes of your own writes are
  harmless. A refetch lays recent live changes and in-flight edits back over
  its result. After 2.5 s without a connection the list shows a one-line
  "Reconnecting" note; reconnecting resyncs.
- **Roles.** Owners and editors get every control; viewers see the same
  screens as text, with no quick add, grips, menus or comment box.
- **Drag and drop.** Drag a row's grip to reorder within a section or move it
  to another section; drop it on a project in the sidebar to move it there.
  Keyboard: focus the grip, Space, arrows, Space; or `Alt+↑/↓` on the selected
  row; or "Move to…" in the row menu. Projects reorder the same way in the
  sidebar.
- **Shortcuts:** `q` add, `/` search, `j`/`k` move, `x` or Space complete,
  `e` or Enter open, `Alt+↑/↓` reorder, `Esc` close, `?` help.
- **CSP:** the page runs under the API's `script-src 'self'; style-src 'self'`.
  No inline scripts or styles in HTML, no `eval`; dynamic colors are set
  through the CSS object model.
