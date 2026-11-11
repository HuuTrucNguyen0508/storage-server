# Storage API

Base URL: `https://storage.${DOMAIN}` (locally `https://storage.lab.localhost`). All bodies are JSON unless stated. All responses that depend on who asks carry `Cache-Control: private, no-store`. No endpoint sends CORS headers.

## Conventions

**Authentication.** Every path except the public ones below goes through Traefik's `sso-chain`: Authelia signs the user in and the app reads `Remote-User`, `Remote-Groups`, `Remote-Email`, `Remote-Name`. Without a session, Traefik answers a browser GET with `302` to `https://auth.${DOMAIN}/?rd=…` and a POST/PUT/DELETE with `303`; behind the proxy, a request that reaches the app without `Remote-User` gets `401`. A user must be in group `users` or `admins` (`403` otherwise). Group `admins` is an admin.

Signing in without a browser (k6, scripts):

```
POST https://auth.${DOMAIN}/api/firstfactor
Content-Type: application/json
{"username":"alice","password":"…","keepMeLoggedIn":false}
→ 200 {"status":"OK"}, Set-Cookie: authelia_session=…; Domain=${DOMAIN}
```

Send that cookie on every storage request.

**Public paths** (no sign-in; identity headers are stripped and never read): `/s/…`, `/api/public/…`, `/assets/…`, `/favicon.svg`, plus `/healthz` and `/readyz`.

**Request forgery rules.** Every `POST`, `PUT`, `PATCH` and `DELETE`, public or not, must have:

- `X-Requested-With: fetch`;
- no `Origin` header, or exactly `Origin: https://storage.${DOMAIN}`;
- if there is a body: `Content-Type: application/json` (or `multipart/form-data`); upload chunks (`PUT …/uploads/{uid}`) use `application/octet-stream`.

Anything else is `403 {"error":{"code":"forbidden_request"}}`. `GET` never changes state, except that a download through a public link counts toward the link's download limit.

**Errors** are `{"error": {"code": "…", "message": "…"}}`:

| Status | Code | When |
|---|---|---|
| 400 | `invalid` | bad JSON, bad name, moving a folder into itself, … |
| 401 | `unauthenticated` / `password_required` / `wrong_password` | no identity; a public link needs its password |
| 403 | `forbidden` / `forbidden_request` | you can see the item but not change it; forgery rules |
| 404 | `not_found` | does not exist **or you may not see it** (no existence leak) |
| 409 | `conflict` / `offset_mismatch` / `upload_busy` | name taken; wrong upload offset; two writers on one upload |
| 410 | `gone` | public link expired or out of downloads |
| 413 | `too_large` | file bigger than `MAX_FILE_BYTES`, or chunk too big |
| 202 | `converting` (body `{"status":"converting"}`) | an Office preview is being prepared; retry after `Retry-After` seconds |
| 422 | `preview_failed` | an Office/ZIP preview could not be made (offer the download) |
| 429 | `rate_limited` | too many wrong link passwords (`Retry-After` set) |
| 503 | `preview_busy` / `not_ready` | Office converter saturated (`Retry-After`); database down |
| 507 | `quota_exceeded` / `volume_full` | over quota, or the volume would drop under 5 % free |

**Node** (file or folder) shape:

```json
{
  "id": "uuid", "parentId": "uuid|null", "name": "lake.jpg", "isDir": false, "size": 71240,
  "kind": "folder|image|video|audio|pdf|markdown|json|csv|code|text|archive|office|other",
  "mime": "image/jpeg", "language": "go", "thumbnail": true, "owner": "alice", "starred": false,
  "createdAt": "RFC 3339", "modifiedAt": "RFC 3339",
  "permission": "read|edit (only in /api/shared)",
  "sharing": {"people": [{"username": "bob", "permission": "read"}], "links": 1, "linkExpiresAt": "RFC 3339|null"}
}
```

`sharing` appears only on your own nodes in listings, and only when someone else can reach them. `language` only on code.

**Permissions.** `owner` (everything), `edit` (read plus upload, create folder, rename, move inside the same space, trash; not the shared folder itself), `read` (list, view, download, copy into your own space). Sharing, links and activity are owner-only. Admins have no access to other people's files; they see usage and links.

