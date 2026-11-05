// The guest page at /s/<token>: no account, only the link's capability.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, download, type Crumb, get, type Node, nodeUrl, post, publicSource, thumbUrl, zipUrl } from "./api";
import { bytes, plural, timeLeft, when } from "./format";
import { FileIcon, Icon, navigate, useLocation, withQuery } from "./ui";
import { filesFromDrop, filesFromInput, httpTransport, UploadManager } from "./uploads";
import { Viewer } from "./Viewer";
import { ArchiveView, CodeView, CsvView, Fallback, ImageView, MarkdownView, MediaView, OfficeView, PdfView, type ViewerProps } from "./viewers";

interface LinkInfo {
  link: { kind: "view" | "drop"; owner: string; expiresAt: string | null; requiresPassword: boolean; unlocked: boolean; downloadsLeft: number | null };
  node?: Node;
}

const TEXT_CAP = 1 << 20;

export function PublicPage({ token }: { token: string }) {
  const src = useMemo(() => publicSource(token), [token]);
  const info = useQuery({
    queryKey: ["public", token],
    queryFn: () => get<LinkInfo>(src.base),
    retry: false,
  });
  const owner = info.data?.link.owner;
  const ownerName = owner ? owner[0]!.toUpperCase() + owner.slice(1) : "";

  let body: ReactNode;
  if (info.isPending) body = <main className="gate" aria-busy="true" />;
  else if (info.isError) {
    const status = info.error instanceof ApiError ? info.error.status : 0;
    body = (
      <main className="gate">
        <div className="empty">
          <Icon name="i-link" size="lg" className="empty__icon" />
          <h1 className="empty__title">{status === 410 ? "This link has run out" : status === 404 ? "This link doesn't work" : "Storage isn't answering"}</h1>
          <p className="empty__text">
            {status === 410
              ? "It expired or reached its download limit. Ask the person who sent it for a new one."
              : status === 404
                ? "It was turned off, or the address is incomplete. Ask the person who sent it for a new one."
                : "Check your connection, then reload the page."}
          </p>
        </div>
      </main>
    );
  } else if (!info.data.link.unlocked) body = <PasswordGate src={src.base} owner={ownerName} />;
  else if (info.data.link.kind === "drop") body = <DropPage token={token} folder={info.data.node!} owner={ownerName} />;
  else body = <ViewPage token={token} info={info.data} owner={ownerName} />;

  useEffect(() => {
    document.title = info.data?.node ? `${info.data.node.name} – shared by ${ownerName}` : "Shared with you – Storage";
  }, [info.data, ownerName]);

  const left = info.data?.link.downloadsLeft;
  const until = info.data?.link.expiresAt;
  return (
    <div className="guest">
      <header className="guest__bar">
        <span className="topbar__app">Storage</span>
        {owner && <span className="muted text-2">Shared by {ownerName}</span>}
        <span className="topbar__spacer" />
      </header>
      {body}
      {info.data?.link.unlocked && (left != null || until) && (
        <footer className="guest__foot">
          {[left != null ? `${plural(left, "download")} left on this link.` : "", until ? `The link works for ${timeLeft(until).replace(" left", "")} more.` : ""].filter(Boolean).join(" ")}
        </footer>
      )}
    </div>
  );
}

function PasswordGate({ src, owner }: { src: string; owner: string }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errId = useId();
  return (
    <main className="gate">
      <div className="row gate-head">
        <Icon name="i-lock" size="lg" />
        <div>
          <h1>This link has a password</h1>
          <p className="muted">{owner} shared something with you and protected it with a password.</p>
        </div>
      </div>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!pw) {
            setError("Type the password.");
            return;
          }
          setBusy(true);
          try {
            await post(`${src}/unlock`, { password: pw });
            await qc.invalidateQueries({ queryKey: ["public"] });
          } catch (err) {
            const status = err instanceof ApiError ? err.status : 0;
            setError(
              status === 429
                ? "Too many wrong tries. Wait a few minutes, then try again."
                : status === 401
                  ? `That password didn't match. Ask ${owner} for the current one.`
                  : "That didn't work. Try again.",
            );
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="input input--lg"
            type="password"
            autoComplete="off"
            autoFocus
            value={pw}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => {
              setPw(e.target.value);
              setError("");
            }}
          />
          {error && (
            <span className="field__error" id={errId}>
              {error}
            </span>
          )}
        </label>
        <button className="btn btn--lg btn--primary btn--block" disabled={busy}>
          Open
        </button>
      </form>
      <p className="text-2 faint">After ten wrong tries the link locks for fifteen minutes.</p>
    </main>
  );
}

