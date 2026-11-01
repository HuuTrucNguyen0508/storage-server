# storage-server design, candidate B

Companion files: [API.md](API.md) has the full HTTP API. [STATES.md](STATES.md) has the state machines and crash tables. [internal/store/schema.sql](internal/store/schema.sql) is the full schema. The Go tree is the module map and type sketch.

## Problem

One self-hosted server puts a folder behind a login and lets the owner send anyone a link. Four constraints make the shape non-obvious.

1. The disk is the source of truth, but share links must survive renames, so two stores must agree without a metadata table. Every crash between them has to converge.
2. The storage root can be a different filesystem from the app's state. Trash and upload temp files need atomic rename into the tree, so they must live on the root's filesystem, inside the bind mount.
3. A guest's folder share is a smaller boundary than the storage root. A symlink that stays inside the root can still leave the shared folder.
4. Uploaded content is hostile, and a tailnet node has one hostname, so a separate content domain is not available.

The old project's lesson is direct: its metadata and disk could disagree, and it buffered uploads in memory. This design has no file metadata and no buffering.

## Usage (caller's view)

The operator:

```sh
cp .env.example .env            # set STORAGE_ROOT=/mnt/content
mkdir state
docker compose up -d
docker compose logs app | grep setup_code
# open the app, enter the code, choose a password
docker compose --profile tailscale up -d        # HTTPS on the tailnet
# TS_EXPOSE=funnel in .env adds public share links on :8443, and nothing else
```

The folder is live at once. The first boot adds one hidden directory, `.storage-server`.

The owner and a guest, through the API:

```sh
curl -b jar -X POST $APP/api/shares \
  -d '{"path":"trips/2026/video.mp4","kind":"link","maxUses":3,"expiresAt":"2026-12-01T00:00:00Z"}'
# {"id":"...","url":"https://storage.tailnet.ts.net:8443/s/9dK...","state":"active","uses":0,...}

curl -c g -X POST $GUEST/api/public/9dK.../open          # a grant, spends no use
curl -b g -r 1000000-1999999 "$GUEST/api/public/9dK.../content"   # 206, this spends one use
curl -b g -r 5000000-5999999 "$GUEST/api/public/9dK.../content"   # same grant, spends nothing
```

Two call sites inside the server. The first is real code in `internal/api/files.go`. One handler serves the owner and every guest, and the only difference is the scope the gate built.

```go
func (a *API) content(w http.ResponseWriter, r *http.Request, c *call) {
	p, err := c.scope.resolve(r.URL.Query().Get("path"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	f, err := c.scope.tree.Open(p)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer f.Close()
	media.Serve(a.counted(w, c), r, f, r.URL.Query().Has("download"))
}
```

The second is the trash path. A caller cannot express "trash the root", because the root has no `Entry`.

```go
p, err := disk.ParsePath(raw)              // refuses "..", absolute paths, .storage-server
e, ok := p.Entry()                         // false for the root
results := a.vault.Trash(ctx, []disk.Entry{e}, time.Now())
```

## Shape

**Three decisions carry the design.**

**One. A rename is the only commit, and the disk decides what happened.** Upload state is three facts about a spool directory, and the offset is the size of a file. A trash item is a directory holding `meta.json` and `item`. Neither has a database row, so neither can disagree with the disk. The one place two stores meet is a share following a move. That goes through a single function, `vault.relocate`, which journals intent, renames, then commits the rewrite. Restart applies one rule: if the destination exists the rename happened, so commit, otherwise drop the intent. Per make-operations-idempotent, there is no state where the outcome depends on what got left behind.

**Two. Trash is a location, not a flag.** A share's `target` column holds `live:a/b` or `trash:<id>/b`. Trash and restore are moves, so one SQL statement handles rename, move, trash of the target, trash of any ancestor, and restore to a different name. "Suspended" is derived from the prefix, so there is no boolean to keep in sync. This also closes a hole a path-plus-flag design has: uploading a new file at a trashed path cannot revive the old link, because the link is no longer looking at that path. Per model-the-domain.