## Signed-in endpoints

### Account

| Method, path | Response |
|---|---|
| `GET /api/me` | `200 {user, usage, apps, logoutUrl, maxFileBytes, chunkBytes, textPreviewCap, publicUrl}` |
| `GET /api/users?q=bo` | `200 {users: ["bob"]}` (usernames starting with `q`, for the share dialog) |

`user` = `{id, username, email, displayName, isAdmin, placeholder, quotaBytes, rootId, createdAt, lastSeenAt}`; `usage` = `{usedBytes, reservedBytes, quotaBytes, files}`. `rootId` is the user's top folder; the literal `root` also works wherever a folder id is expected in `/api/nodes/{id}`, `/api/nodes/{id}/children`, `POST /api/folders` and `POST /api/uploads`.

### Browsing

| Method, path | Response |
|---|---|
| `GET /api/nodes/{id}` | `200 {node, permission, crumbs: [{id, name}], viaShare}` |
| `GET /api/nodes/{id}/children?sort=name\|size\|modified\|type&order=asc\|desc` | `200 {node, permission, crumbs, viaShare, items: [node]}` (folders first) |
| `GET /api/search?q=text` | `200 {items}`: names containing `q` in your own space (trigram index), at most 200 |
| `GET /api/recent` | `200 {items}`: your 50 most recently changed files |
| `GET /api/starred` | `200 {items}` |
| `GET /api/shared` | `200 {items}`: what others shared with you, each with `permission` |
| `GET /api/nodes/{id}/activity` | `200 {items: [{actor, action, detail, createdAt}]}` (owner only). Actions: `created`, `uploaded`, `uploaded_by_link`, `renamed`, `moved`, `copied`, `trashed`, `restored`, `shared`, `unshared`, `link_created`, `link_revoked`, `downloaded_by_link` |

