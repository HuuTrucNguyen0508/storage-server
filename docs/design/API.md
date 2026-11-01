# HTTP API

`internal/api/routes.go` is the only route list. `TestDocumentedRoutesMatchTheTable` fails when this file and that list disagree.

## Surfaces

| Listener | Port | Reached by | Contains |
|---|---|---|---|
| Owner | 8080 | Host port, tailnet HTTPS 443 | Every route below, plus the app shell at `/` and `/s/{token}` |
| Guest | 8081 | Funnel HTTPS 8443 only | Routes with a Guest or link-facts auth value, `/healthz`, the shell at `/s/{token}`, and the built frontend's static files |
| Ops | 9090 | Compose network only, never published | `GET /metrics`, `GET /healthz` |

Owner routes are not registered on the guest listener, so they return 404 there with or without a session cookie. `GET /` and any other page path are also 404 there.

## Conventions

- JSON bodies are capped at 1 MiB. Errors are `{"error":{"code":"<code>","message":"<text>"}}`. Any JSON route can return 400 `invalid_json`. Any unexpected failure is 500 `internal`. A 500 `not_durable` means a rename happened and its fsync or commit failed: the change stands, `/healthz` reports unhealthy, and a restart finishes it.
- Field names in a JSON request are matched case-insensitively. Times are RFC 3339.
- A password is at least 8 bytes.
- A `path` is relative to the storage root for the owner, and relative to the shared folder for a guest. A path is parsed, never cleaned, so `a/../b` is `invalid_path`.
- `Entry` is `{name, kind, size, modTime, preview}`. `kind` is `file`, `dir`, `symlink` or `other`. `preview` is `image`, `video`, `audio`, `pdf`, `text` or empty, and is empty on anything but a `file`. A `dir` has `size` 0. Listings are sorted by byte order of `name`.
- A `symlink` or `other` entry can be renamed, moved and trashed. It cannot be opened, listed into, shared, or included in a zip. A name a path cannot hold (invalid UTF-8 or a control character) lists as `other`, cannot be acted on through the API, and is skipped by search and zip.
- Every mutating request passes `http.CrossOriginProtection`. A cross-site request gets 403 `cross_origin`.

| Auth value | Meaning |
|---|---|
| None | No credential. |
| Owner | Session cookie. HttpOnly, SameSite=Strict, Secure when `PUBLIC_URL` is https. 401 `unauthenticated` without it. |
| Link facts | Token in the URL. No grant. Spends no use. |
| Guest open | Token in the URL, plus the password if the link has one. |
| Guest browse | Grant cookie. Spends no use. Link shares only. |
| Guest fetch | Grant cookie. The first fetch of each distinct item on a grant takes one use, after the item opened. Link shares only. An item is the file on a file link, a path on a folder link, or one zip selection. Repeats, seeks, resumes and `HEAD` take none. |
| Guest drop | Grant cookie. The first upload creation on a grant takes one use. Drop shares only. |

Every Guest request can also return 404 `not_found` for an unknown or revoked token, 401 `open_required` for a missing grant, 404 `not_found` when the link kind does not allow the route, or 410 with error code `expired`, `exhausted` or `unavailable`. `unavailable` covers a trashed or missing target and does not say which. A grant that holds an item stays admitted after the link is exhausted: it can list and finish what it holds, a new item returns 410 `exhausted`, and `GET /api/public/{token}` still answers it.

## Routes

