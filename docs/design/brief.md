# storage-server rewrite brief

## What the owner asked for

"this https://github.com/HuuTrucNguyen0508/storage-server is my project. I want you to redo it completely. Scaffold a new project of the same name." The repo's one-line description is "a server to share files".

## What exists today

The old tree is at commit `6012c66`, cloned read-only at `/tmp/ss-orig`. It is two systems stacked on each other.

1. An abandoned custom app in `services/`: Next.js API routes, a React single file, nginx, lowdb JSON metadata. It buffered every upload into memory and hand-parsed multipart. Metadata and disk could disagree. There was no auth. Folder rename did not update nested paths.
2. The stack that actually ran: Traefik, tsdproxy, Filebrowser, Stirling PDF, a static landing page, and Prometheus, Grafana, Loki, Promtail, Jaeger and cAdvisor. Windows paths (`F:\content`) were hard-coded. The Docker socket was mounted into two containers. Grafana used admin/admin. Runtime state and JWT private keys were committed. The README describes files that do not exist.

The owner now runs CachyOS Linux and uses a tailnet that includes an Android phone.

## The product

One self-hosted server that puts a folder of a disk behind a login and lets the owner send anyone a link. The core loop is: get a file in, find it, send a link. Everything serves this loop or does not ship.

The new app replaces Filebrowser, the landing page and the abandoned `services/` app. It replaces Traefik and tsdproxy with one Tailscale sidecar. PDF tools stay as an optional bundled service. Monitoring stays as an optional, much smaller profile.

### Users

- The owner: one person with one account, on a laptop and on an Android phone.
- A guest: someone who opens a share link and has no account.

### Capabilities that must ship

Files:
- The disk is the source of truth. There is no file metadata table that can disagree with the disk. An existing folder such as the owner's old `F:\content` must work with no import step.
- Browse folders, create folders, rename, move, multi-select.
- Delete moves to a trash that can restore. Trash empties itself after 30 days.
- Upload by drag and drop, including whole folders. Uploads are resumable: a dropped connection continues from the last byte stored, after a page reload too. Multi-gigabyte files must not be buffered in memory.
- Download a file, or a folder or selection as a streamed zip.
- Search by file name across the tree.
- Preview in the app: images, video, audio, PDF, text and Markdown. Video and audio seek through HTTP Range.
- Image thumbnails.

Sharing:
- Create a link to a file or a folder. Options: password, expiry, maximum downloads.
- See and revoke links. See how many times a link was used.
- A guest opens a link with no account, previews, and downloads.
- A drop link lets a guest upload into a folder without seeing what is in it.
- Rename or move in the app keeps links working. Trash disables a link. Restore re-enables it.

Account:
- First run must not leave the server claimable by whoever arrives first. Use a one-time setup code printed to the log, or an equally safe option.
- One owner account. Password login with sessions that can be listed and revoked. A login rate limit.

Operations:
- `/healthz` and Prometheus `/metrics`, with disk and transfer metrics. Structured logs.
- `docker compose up -d` with one `.env` runs the app. Compose profiles add Tailscale, PDF tools and monitoring. No Docker socket mounts. No default passwords. No host-specific paths in tracked files.
- Tailscale profile: HTTPS on the tailnet, with an option to expose only share links to the public internet through Funnel.

### Explicitly out of scope

Multiple user accounts, roles, WebDAV, S3, sync clients, versioning, encryption at rest, a file content index, video transcoding, office document editing, Traefik, Loki, Jaeger, a mobile app.

## Constraints

- Language and framework are open. The server must handle path traversal and symlink escape as the central security boundary: no API input may reach outside the storage root, including by a symlink planted inside it. Say how the chosen stack guarantees this.
- JavaScript and TypeScript package management uses pnpm, never npm. Node 26, pnpm 12 and Go 1.27 are installed here, and also Rust and Bun.
- Uploaded content is hostile. An HTML or SVG file uploaded by a guest must not run script in the app's origin.
- The deployed shape is one container with one process for the app. The storage root is a bind mount that the operator names in `.env`. It can be a different filesystem from the app's state.
- State that must survive: account, sessions, share links. Pick the smallest store that gives transactions.
- Operations must survive a crash at any point and converge on restart: no half-finished upload visible as a file, no trash item lost.
- The frontend is a separate design task. The API must support it, including a public guest surface.

## Evidence the design must carry

Proof runs against the real binary and real disk, not mocks. Name the verification harness in the design. It must cover a real multi-gigabyte-capable upload resume, a Range read, a symlink escape attempt, a hostile HTML upload, and a crash recovery check.