**Three. A symlink is never followed, by anyone.** `internal/disk` resolves every path with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)`. The kernel refuses a symlink at any component, and E1 shows this holds under a live swap race. A symlink is a leaf the owner can see, move and trash, and nothing can open it. That removes cases rather than handling them: walks have no cycles, zips have no surprises, the reserved directory has no alias, a share has no sideways exit, and owner and guest code can be the same. Per type-system-discipline, this defines the special cases out of existence.

**Data structures.** `disk.Path` and `disk.Name` can only be built by parsers, and no `Path` can name `..` or the reserved directory. `disk.Entry` is a path with a parent. `disk.Location` is live or trashed. `disk.Tree` is a directory file descriptor, and `Tree.Sub` narrows it to a folder, so a guest's whole world is one descriptor. `upload.Status`, `access.State` and `access.Decision` are derived by pure functions (`phaseOf`, `StateOf`, `Decide`), so each state table is a table test. Per boundary-discipline, parsing happens once at the edge and the inside trusts the types.

**Access patterns traced.**

| Pattern | Path through the structure | Cost |
|---|---|---|
| List a folder | `Tree.List`, one getdents plus one stat per entry | Linear in the folder |
| Stream or seek | `Tree.Open`, `http.ServeContent`, sendfile | Fixed |
| Guest request | Share by unique token, grant by unique hash, Sub tree | Two index lookups |
| Rewrite shares on a move | A scan of shares, since `substr` cannot use an index | Linear in shares, one person's links, so no index exists |
| Name search | Streaming walk with no index | 681k entries in 347 ms warm, 3.0 s first pass on this SSD (E7) |
| Trash list | Read each `meta.json` | Linear in the trash |

**Module map.** A request reaches the disk in three files: `api`, then `vault` or `upload`, then `disk`.

| Package | Owns | Writes |
|---|---|---|
| `internal/disk` | The security boundary, Path types, all syscalls on the root | The storage root |
| `internal/store` | SQLite and the schema | `state.db` |
| `internal/vault` | Rename, move, trash, restore, purge, share creation, recovery | The namespace, the trash area, share targets |
| `internal/upload` | Spool and the upload state machine | The spool area |
| `internal/access` | Owner, sessions, setup code, limiter, the guest admission rule | Through `store` |
| `internal/media` | Content-type policy, thumbnails, zip | Thumbnail cache in the state directory |
| `internal/api` | The route table, HTTP parsing, tus wire format, error mapping | Nothing |
| `internal/metrics` | Counters and text format | Nothing |
| `internal/crash` | Crash point names | Nothing |
| `harness` | Proof against the real binary | A test directory |

**Interface depth.** `disk` hides file descriptors, openat2, errno translation, fsync ordering and no-replace rename behind `Tree` and one `Move`. `vault.Trash` takes entries and hides the meta file, journal, rename, fsyncs, rewrite and rollback. `upload.Append` takes an offset and a stream and hides takeover, the buffer, fsync and publish. `access.Admit` takes a token, a cookie and an act, and hides loading, state derivation, policy and consumption. Tus headers, SQL rows and `http.Request` stop at the edge of their packages.

**Security boundaries.**

- Path escape. `ParsePath` rejects, the kernel enforces, and `TestOnlyDiskTouchesStorage` fails the build if another package calls a path-taking `os` function or imports a syscall layer. I broke it on purpose and it failed with `os.Open bypasses internal/disk`.
- A share's scope. A guest's tree is `Sub(target)`, and a file link pins the path, so the `path` parameter cannot name a sibling.
- Funnel. Port 8443 reaches a second listener whose mux has no owner routes. This is enforced by what is registered, not by a proxy path rule.
- Hostile content. The server never reads the uploader's type and the browser may not sniff. HTML, JS and CSS serve as `text/plain`, and everything navigable has `CSP: sandbox`. An unlisted extension downloads. `media.Serve` is the single exit.
- Login. One owner means one limiter key, with exponential lockout persisted in SQLite, so a restart does not reset it. A locked key skips argon2 entirely, and argon2 has a two-slot semaphore. Funnel cannot reach the login route, so strangers cannot lock the owner out.
- First run. A setup code is generated at boot while no owner exists, logged, and held only in memory. `owner.id` has `CHECK (id = 1)`.
- Drop links. `Decide` allows only `Upload` on a drop share. A taken name is resolved silently and the stored name is never returned, so a guest cannot probe the folder.
- FIFO. `os.Root.Open` on a planted FIFO blocked forever in E1. `Tree.Open` uses `O_NONBLOCK` and fstat.

**What it deliberately does not do.** No index, no background scanner, no file table, no upload rows, no inode tracking, no delete-forever button, no password change, no Grafana. A file renamed outside the app makes its link `missing`, because the brief promises only renames "in the app".

**Red-flag screen.** Hand-synced lists: routes against API.md are checked by a test, crash points have one list, and preview classes derive from the header table. Split ownership: trash has one writer (`vault`), spool has one writer (`upload`), and `disk` enforces neither, which is the one soft spot, since `d.Trash` is a public field. Importable internals: Go's `internal/` does not stop siblings, so the guard test stands in. Two ways to do one task: one content handler, one relocation function, one exit for bytes. Pass-through: `api` handlers parse and map errors, so they carry policy and are not forwarders.

## Stack

**Go 1.27, standard library first, one static binary in a `scratch` image.** The brief's hard parts are in Go's standard library: `http.ServeContent` gives Range and sendfile, `archive/zip` streams zip64, `http.CrossOriginProtection` covers CSRF, and `log/slog` gives structured logs. Dependencies are `modernc.org/sqlite`, `golang.org/x/sys`, and `golang.org/x/crypto` for argon2, plus an image library for EXIF orientation at implementation time.

The stack's guarantee for the central boundary is `openat2`, not `os.Root`, because of E1. `os.Root` does refuse every escape from its root, including under a race. It also follows in-root symlinks, so `shared/sideways` left a would-be shared folder and `alias-trash/t.txt` reached the reserved directory. Nesting a Root fixes the first and not the second. openat2 refused all of them, ran under Docker's default seccomp profile, and fails closed at boot on a kernel without it, since `disk.Open` uses it to open the root.

Rust with cap-std has stronger sum types and the same kernel primitive, but would need crates for what Go ships. Bun and Node have no openat-family file API, so they could only check a path string and then use it, which is the race this brief forbids.

## Persistence

**SQLite, through pure-Go `modernc.org/sqlite`, in WAL mode with `synchronous=FULL`.** It holds exactly what the brief says must survive, plus the move journal and limiter. Prefix rewrite is one statement, which rules out a key-value store. `CGO_ENABLED=0` keeps the image `scratch`. A journaled move costs 2.6 ms on a btrfs Docker volume, measured with both fsynced transactions (`experiments/e8-sqlite/output-btrfs.txt`), so a move loop is not a concern.

Secrets a client presents are stored as SHA-256. Share tokens stay in plain text, because the owner must be able to copy a link again.

Where things live:

| Thing | Location | Why |
|---|---|---|
| Account, sessions, shares, grants | `$STATE_DIR/state.db` | Needs transactions |
| Thumbnails | `$STATE_DIR/thumbs` | Disposable |
| Trash, spool | `<root>/.storage-server/` | Rename must stay on one filesystem |

## Verification harness

`harness/harness_test.go`, run with `HARNESS_DIR=/real/disk go test -tags harness ./harness`. It builds the real binary, plain and with `-tags crashpoints`, and drives it over real sockets on a real directory with real SIGKILL. No mocks.

| Brief's evidence | Test | Proof |
|---|---|---|
| Multi-GB upload resume | `TestUploadResume` | 6 GiB of seeded data, two socket cuts, one SIGKILL, one fresh-client reload, one stalled writer. SHA-256 match, HEAD equals disk after each fault, VmHWM under 128 MiB, no partial file ever listed |
| Range read | `TestRangeRead` | Start, middle, last byte of a file over 4 GiB, suffix, stale If-Range, 416, compared to bytes on disk |
| Symlink escape | `TestSymlinkEscape` | Every path-taking route on both surfaces against planted links, a FIFO, encoded forms, and a live swapper. No canary, no hang |
| Hostile HTML | `TestHostileUpload` | Exact headers, then headless Chromium by navigation and iframe, asserting no canary in the app origin's storage. Includes SVG and a PDF with JavaScript |
| Crash recovery | `TestCrashMatrix`, `TestKillSoak` | SIGKILL at every `crash.All` point, then restart and assert invariants. A ten minute random kill soak on the plain build |

`TestShareLifecycle`, `TestMaxUses`, `TestDropPrivacy`, `TestStreamedZip`, `TestGuestListener`, `TestFirstRun` and `TestCompose` cover the rest of the brief. Their doc comments state the assertions.

SIGKILL does not prove power-loss durability. Fsync order is argued, not tested. The harness cannot cut power, and a dm-flakey run needs root.

## Experiments

Each ran under `experiments/` and its output sits beside it. Btrfs runs used an anonymous Docker volume, since `/tmp` here is tmpfs.

| # | Question | Result | Output |
|---|---|---|---|
| E1 | Does `os.Root` refuse a symlink escape? | It refuses every escape from its root, with 0 escapes in 39326 raced opens. It follows in-root links, including into the reserved directory. It blocks on a FIFO. | `e1-root-escape/output.txt` |
| E1 | Does openat2 do better, and does it run in Docker? | All vectors refused, 0 escapes in 1014960 raced opens, a FIFO returns at once, and the default seccomp profile allows it. | `e1-root-escape/output*.txt` |
| E3 | Is rename no-replace atomic for completion? | On tmpfs and btrfs, 2000 rounds of 8 racers gave exactly 2000 winners. 200 SIGKILL trials per filesystem published 4457 files with 0 torn. Files and directories both refuse replacement. | `e3-rename/output-*.txt` |
| E3 | Does a nested mount break rename? | Yes, it returns EXDEV. | `e3-rename/output-exdev.txt` |
| E5 | Does a stat offset resume through kill and takeover? | 3 GiB through SIGKILL, a dropped connection and a stalled writer, SHA-256 matched, peak RSS 13.9 and 16.6 MB. | `e5-resume/output.txt` |
| E5 | Prior run | Failed, usefully. HEAD stayed registered as a writer, so the next takeover cut the client's reused keep-alive connection. A takeover now cancels only a live writer. | `e5-resume/output-run1-keepalive-bug.txt` |
| E6 | Does `archive/zip` stream over 4 GiB? | 5 GiB through a pipe. 7z and Python verify. Info-ZIP UnZip 6.00 rejects it as a possible zip bomb. A 2 MiB archive passes. | `e6-zip/output.txt` |
| E6 | Would zip64 in the local header fix UnZip? | No. My hypothesis was wrong. A hand-written writer failed the same way, on a 5 GiB entry and on 9 GiB made of 3 GiB entries, so custom code buys nothing. | `e6-zip/output-writers.txt` |
| E7 | Does search need an index? | No, on this hardware. See the note below. | `e7-walk/output.txt` |
| Store | Are the rewrite and race-safe use count correct? | `go test ./internal/store` runs on real SQLite. It covers paths containing `%` and `_`, sibling names, unicode, purge, and 40 racing guests on `max_uses=3`, with exactly 3 uses. | `internal/store/sql_test.go` |
| Compose | Are all profiles valid? | `docker compose config` passes for each profile and for all together, and `STORAGE_ROOT` is enforced. The images were not pulled or run. | `compose-validation.txt` |

The E7 numbers need reading. The synthetic tree did 501k entries in 143 ms on tmpfs, and `/usr` did 681k in 347 ms warm. `/usr` is slower because it has 43k directories against 1k, and each directory costs an openat and a getdents. Search time scales with directories, not files. The 3.0 s first pass was on this machine's SSD with an unknown share already cached. A truly cold spinning disk would be far slower: 43k seeks at 10 ms is about 7 minutes, which is a guess, not a measurement. Results stream, so the first hits still arrive early.

## Synthesis decision

Two independent runners converged on Go, SQLite, `openat2` and a separate guest listener. The cross-judge, on a model that wrote neither, scored candidate A 22 of 30 and candidate B 15 of 30, and recommended A. The lead picked B as the base and fixed the defects the judge found. This document is B plus the binding changes below. Where they conflict with text elsewhere in this file, `API.md`, `STATES.md` or the sketch, these changes win. Update those files as you implement them.

Why B stayed the base after a lower score: its defects are three local fixes, and A's are structural. A keeps trash and upload state in SQLite, on a volume that can differ from the files, which brings back the disagreement between metadata and disk that the brief exists to remove. A also gathers everything into one `storage.Server`. B lets the disk decide, and a lost database loses no trash item.

### Binding changes to the sketch

1. **Identity-checked journal (from A, judge's blocking finding, revised by plan review).** `pending_moves` records the source's inode number, taken after the source is opened and before the rename. A rename never crosses a filesystem or a btrfs subvolume, so the inode alone identifies the file there. Do not store `st_dev`, because btrfs assigns it at mount and it changes across a reboot. Recovery has three outcomes. Destination inode matches: commit. Otherwise source inode matches: the move did not happen, so drop the row. Neither matches: something outside the app changed both paths, so delete the affected shares, log it, and drop the row. Failure scenarios this closes: a move journals a to b, an upload creates b, the process dies, and restart would point a guest link at an unrelated file; or both paths are replaced and the link stays on unrelated content.
2. **Vault owns every namespace change, including publish.** Upload no longer renames into the live tree itself. `upload.Manager` calls one `vault.Publish` under the same lock as `relocate`, so the namespace has one writer. The lock is never held across a request body or a download stream.
3. **A failed fsync is not a failed rename, and it is not a commit either.** `disk.Move` reports whether the rename happened. `AbortMove` runs only when it did not. If the rename happened and a parent fsync failed, keep the journal row, do not rewrite shares, return an error, and report unhealthy on `/healthz`. Until restart recovery resolves the row, guest resolution and every namespace mutation return 503 `unhealthy`; owner reads may continue. Restart retries durability before serving and fails startup if that retry fails. A row is deleted only after both parent fsyncs succeeded.
4. **Startup probes (from A).** `disk.Open` proves `openat2`, `RENAME_NOREPLACE` and directory fsync on the real storage root, and refuses to start with a plain error that names the failed primitive and the filesystem. There is no weaker fallback.
5. **One rule for stored bytes (from A).** PDF gets no CSP exception. Every stored byte is served with the same sandbox policy. The frontend renders PDF through `pdfjs-dist` on a canvas, lazy-loaded. This is also what makes PDF preview work at all on the owner's Android phone, because Android Chrome has no inline PDF viewer.
6. **Guard tests that cannot be fooled by an alias (judge's finding).** `TestOnlyDiskTouchesStorage` resolves imports with `go/ast` and handles renamed imports, so `import o "os"` fails it too.
7. **Drop links stay blind (from B, tightened by plan review).** A drop upload's path is a single file name. A name with a separator is refused before the folder is touched, so no response depends on what the folder holds. The frontend flattens a dropped folder to its files. A name collision is resolved privately, and admission and every response are the same whether or not the name exists.
8. **A guest's target is resolved and opened under the lock (plan review blocker).** `vault` gives guests one read-locked operation that loads the share's current target and opens the file or directory descriptor, then releases the lock before streaming. Content, thumbnails and zip all use it. `v.mu` becomes a `sync.RWMutex`. Failure scenario this closes: a guest loads target a, the owner renames a to b, an upload publishes private content at a, and the guest opens the private file by the stale path. An open descriptor keeps following the file it opened, which is the wanted behaviour.
9. **Maximum downloads means downloads (plan review).** `grant_items(grant_id, item, PRIMARY KEY(grant_id, item))` holds what a grant has fetched. The first fetch of a distinct item on a grant takes one use, in one transaction with the row insert. An item is a file path, or the literal `zip` plus a hash of the request for a zip. Seeks, resumes and repeat fetches of the same item on the same grant take none. Thumbnails take none. A guest holding an item can finish it after the limit is reached. A limit of 1 on a folder link allows one file or one zip.
### Owner-level product decisions

The lead made these for the owner. Each one is reported at hand-back.

- The share UI says "Limit to N downloads", and the count follows binding change 9. The lead first chose B's one-session rule, and plan review showed that changed the brief.
- Grafana stays in the monitoring profile with one provisioned dashboard, because the owner built that observability on purpose. `GRAFANA_PASSWORD` is required in `.env` with no default, so the brief's no-default-passwords rule holds. Loki, Promtail, Jaeger and cAdvisor stay out.
- Password change ships: `POST /api/account/password`, which needs the current password and revokes every other session. Recovery ships as `storage-server reset-owner`, which removes the owner so the setup-code flow runs again. Editing `state.db` by hand is not a recovery plan.
- Delete forever ships: `DELETE /api/trash/{id}` and `DELETE /api/trash`. An owner with a full disk needs space now, not in 30 days.
- A drop link has no byte quota. `MIN_FREE_BYTES` protects the disk.
- Symlinks stay visible leaves that nothing opens.
- The `pdf` profile must publish a usable endpoint, with a tailnet port in the Tailscale profile and a loopback host port without it.

### Plan review

GPT-6.1 Sol reviewed this synthesis before implementation and returned seven findings. S1 to S6 are folded in above. S7 asked to defer password change, recovery, delete forever and Grafana. Declined, because a lost password or a full disk would otherwise have no answer, and each costs under 50 lines.

### Rejected from A

Durable command keys and `commands.response_json`, which store sensitive responses to solve a retry the client can already detect. Hashed share tokens, because the owner must be able to copy a link again and the database sits beside the files those links unlock. SQLite intents for uploads and trash. Refusing nested mounts at startup: a nested mount returns `cross_device` on the operations it breaks and works everywhere else.

## Tradeoffs accepted

- We accept writing `.storage-server` into the owner's folder in exchange for atomic trash and publish, which a separate filesystem cannot give.
- We accept that a nested mount or btrfs subvolume inside the root returns `cross_device` on trash and move, in exchange for never falling back to a non-atomic copy.
- We accept that owners cannot browse through a symlink in exchange for one rule with no exceptions. It shows as a `symlink` entry.
- We accept about 200 lines of direct syscall code in place of `os.Root`, in exchange for a stronger guarantee. Its cost is that this code is ours to get right.
- We accept that one guest session is one use. See the open questions.
- We accept that share tokens are stored readable, so the owner can copy a link again. Anyone with `state.db` holds the links.
- We accept that a folder moved during a long owner upload gets its old path recreated at publish. Drop uploads follow the folder, because they store the share and not a path.
- We accept that Info-ZIP `unzip` rejects zips over 4 GiB. In my run it stopped before the last entry, with exit 12. 7z and Python read them. Windows Explorer and macOS Archive Utility are untested.
- We accept Prometheus without Grafana in the monitoring profile. Grafana needs a password, and "no default passwords" is easiest to keep with no login at all.
- We accept a global login limiter key. Per-IP keys are unreliable behind the sidecar, and only tailnet or LAN clients can reach login.
- We accept tus's PATCH model over a custom protocol, in exchange for a maintained browser client.

## Alternatives considered

- **Path plus `trash_id` column on shares.** It exposes a second field every rewrite must keep in step, and needs a rule for restoring to a new name. Location encoding hides both in one statement.
- **Inode-tracked share targets.** They survive renames outside the app, but an inode can be reused, an editor's atomic save changes it, and finding a path from an inode means a scan or a capability Docker drops. It hides more only when nothing goes wrong.
- **`os.Root` with a nested Root per share.** This is the smallest shape and the runner-up. It keeps stdlib code but leaves callers to handle cycles, reserved-directory aliasing and FIFOs. The complexity moves into every walker and opener.
- **A journal-free share rewrite inside one transaction around the rename.** A rename cannot join a SQLite transaction, so this only looks simpler, and it loses a share update on a crash.
- **In-memory name index.** It answers search instantly, but it is a second copy of the tree that needs a watcher and a rebuild. The numbers do not justify it.
- **Rust.** See Stack.

## Implementation reconciliation

The server is implemented and the harness passes on the real binary. The sketch held: every named data shape survived, and no change was design-level. This section records where the code left the text above, and why the design still holds.

**Harness.** `HARNESS_DIR=<dir> go test -tags harness -race -timeout 1h ./harness` runs the fast tier in about a minute. `HARNESS_LONG=1` adds the 6 GiB upload, the 5 GiB zip and the ten minute soak. `HARNESS_RACE=1` builds the server itself with the race detector, and the harness fails if a server log reports a race. Fault injection and held-open windows exist only in the `crashpoints` build, as `crash.Fault` and `crash.Gap`. `TestStartupProbes` runs the real binary under a seccomp filter that refuses each primitive, so no fake disk is involved.

**Binding change 8 went one step further.** It covered opening the target. The harness then found the same race in the state check: `Admit` loaded a share, the owner renamed the target, and the stat of the old path made a working link return 410. A guest arriving during a rename saw a false `unavailable`. `vault.ShareByToken` and `vault.Shares` now load the row and stat its target under the read lock, and `access` holds the vault instead of a tree. `TestGuestAdmissionRacesARename` proves it.

**Signatures that changed, each forced by a binding change.**

| Sketch | Code | Why |
|---|---|---|
| `disk.Move(...) error` | `(renamed bool, err error)`, with `disk.ErrNotDurable` | Change 3 |
| `Destination` passed to `upload.New` | `upload.Publisher`, which `*vault.Vault` satisfies | Change 2. `upload` has no handle on the live tree |
| `scope{tree, pinned}` | `scope{tree, file}`, and `scope.open` | Change 8. A pinned path opened after the lock is the race itself, so a file share holds the descriptor. The handler in Usage now opens through the scope and spends a use before streaming |
| `store.ConsumeGrant`, `grants.consumed_at` | `store.TakeItem`, `grant_items`. `Grant.Consumed` is derived from it | Change 9 |
| `access.Admit` consumes | `Admit` decides, `Consume` spends | Change 9. Only the handler knows the item and whether it exists |
| `access.New(ctx, db, files)` | `access.New(ctx, db, shares)` | See above |
| `Describe(ctx, token)` | Also takes the grant cookie | A holder may finish an item after exhaustion, so a reload must not show the broken-link page |
| `Thumbnails.Get(ctx, tree, path, w)` | `Get(ctx, file, w)` | Change 8 |
| `vault.Recover(ctx) error` | Returns the action count as well | `storage_recovery_actions_total` |

**Added, which the sketch did not name.** `disk.Path.Child` refuses the reserved name at the root for a name that came from outside, since `Join` cannot return an error. `disk.Info` gained `Inode`, `Dev` and `Denied`. `vault.Mkdir` exists so the namespace has one writer. `vault.CheckParents` lets an upload fail at creation rather than after the last byte. `upload.Counters` is gone, because the count needs a surface the manager does not know, and the api's body adapter counts instead. `upload.ErrScope` is gone, because a drop that cannot publish stays Complete with no error.

**Decisions the design left open.**

- A drop link's use is the first upload creation on a grant, recorded as the item `drop`. Change 9 defines only fetches, and API.md already said this. The use is taken before the spool directory is made, so a 507 from a full disk costs a guest that use.
- On a folder link an item is the path at fetch time. A file renamed between two fetches counts as a new item.
- argon2id uses 46 MiB, one pass, one thread, behind the two-slot semaphore. Two concurrent logins stay under the 128 MiB bound the harness holds the server to.
- The limiter gives five free attempts, then a lock of 30 seconds that doubles to one hour. Keys are `owner`, `setup` and `share:<id>`. A stranger with a share link can therefore lock that one link's password prompt, which the design's global-key tradeoff already accepts.
- Restore does not fall back to another folder when a file or symlink holds a parent's name. It returns 409 `exists` or 422 `symlink_refused`, and the item stays in the trash.
- A name no `Path` can hold lists as `other` and cannot be acted on through the API. `DESIGN.md` said such entries can be moved and trashed, but a request cannot name them.
- A guest's `Describe` walks a shared folder for the zip size the guest page shows, bounded at 2 seconds. A drop link reports no size.
- The app shell gets its own CSP, listed in API.md, which the frontend build must fit.
- The zip uses the 64 KiB buffer between `archive/zip` and the socket, not sendfile, because `archive/zip` needs to CRC every byte.

**Known gaps.** A publish whose parent fsync failed reports unhealthy, but has no journal row, so a restart clears `/healthz` without retrying that fsync. `TestHostileUpload` asserts the headers on both surfaces. Its headless Chromium half waits for the frontend. `TestCompose` belongs to the ops step.

**Text above that this supersedes.** The binding changes already override these lines, which remain in place as history: the PDF exception in Security boundaries and Open questions, one guest session as one use in Tradeoffs and Open questions, the exists-means-commit rule in Shape, and the cut of password change and of recovery in What it deliberately does not do and Open questions.

## Open questions and risks

- Should a "use" be a guest session? I chose yes. A preview bot spends nothing, and a video seek or a resumed download spends one use once. But one visitor can then download every file in a folder link for one use, and a preview of a single file spends the only use on a `maxUses: 1` link. Counting real downloads is the obvious alternative, but it lets one link stream to unlimited viewers. Does the owner want "N people" or "N downloads"?
- Is it acceptable that symlinks in the existing `F:\content` stop working as folders?
- Does Chrome show a PDF under this CSP? I expect `sandbox` blocks the viewer, which is why PDF omits it, but this comes from memory and I ran no browser. `TestHostileUpload` settles it.
- How large is the real tree, and is it on a spinning disk? That decides whether search needs more than a streaming walk.
- Is a Funnel link on port 8443 acceptable? It is required so the owner app can stay on 443 and off the public internet.
- Should the app offer password change or recovery? The brief does not ask, so it is cut. A lost password today means editing `state.db` by hand.
- Should a drop link have a byte quota? `MIN_FREE_BYTES` protects the disk from being filled completely, but a guest can still use all the rest.
- Filesystems such as exFAT or a FUSE NTFS driver may not support `RENAME_NOREPLACE`. Only tmpfs and btrfs were tested. `disk.Open` should probe it at boot and refuse to start, rather than silently overwrite.

## Next implementation step

Implement `internal/disk` against `TestSymlinkEscape` and the E1 vectors first, because every other package trusts its guarantees.