| Route | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/session` | None | | 200 `{setupRequired, authenticated}` | |
| `POST /api/setup` | None | `{code, password}` | 201, session cookie | 401 `bad_code`, 409 `already_set_up`, 422 `weak_password`, 429 `rate_limited` with Retry-After |
| `POST /api/login` | None | `{password}` | 204, session cookie | 401 `bad_credentials`, 429 `rate_limited` with Retry-After |
| `POST /api/logout` | Owner | | 204, clears cookie | |
| `POST /api/account/password` | Owner | `{current, new}` | 204, every other session is revoked | 401 `bad_credentials`, 422 `weak_password`, 429 `rate_limited` with Retry-After |
| `GET /api/sessions` | Owner | | 200 `[{id, createdAt, lastSeenAt, userAgent, ip, current}]` | |
| `DELETE /api/sessions/{id}` | Owner | | 204 | 404 `not_found` |
| `GET /api/files` | Owner | `?path=` | 200 `{path, entries: [Entry]}` | 400 `invalid_path`, 400 `reserved_name`, 404 `not_found`, 422 `not_a_directory`, 422 `symlink_refused` |
| `POST /api/files/folder` | Owner | `{path}` | 201 `{path}`, parents created, idempotent | 400 `invalid_path`, 409 `exists` when a file holds the name, 422 `symlink_refused` |
| `POST /api/files/rename` | Owner | `{path, name}` | 200 `{path}`, shares follow | 400 `invalid_path`, 400 `reserved_name`, 404 `not_found`, 409 `exists`, 409 `cross_device`, 422 `symlink_refused` |
| `POST /api/files/move` | Owner | `{paths: [..], to}` | 200 `{results: [{path, newPath} or {path, error}]}`, items fail independently, shares follow | 400 `invalid_path`, 400 `invalid_request` for no paths, per item `not_found`, `exists`, `move_into_self`, `cross_device`, `not_a_directory`, `symlink_refused`, `reserved_name` |
| `POST /api/files/trash` | Owner | `{paths: [..]}` | 200 `{results: [{path, trashId} or {path, error}]}`, shares suspend | 400 `invalid_path`, 400 `invalid_request` for no paths, per item `not_found`, `cross_device`, `symlink_refused` |
| `GET /api/files/content` | Owner | `?path=&download`, Range, If-Range | 200 or 206 bytes, headers below | 400 `invalid_path`, 404 `not_found`, 416, 422 `symlink_refused`, 422 `not_regular` |
| `GET /api/files/thumb` | Owner | `?path=&w=` where `w` is 256 or 1024 | 200 `image/jpeg` | 400 `invalid_path`, 400 `invalid_width`, 404 `not_found`, 415 `no_thumbnail`, 422 `symlink_refused`, 422 `not_regular` |
| `POST /api/files/zip` | Owner | Form, repeated `path=`, so a large selection fits and a browser can post it to a download | 200 `application/zip` streamed, connection aborted on a mid-stream error. Names are unique in the archive, so a selection of `a/x` and `b/x` gives `x` and `x (1)` | 400 `invalid_path` also for no paths, 404 `not_found`, 422 `symlink_refused` for a path through a symlink. A selected symlink is skipped |
| `GET /api/search` | Owner | `?q=&path=`, name substring, case-insensitive, spaces mean AND | 200 NDJSON, one `{path, name, kind, size, modTime}` per line, last line `{done: true, truncated}`, cap 1000 | 400 `invalid_path`, 400 `query_required`, 404 `not_found`, 422 `not_a_directory`, 422 `symlink_refused` |
| `GET /api/trash` | Owner | | 200 `[{id, name, originalPath, kind, deletedAt, purgeAt}]` | |
| `DELETE /api/trash` | Owner | | 204, every item is gone for good and shares into them are deleted | |
| `POST /api/trash/{id}/restore` | Owner | | 200 `{path}`, a taken path gets a ` (n)` suffix, missing parents are recreated, shares resume and follow | 404 `not_found`, 409 `cross_device`, 409 `exists` when a file holds a parent's name, 422 `symlink_refused` |
| `DELETE /api/trash/{id}` | Owner | | 204, the item is gone for good and shares into it are deleted | 404 `not_found` |
| `GET /api/shares` | Owner | | 200 `[{id, kind, url, path, state, uses, maxUses, expiresAt, hasPassword, createdAt}]`, newest first. `state` is `active`, `expired`, `exhausted`, `suspended` or `missing`. `maxUses` and `expiresAt` are null when unset. A suspended share's `path` is where it was before the trash | |
| `POST /api/shares` | Owner | `{path, kind: "link" or "drop", password?, expiresAt?, maxUses?}` | 201 the same object. The empty path shares the whole root | 400 `invalid_path`, 400 `invalid_request` for a bad `kind` or a `maxUses` under 1, 404 `not_found`, 422 `drop_needs_folder`, 422 `not_shareable` for a symlink or other |
| `DELETE /api/shares/{id}` | Owner | | 204, the link and its grants stop at once | 404 `not_found` |
| `POST /api/uploads` | Owner | Tus creation. `Tus-Resumable: 1.0.0`, `Upload-Length`, `Upload-Metadata: path <base64>` | 201 `Location`, `Upload-Offset: 0`, plus `X-Stored-Path` for a zero-length upload, which publishes here | 400 `invalid_path`, 400 `reserved_name`, 400 `invalid_length`, 409 `exists` when a file holds a parent's name, 412 `tus_version`, 422 `symlink_refused`, 507 `insufficient_space` |
| `HEAD /api/uploads/{id}` | Owner | `Tus-Resumable` | 200 `Upload-Offset`, `Upload-Length`, `Cache-Control: no-store`, and `X-Stored-Path` once published. Stops a live writer first, so the offset is exact | 404 `not_found` |
| `PATCH /api/uploads/{id}` | Owner | `Content-Type: application/offset+octet-stream`, `Upload-Offset`, body | 204 `Upload-Offset`, plus `X-Stored-Path` on the last byte. Bytes stored before a disconnect are kept. Every error also carries `Upload-Offset` when the upload exists | 400 `invalid_offset`, 404 `not_found`, 408 `client_stopped`, 409 `offset_mismatch`, 409 `exists`, 412 `tus_version`, 413 `too_long`, 415 `content_type`, 422 `symlink_refused`, 507 `insufficient_space` |
| `DELETE /api/uploads/{id}` | Owner | `Tus-Resumable` | 204 | 404 `not_found` |
| `GET /api/public/{token}` | Link facts | | 200 `{kind, name, isFolder, size, passwordRequired, expiresAt}`. Safe for a link preview bot. `size` is the recursive byte total on a folder link, and null when that took over 2 seconds. On a drop link `size` is null, so it says nothing about the folder. `name` is empty when the storage root itself is shared | 404 `not_found`, 410 |
| `POST /api/public/{token}/open` | Guest open | `{password?}` | 204, grant cookie scoped to this token's path, 12 hours. The body may be empty on a link with no password. A drop link needs this too | 401 `bad_credentials`, 404 `not_found`, 410, 429 `rate_limited` with Retry-After |
| `GET /api/public/{token}/files` | Guest browse | `?path=`, folder links only | 200 `{path, entries: [Entry]}` | As `GET /api/files`, 404 `not_found` on a file link |
| `GET /api/public/{token}/thumb` | Guest browse | `?path=&w=`. A file link ignores `path`. Spends no use | 200 `image/jpeg` | As `GET /api/files/thumb` |
| `GET /api/public/{token}/content` | Guest fetch | `?path=&download`, Range, If-Range. A file link ignores `path` | 200 or 206 bytes, headers below. Seeks and resumes on one grant spend one use per item | As `GET /api/files/content` |
| `POST /api/public/{token}/zip` | Guest fetch | Form, repeated `path=`. None means the whole shared folder, with no leading folder name in the archive. One selection is one item | 200 `application/zip` streamed | As `POST /api/files/zip`, 404 `not_found` on a file link |
| `POST /api/public/{token}/uploads` | Guest drop | Tus creation. `path` in metadata is one file name, refused with 400 `invalid_path` if it has a separator, before the folder is touched. The frontend flattens a dropped folder to its files | 201 `Location`, `Upload-Offset`. Never a stored name | As `POST /api/uploads`, without the parent errors |
| `HEAD /api/public/{token}/uploads/{id}` | Guest drop | `Tus-Resumable` | 200 `Upload-Offset`, `Upload-Length`. Never a stored name | 404 `not_found` |
| `PATCH /api/public/{token}/uploads/{id}` | Guest drop | As owner PATCH | 204 `Upload-Offset`. Never a stored name | As owner PATCH |
| `DELETE /api/public/{token}/uploads/{id}` | Guest drop | `Tus-Resumable` | 204 | 404 `not_found` |
| `GET /healthz` | None | | 200 `{status: "ok"}`, or 503 when the database or root fails, or a rename is waiting for a restart to become durable | 503 `unhealthy` |

Mutating routes on either surface also pass `http.CrossOriginProtection`. The ops listener also serves `/metrics` in Prometheus text format: `storage_disk_total_bytes`, `storage_disk_free_bytes`, `storage_spool_bytes`, `storage_transfer_bytes_total{direction,surface}`, `storage_uploads_active`, `storage_trash_items`, `storage_shares`, `storage_login_failures_total`, `storage_recovery_actions_total`.

## Resumable upload protocol

The protocol is tus 1.0.0 core with the creation and termination extensions, so the frontend can use `tus-js-client` with `urlStorage` for resume after a reload. Set its `chunkSize` to 64 MiB. Each chunk ends in an fsync and proxies never hold one long request.

1. The client posts `Upload-Length` and the destination path. The server refuses the upload if the free space after it would fall under `MIN_FREE_BYTES`.
2. The client sends PATCH requests from offset 0. Each one appends to `data` through a 1 MiB buffer and fsyncs before answering.
3. After any failure, the client sends HEAD. The offset is the size of `data` on disk. There is no stored counter to disagree with it.
4. A new HEAD or PATCH stops a stalled writer on the same upload, waits for it to exit, then proceeds.
5. The last byte publishes the file through the vault with an atomic no-replace rename. A taken name gets a ` (n)` suffix, so an upload never overwrites anything. A drop upload whose link is suspended answers the same 204 and publishes when the link returns.
6. HEAD keeps answering with the full offset for 24 hours, so a client that lost the final response sees success.

A zero-length upload publishes during POST. An owner's folder upload is one upload per file, each with its relative path. Parents are created at publish, so an empty folder needs `POST /api/files/folder`. A drop guest sends one flat file name per upload and cannot create folders.

## Headers on stored bytes

`media.Serve` is the only way stored bytes leave, and it sets these in one place. Thumbnails and zips carry the same protective headers.

| Header | Value |
|---|---|
| `Content-Type` | From the extension table in `internal/media/policy.go`. HTML, JS and CSS are `text/plain; charset=utf-8`. Unlisted names are `application/octet-stream`. |
| `Content-Disposition` | `inline` for listed names without `download`. Otherwise `attachment`, with an RFC 8187 `filename*`. |
| `Content-Security-Policy` | `sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'`. Every stored byte gets this, PDF included. The frontend renders PDF with `pdfjs-dist` on a canvas, so it must fetch the bytes and never navigate to them or embed them. |
| `X-Content-Type-Options` | `nosniff` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Referrer-Policy` | `no-referrer`, also on the `/s/{token}` shell, so a token never leaks through Referer. |
| `Cache-Control` | `private, no-cache` |
| `Accept-Ranges`, `ETag`, `Last-Modified` | From `http.ServeContent` and fstat. The ETag is strong, so it works in `If-Range`. |

## Headers on the app shell

The frontend at `/` and `/s/{token}` is served with `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and this policy, which the build must fit:

```
default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```