`crumbs` runs from the highest folder you can see (your root, the outermost shared folder, or the link's folder) down to the node.

### Changing things

| Method, path | Body | Response |
|---|---|---|
| `POST /api/folders` | `{parentId, name}` | `201 {node}`; `409` if the name exists |
| `PATCH /api/nodes/{id}` | `{name?, parentId?}` | `200 {node}`: rename (`409` on a clash) and/or move |
| `POST /api/nodes/move` | `{ids: [..], parentId}` | `200 {items}`; a clashing name becomes `name (1).ext`; `400` across different owners' spaces |
| `POST /api/nodes/copy` | `{ids: [..], parentId}` | `201 {items}`; folders copy recursively; counts toward the target owner's quota |
| `DELETE /api/nodes/{id}` | | `204`, moved to the owner's trash |
| `POST /api/nodes/trash` | `{ids: [..]}` | `204` |
| `PUT /api/nodes/{id}/star` / `DELETE /api/nodes/{id}/star` | | `204` |

Names: Unicode NFC, trimmed, 1 to 255 bytes, no `/`, `\`, control or text-direction characters, not `.` or `..`. Matching is case-insensitive inside a folder.

### Trash

| Method, path | Response |
|---|---|
| `GET /api/trash` | `200 {items: [node + {trashedAt, fromFolder, purgeAt}], retentionDays}` |
| `POST /api/trash/{id}/restore` | `200 {node}`: back to its folder (or the root if that folder is gone); a clash gets a number |
| `DELETE /api/trash/{id}` | `204`, deleted for good |
| `DELETE /api/trash` | `200 {deleted: n}` |

Trash is purged after `TRASH_RETENTION` (30 days). Trashed bytes count toward the quota until purged.

### File contents

All content responses carry `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`, support `Range` (`206`), `If-Range`, `If-None-Match` (ETag is the blob id).

| Method, path | Serves |
|---|---|
| `GET /api/nodes/{id}/content` | the file as `application/octet-stream`, `Content-Disposition: attachment; filename*=…` |
| `GET /api/nodes/{id}/raw` | for the viewer: images, video and audio from an allowlist with their real type, `inline`; PDF as `application/pdf` attachment; text, code, Markdown, JSON, CSV, HTML, SVG and XML as `text/plain; charset=utf-8` attachment; anything else as a download |
| `GET /api/nodes/{id}/thumbnail?size=128\|256\|512` | JPEG thumbnail (images only; cached on the volume); `404 no_thumbnail` otherwise |
| `GET /api/nodes/{id}/office-preview` | docx, xlsx, pptx, odt, ods, odp, doc, xls, ppt, rtf converted to PDF by Stirling PDF and cached. The first request starts the conversion in the background and answers `202 {"status":"converting"}` with `Retry-After: 2`; ask again until `200` (the PDF, attachment, Range supported). `422` if it can't be converted (remembered for 10 min), `503` + `Retry-After` when the queue is full |
| `GET /api/nodes/{id}/archive` | ZIP listing `{entries: [{name, size, compressed, modified, isDir}], total, truncated}` (max 5000 entries) |
| `GET /api/zip?id=…&id=…` | streamed ZIP of the items (folders recursive, stored uncompressed). No `id` means your whole space |

### Uploads (resumable)

1. `POST /api/uploads` `{parentId, name, size, relativePath?}`. `relativePath` (`"photos/2024"`) creates or reuses folders below `parentId` when the upload finishes. Checks permission, name, `size ≤ MAX_FILE_BYTES` (`413`), quota and free space (`507`), then reserves `size` against the owner's quota. Response `201 {upload: {id, name, size, offset, chunkMax}}`. A zero-byte file finishes at once: `201 {upload, node, sha256}`.
2. `PUT /api/uploads/{uid}` with headers `Upload-Offset: <offset>`, `Content-Type: application/octet-stream`, body = the next bytes (at most `chunkMax`, and not past `size`). Response `200 {upload}` with the new `offset`; the last chunk answers `201 {upload, node, sha256}`. If the connection drops mid-chunk, the bytes that arrived are kept.
3. To resume: `GET /api/uploads/{uid}` → `{upload: {offset}}`, then continue with step 2 from that offset. A wrong `Upload-Offset` gets `409 {error: {code: "offset_mismatch"}, upload: {offset}}`.
4. `DELETE /api/uploads/{uid}` cancels (`204`). Sessions untouched for `UPLOAD_SESSION_TTL` (24 h) are purged and their reservation released.

Uploading into a folder shared with you with `edit` stores the file in the owner's space and counts toward the owner's quota.

### Sharing with people

| Method, path | Body | Response |
|---|---|---|
| `GET /api/nodes/{id}/shares` | | `200 {items: [{id, nodeId, username, permission, createdAt}]}` |
| `POST /api/nodes/{id}/shares` | `{username, permission: "read"\|"edit"}` | `201 {share}`; sharing again updates the permission. A username that never signed in gets a placeholder account |
| `DELETE /api/shares/{id}` | | `204`; the owner removes anyone, a grantee can leave |

### Public links

| Method, path | Body | Response |
|---|---|---|
| `POST /api/nodes/{id}/links` | `{kind: "view"\|"drop", password?, expiresAt?, maxDownloads?}` | `201 {link, token, url}`. The token (43 characters, 256 random bits) is returned **only here**; the server keeps its SHA-256. `drop` needs a folder |
| `GET /api/nodes/{id}/links` | | `200 {items: [link]}` |
| `GET /api/links` | | `200 {items}`: all links on your files |
| `DELETE /api/links/{id}` | | `204`; works on the next request |

`link` = `{id, nodeId, nodeName, nodeIsDir, owner, kind, hasPassword, expiresAt, maxDownloads, downloadCount, revokedAt, createdAt, lastUsedAt, status: "active"|"revoked"|"expired"|"exhausted"}`.

### Admin (group `admins`)

| Method, path | Body | Response |
|---|---|---|
| `GET /api/admin/users` | | `200 {items: [user + {usedBytes, reservedBytes, files, shares, links}], volume: {totalBytes, freeBytes}}` |
| `PATCH /api/admin/users/{id}` | `{quotaBytes}` | `204` |
| `GET /api/admin/links` | | `200 {items: [link]}` (everyone's) |
| `DELETE /api/admin/links/{id}` | | `204` |

## Public endpoints (no account)

`{token}` is the link token. Every response has `Referrer-Policy: no-referrer`. Unknown or revoked tokens: `404`; expired or used up: `410`.

| Method, path | Response |
|---|---|
| `GET /s/{token}` | the web app's guest page (HTML) |
| `GET /api/public/{token}` | `200 {link: {kind, owner, expiresAt, requiresPassword, unlocked, downloadsLeft}, node?}`; `node` once unlocked (for `drop`: only `{id, name}`) |
| `POST /api/public/{token}/unlock` | body `{password}` → `200 {unlocked: true}` and an HttpOnly, SameSite=Strict cookie `storage_link_<link id>` (path `/api/public/`, 12 h). Wrong: `401 wrong_password`. After 10 failures per link or 30 per client address in 15 min: `429` |
| `GET /api/public/{token}/nodes/{id}` | `200 {node, crumbs}` (only nodes at or below the link's node) |
| `GET /api/public/{token}/nodes/{id}/children` | `200 {node, crumbs, items}` |
| `GET /api/public/{token}/nodes/{id}/content` | download; **counts** one download (a `Range` that does not start at 0 does not) |
| `GET /api/public/{token}/nodes/{id}/raw` | viewer bytes, same rules as `/raw` but only for kinds the viewer reads there (the "anything else" case answers `404 no_preview`); does not count |
| `GET /api/public/{token}/nodes/{id}/thumbnail` / `office-preview` / `archive` | as the signed-in versions |
| `GET /api/public/{token}/zip[?id=…]` | ZIP of the link's folder (or the given items); counts one download |
| `POST/GET/PUT/DELETE /api/public/{token}/uploads[/{uid}]` | upload protocol above, `drop` links only; `parentId` is ignored (always the link's folder) |

A password link answers `401 password_required` on everything but `GET /api/public/{token}` and `/unlock` until unlocked.

## Health

`GET /healthz` → `200 ok` (process up). `GET /readyz` → `200 ok` when the database answers, else `503`. Metrics are on port 9464 only: `GET :9464/metrics` (OpenMetrics with exemplars).

## Typical flows

Everything below assumes `C` = the `authelia_session` cookie and headers `X-Requested-With: fetch` on mutating calls.

**List**

```
GET /api/me                                   → user.rootId
GET /api/nodes/{rootId}/children              → items
GET /api/nodes/{folderId}/children?sort=modified&order=desc
```

**Upload a file (one chunk; up to chunkMax = 256 MiB)**

```
POST /api/uploads            {"parentId":"root","name":"k6-1234.bin","size":1048576}
                             → 201 {"upload":{"id":U,"offset":0,...}}
PUT  /api/uploads/U          Upload-Offset: 0, Content-Type: application/octet-stream, <1048576 bytes>
                             → 201 {"node":{"id":N,...},"sha256":"..."}
```

Bigger files: repeat `PUT` with `Upload-Offset` = the previous response's `upload.offset` until the `201`.

**Download and preview**

```
GET /api/nodes/N/content                      → 200 bytes (attachment)
GET /api/nodes/N/raw   Range: bytes=0-65535   → 206
GET /api/nodes/N/thumbnail?size=256           → 200 image/jpeg (image files)
GET /api/zip?id=F                             → 200 application/zip
```

**Share link created, then guest download**

```
POST /api/nodes/N/links      {"kind":"view","password":"pw","maxDownloads":100}
                             → 201 {"token":T,"url":"https://storage.${DOMAIN}/s/T"}
# guest, no cookie:
GET  /api/public/T                            → 200 {"link":{"requiresPassword":true,"unlocked":false}}
POST /api/public/T/unlock    {"password":"pw"}  (X-Requested-With: fetch)
                             → 200, Set-Cookie: storage_link_...
GET  /api/public/T                            → 200 {"node":{"id":N,...}}
GET  /api/public/T/nodes/N/content            → 200 bytes   (counts 1 of 100)
# owner cleans up:
DELETE /api/links/{link.id}                   → 204
```

Without a password, skip the unlock. For load tests, prefer links without a password or with a correct password: each wrong password counts toward the per-client limit (30 per 15 minutes), and k6 pods share one client address.

**Clean up after a test**

```
DELETE /api/nodes/N                           → 204 (to trash)
DELETE /api/trash/N                           → 204 (gone; blob collected)
```