function Notice() {
  return (
    <div className="notice">
      <Icon name="i-lock" />
      <div>
        Only people with this link can see this. It was shared from a private server, not a public service. If you weren't expecting it, you can close the page;
        nothing was saved to your device.
      </div>
    </div>
  );
}

/** A file viewer body embedded in the page, with its controls above it. */
function InlinePreview({ token, node }: { token: string; node: Node }) {
  const src = useMemo(() => publicSource(token), [token]);
  const [controls, setControlsState] = useState<ReactNode>(null);
  const setControls = useCallback((c: ReactNode) => setControlsState(c), []);
  const p: ViewerProps = { src, node, setControls, textCap: TEXT_CAP };
  let view: ReactNode;
  switch (node.kind) {
    case "image":
      view = <ImageView {...p} />;
      break;
    case "video":
    case "audio":
      view = <MediaView {...p} />;
      break;
    case "pdf":
      view = <PdfView {...p} />;
      break;
    case "office":
      view = <OfficeView {...p} />;
      break;
    case "markdown":
      view = <MarkdownView {...p} />;
      break;
    case "csv":
      view = <CsvView {...p} />;
      break;
    case "code":
    case "text":
    case "json":
      view = <CodeView {...p} />;
      break;
    case "archive":
      view = <ArchiveView {...p} />;
      break;
    default:
      return <Fallback src={src} node={node} />;
  }
  const media = node.kind === "image" || node.kind === "video" || node.kind === "audio";
  return (
    <div className="guest__previewwrap">
      {controls && <div className="toolbar guest__controls">{controls}</div>}
      <div className={`guest__preview${media ? " is-media" : " is-doc"}`}>{view}</div>
    </div>
  );
}

function ViewPage({ token, info, owner }: { token: string; info: LinkInfo; owner: string }) {
  const root = info.node!;
  if (!root.isDir) {
    return (
      <main className="guest__main">
        <div className="guest__head">
          <FileIcon kind={root.kind} name={root.name} large />
          <div className="stack stack--sm guest__titles">
            <h1>{root.name}</h1>
            <div className="guest__facts">
              <span>{bytes(root.size)}</span>
              <span>Changed {when(root.modifiedAt).toLowerCase()}</span>
            </div>
          </div>
          <div className="guest__actions">
            <button className="btn btn--lg btn--primary" onClick={() => download(nodeUrl(publicSource(token), root.id, "content"))}>
              <Icon name="i-download" />
              Download
            </button>
          </div>
        </div>
        <InlinePreview token={token} node={root} />
        <Notice />
      </main>
    );
  }
  return <GuestFolder token={token} root={root} owner={owner} />;
}

function GuestFolder({ token, root }: { token: string; root: Node; owner: string }) {
  const { path, query } = useLocation();
  const src = useMemo(() => publicSource(token), [token]);
  const m = path.match(/\/f\/([0-9a-f-]{36})$/);
  const folderId = m ? m[1]! : root.id;
  const q = useQuery({
    queryKey: ["public-folder", token, folderId],
    queryFn: () => get<{ node: Node; crumbs: Crumb[]; items: Node[] }>(nodeUrl(src, folderId, "children")),
  });
  const items = useMemo(() => [...(q.data?.items ?? [])].sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }))), [q.data]);
  const viewId = query.get("view");
  const viewNode = items.find((n) => n.id === viewId);
  const base = `/s/${token}`;
  const open = (n: Node) => (n.isDir ? navigate(`${base}/f/${n.id}`) : navigate(withQuery("view", n.id)));
  const files = items.filter((n) => !n.isDir);
  return (
    <main className="guest__main">
      <div className="guest__head">
        <FileIcon kind="folder" name={root.name} large />
        <div className="stack stack--sm guest__titles">
          <nav className="crumbs" aria-label="Folder path">
            {q.data?.crumbs.map((c, i, all) =>
              i === all.length - 1 ? (
                <h1 className="crumbs__here" key={c.id}>
                  {c.name}
                </h1>
              ) : (
                <span className="crumbs__step" key={c.id}>
                  <a
                    href={i === 0 ? base : `${base}/f/${c.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(i === 0 ? base : `${base}/f/${c.id}`);
                    }}
                  >
                    {c.name}
                  </a>
                  <span className="crumbs__sep">
                    <Icon name="i-chev-r" />
                  </span>
                </span>
              ),
            )}
          </nav>
          <div className="guest__facts">
            <span>{plural(files.length, "file")}</span>
            <span>{bytes(files.reduce((s, n) => s + n.size, 0))}</span>
          </div>
        </div>
        <div className="guest__actions">
          <button className="btn btn--lg btn--primary" onClick={() => download(zipUrl(src, folderId === root.id ? [] : [folderId]))}>
            <Icon name="i-download" />
            Download all
          </button>
        </div>
      </div>
      <div className="card guest__list">
        {q.isPending ? null : items.length === 0 ? (
          <div className="empty">
            <p className="empty__title">This folder is empty</p>
          </div>
        ) : (
          <table className="table" aria-label="Files">
            <thead>
              <tr>
                <th>Name</th>
                <th className="hide-sm">Modified</th>
                <th className="col-num">Size</th>
                <th className="col-actions">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((n) => (
                <tr key={n.id}>
                  <td>
                    <div className="name-cell">
                      {n.thumbnail ? <img className="guest-thumb" src={thumbUrl(src, n, 128)} alt="" loading="lazy" /> : <FileIcon kind={n.kind} name={n.name} />}
                      <a
                        href={n.isDir ? `${base}/f/${n.id}` : withQuery("view", n.id)}
                        className="truncate"
                        onClick={(e) => {
                          e.preventDefault();
                          open(n);
                        }}
                      >
                        {n.name}
                      </a>
                    </div>
                  </td>
                  <td className="hide-sm num">{when(n.modifiedAt)}</td>
                  <td className="col-num">{n.isDir ? <span className="muted">Folder</span> : bytes(n.size)}</td>
                  <td className="col-actions col-actions--show">
                    <button
                      className="btn btn--sm btn--quiet btn--icon"
                      aria-label={`Download ${n.name}`}
                      onClick={() => download(n.isDir ? zipUrl(src, [n.id]) : nodeUrl(src, n.id, "content"))}
                    >
                      <Icon name="i-download" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Notice />
      {viewNode && (
        <Viewer
          src={src}
          node={viewNode}
          siblings={items}
          textCap={TEXT_CAP}
          backLabel={q.data?.node.name ?? "folder"}
          onClose={() => navigate(withQuery("view", null))}
          onNavigate={(id) => navigate(withQuery("view", id), { replace: true })}
        />
      )}
    </main>
  );
}

function DropPage({ token, folder, owner }: { token: string; folder: Node; owner: string }) {
  const manager = useMemo(() => new UploadManager({ transport: httpTransport(), chunkBytes: 8 << 20 }), []);
  const items = useSyncExternalStore(manager.subscribe, manager.items);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const base = `/api/public/${encodeURIComponent(token)}/uploads`;
  const add = (files: { file: File; relPath: string }[]) => manager.add(files, base, folder.id);
  const sent = items.filter((i) => i.state === "done");
  return (
    <main className="gate gate--wide">
      <div className="row gate-head">
        <Icon name="i-upload" size="lg" />
        <div>
          <h1>Send files to {owner}</h1>
          <p className="muted">
            They land in {owner}'s folder “{folder.name}”. You can't see what's already there, and nobody else can see what you send.
          </p>
        </div>
      </div>
      <div
        className={`drop-target${over ? " is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setOver(false);
          add(await filesFromDrop(e.dataTransfer));
        }}
      >
        <Icon name="i-upload" size="lg" />
        <strong>Drop files or folders here</strong>
        <button className="btn btn--primary" onClick={() => input.current?.click()}>
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) add(filesFromInput(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
      {items.length > 0 && (
        <ul className="list list--boxed" aria-label="Your uploads">
          {items.map((it) => {
            const pct = it.size ? Math.round((it.sent / it.size) * 100) : 100;
            return (
              <li className="list__item drop-item" key={it.key}>
                <FileIcon kind="other" name={it.name} />
                <div className="list__body">
                  <div className="list__title truncate">{it.name}</div>
                  <div className="list__meta">
                    {it.state === "done" ? `Sent, ${bytes(it.size)}` : it.state === "error" ? it.error : it.state === "cancelled" ? "Cancelled" : it.state === "queued" ? "Waiting" : `${pct} % of ${bytes(it.size)}`}
                  </div>
                  {it.state !== "done" && it.state !== "cancelled" && (
                    <div className="progress progress--thin">
                      <div className="progress__bar" style={{ "--value": `${pct}%` } as React.CSSProperties} />
                    </div>
                  )}
                </div>
                {(it.state === "uploading" || it.state === "queued" || it.state === "retrying") && (
                  <button className="btn btn--sm btn--quiet btn--icon" aria-label={`Cancel ${it.name}`} onClick={() => manager.cancel(it.key)}>
                    <Icon name="i-x" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {sent.length > 0 && <div className="notice notice--ok" role="status"><Icon name="i-check-circle" /><div>{plural(sent.length, "file")} sent to {owner}.</div></div>}
    </main>
  );
}
