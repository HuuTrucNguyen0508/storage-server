// The signed-in app: shared top bar, sidebar, routes, uploads.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { get, type Me } from "./api";
import { Browser } from "./Browser";
import { AppContext, type UploadTarget } from "./context";
import { bytes, duration } from "./format";
import { AdminPage, LinksPage, TrashPage } from "./pages";
import { A, applyTheme, FileIcon, getTheme, Icon, Menu, type Theme, useLocation, useToast } from "./ui";
import { filesFromDrop, filesFromInput, httpTransport, UploadManager } from "./uploads";

function safeStorage() {
  try {
    localStorage.setItem("storage.probe", "1");
    localStorage.removeItem("storage.probe");
    return localStorage;
  } catch {
    return undefined;
  }
}

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/api/me"), refetchInterval: 60_000 });
  if (me.isPending) return <div className="boot" aria-busy="true" />;
  if (me.isError)
    return (
      <div className="empty boot-error">
        <p className="empty__title">Storage isn't answering</p>
        <p className="empty__text">Check your connection, then reload the page.</p>
      </div>
    );
  return <Shell me={me.data} />;
}

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { path, query } = useLocation();
  const [target, setTarget] = useState<UploadTarget | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadMenu, setUploadMenu] = useState<{ x: number; y: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const manager = useMemo(
    () => new UploadManager({ transport: httpTransport(), chunkBytes: me.chunkBytes, storage: safeStorage() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const uploads = useSyncExternalStore(manager.subscribe, manager.items);

  const add = useCallback(
    (files: { file: File; relPath: string }[], parentId: string, parentName: string) => {
      if (files.length === 0) return;
      const tooBig = files.filter((f) => f.file.size > me.maxFileBytes);
      if (tooBig.length) toast({ text: `${tooBig[0]!.file.name} is larger than the ${bytes(me.maxFileBytes)} limit.`, tone: "danger" });
      const ok = files.filter((f) => f.file.size <= me.maxFileBytes);
      let pending = ok.length;
      manager.add(ok, "/api/uploads", parentId, () => {
        void qc.invalidateQueries({ queryKey: ["folder"] });
        if (--pending === 0) {
          void qc.invalidateQueries({ queryKey: ["me"] });
          toast({ text: ok.length === 1 ? `Uploaded ${ok[0]!.file.name} to ${parentName}.` : `Uploaded ${ok.length} files to ${parentName}.`, tone: "ok" });
        }
      });
    },
    [manager, me.maxFileBytes, qc, toast],
  );

  // Warn before closing the tab with uploads in flight.
  useEffect(() => {
    const busy = uploads.some((u) => u.state === "uploading" || u.state === "queued" || u.state === "retrying");
    if (!busy) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [uploads]);

  // Dropping files anywhere uploads into the current folder.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!target) {
        toast({ text: "Open a folder you can edit, then drop the files there.", tone: "warn" });
        return;
      }
      add(await filesFromDrop(e.dataTransfer!), target.id, target.name);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [target, add, toast]);

  const ctx = useMemo(() => ({ me, setUploadTarget: setTarget, uploads: { add } }), [me, add]);

  let page: ReactNode;
  const m = path.match(/^\/f\/([0-9a-f-]{36})$/);
  if (path === "/" || path === "") page = <Browser mode={{ type: "folder", id: me.user.rootId }} />;
  else if (m) page = <Browser mode={{ type: "folder", id: m[1]! }} />;
  else if (path === "/shared") page = <Browser mode={{ type: "shared" }} />;
  else if (path === "/recent") page = <Browser mode={{ type: "recent" }} />;
  else if (path === "/starred") page = <Browser mode={{ type: "starred" }} />;
  else if (path === "/search") page = <Browser mode={{ type: "search", q: query.get("q") ?? "" }} />;
  else if (path === "/trash") page = <TrashPage />;
  else if (path === "/links") page = <LinksPage />;
  else if (path === "/admin" && me.user.isAdmin) page = <AdminPage />;
  else
    page = (
      <div className="empty">
        <p className="empty__title">Nothing here</p>
        <p className="empty__text">This address doesn't match a page.</p>
        <div className="empty__actions">
          <A className="btn" href="/">
            Go to your files
          </A>
        </div>
      </div>
    );

  const openUploadMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setUploadMenu({ x: r.left, y: r.bottom + 4 });
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <TopBar me={me} />
        <div className="app__body">
          <Sidebar me={me} path={path} canUpload={!!target} onUpload={openUploadMenu} />
          <main className="main main--flush browser-main" id="main">
            {page}
          </main>
          <div className="actionbar">
            <button className="btn btn--primary" disabled={!target} onClick={openUploadMenu}>
              <Icon name="i-upload" />
              Upload
            </button>
            <A className="btn btn--icon" href="/search" aria-label="Search">
              <Icon name="i-search" />
            </A>
            <A className="btn btn--icon" href="/shared" aria-label="Shared with me">
              <Icon name="i-share" />
            </A>
            <A className="btn btn--icon" href="/trash" aria-label="Trash">
              <Icon name="i-trash" />
            </A>
          </div>
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (target && e.target.files) add(filesFromInput(e.target.files), target.id, target.name);
          e.target.value = "";
        }}
      />
      <input
        ref={dirInput}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => {
          if (target && e.target.files) add(filesFromInput(e.target.files), target.id, target.name);
          e.target.value = "";
        }}
      />
      {uploadMenu && (
        <Menu
          label="Upload"
          at={uploadMenu}
          onClose={() => setUploadMenu(null)}
          items={[
            { label: "Upload files", icon: "i-file", onSelect: () => fileInput.current?.click() },
            { label: "Upload a folder", icon: "i-folder", onSelect: () => dirInput.current?.click() },
          ]}
        />
      )}
      {dragging && (
        <div className="dropzone" aria-hidden="true">
          <div className="dropzone__card">
            <Icon name="i-upload" size="lg" />
            <strong>{target ? `Drop to upload into ${target.name}` : "You can't upload here"}</strong>
            <span className="muted text-2">{target ? "Folders keep their structure. Drop on a folder row to upload into it." : "Open one of your folders first."}</span>
          </div>
        </div>
      )}
      <UploadTray manager={manager} items={uploads} />
    </AppContext.Provider>
  );
}

function TopBar({ me }: { me: Me }) {
  const [userMenu, setUserMenu] = useState<{ x: number; y: number } | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const name = me.user.displayName || me.user.username;
  const apps = me.apps.length ? me.apps : [{ name: "Storage", url: "/" }];
  return (
    <header className="topbar">
      <A className="topbar__app" href="/">
        Storage
      </A>
      <nav className="topbar__nav" aria-label="Apps">
        {apps.map((a) => (
          <a key={a.name} className="topbar__link" href={a.url} aria-current={a.name === "Storage" ? "page" : undefined}>
            {a.name}
          </a>
        ))}
      </nav>
      <details className="switcher">
        <summary>
          Apps <Icon name="i-chev-d" size="sm" />
        </summary>
        <ul className="menu" role="menu">
          {apps.map((a) => (
            <li key={a.name} role="none">
              <a className="menu__item" role="menuitem" href={a.url} aria-current={a.name === "Storage" ? "true" : undefined}>
                {a.name}
              </a>
            </li>
          ))}
        </ul>
      </details>
      <span className="topbar__spacer" />
      <button
        className="topbar__user"
        aria-haspopup="menu"
        aria-expanded={!!userMenu}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setUserMenu({ x: r.right - 220, y: r.bottom + 4 });
        }}
      >
        <span className="avatar avatar--sm">{name[0]?.toUpperCase()}</span>
        <span className="hide-sm">{name}</span>
        <Icon name="i-chev-d" size="sm" className="hide-sm" />
      </button>
      {userMenu && (
        <Menu
          label="Account"
          at={userMenu}
          onClose={() => setUserMenu(null)}
          items={[
            ...(["system", "light", "dark"] as Theme[]).map((t) => ({
              label: `${t === theme ? "✓ " : ""}${t === "system" ? "Match the system theme" : t === "light" ? "Light theme" : "Dark theme"}`,
              onSelect: () => {
                applyTheme(t);
                setTheme(t);
              },
            })),
            ...(me.logoutUrl ? [{ label: "Sign out", icon: "i-external", separatorBefore: true, onSelect: () => (window.location.href = me.logoutUrl) }] : []),
          ]}
        />
      )}
    </header>
  );
}

function Sidebar({ me, path, canUpload, onUpload }: { me: Me; path: string; canUpload: boolean; onUpload: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  const shared = useQuery({ queryKey: ["folder", { type: "shared" }], queryFn: () => get<{ items: unknown[] }>("/api/shared"), staleTime: 60_000 });
  const { usedBytes, reservedBytes, quotaBytes } = me.usage;
  const pct = quotaBytes ? Math.min(100, ((usedBytes + reservedBytes) / quotaBytes) * 100) : 0;
  const tone = pct >= 95 ? " progress--danger" : pct >= 80 ? " progress--warn" : "";
  const nav = (href: string, icon: string, label: string, count?: number, match?: (p: string) => boolean) => (
    <A className="nav__item" href={href} aria-current={(match ? match(path) : path === href) ? "page" : undefined}>
      <Icon name={icon} />
      <span className="nav__label">{label}</span>
      {count ? <span className="nav__count">{count}</span> : null}
    </A>
  );
  return (
    <aside className="sidebar">
      <button className="btn btn--primary" onClick={onUpload} disabled={!canUpload} title={canUpload ? undefined : "Open a folder you can edit to upload"}>
        <Icon name="i-upload" />
        Upload
      </button>
      <nav className="sidebar__group" aria-label="Storage">
        {nav("/", "i-folder", "Files", undefined, (p) => p === "/" || p.startsWith("/f/"))}
        {nav("/recent", "i-clock", "Recent")}
        {nav("/starred", "i-check-circle", "Starred")}
        {nav("/shared", "i-share", "Shared with me", shared.data?.items.length)}
        {nav("/links", "i-link", "Links")}
        {nav("/trash", "i-trash", "Trash")}
        {me.user.isAdmin && nav("/admin", "i-users", "Admin")}
      </nav>
      <div className="meter sidebar-meter">
        <div className="meter__row">
          <strong>{bytes(usedBytes)} used</strong>
          <span>of {bytes(quotaBytes)}</span>
        </div>
        <div className={`progress progress--thin${tone}`} role="progressbar" aria-label="Storage used" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress__bar" style={{ "--value": `${pct}%` } as React.CSSProperties} />
        </div>
        <span>{reservedBytes > 0 ? `${bytes(reservedBytes)} held for uploads in progress.` : `${bytes(Math.max(0, quotaBytes - usedBytes))} left.`}</span>
      </div>
    </aside>
  );
}

function UploadTray({ manager, items }: { manager: UploadManager; items: ReturnType<UploadManager["items"]> }) {
  const [collapsed, setCollapsed] = useState(false);
  const active = items.filter((i) => i.state === "uploading" || i.state === "queued" || i.state === "retrying");
  const busy = active.length > 0;
  const failedAny = items.some((i) => i.state === "error");
  // Open while transfers run; fold to its header a few seconds after they finish.
  useEffect(() => {
    if (busy) {
      setCollapsed(false);
      return;
    }
    if (failedAny) return;
    const t = setTimeout(() => setCollapsed(true), 4000);
    return () => clearTimeout(t);
  }, [busy, failedAny]);
  if (items.length === 0) return null;
  const left = active.reduce((s, i) => s + (i.size - i.sent), 0);
  const rate = items.filter((i) => i.state === "uploading").reduce((s, i) => s + i.rate, 0);
  const done = items.filter((i) => i.state === "done").length;
  const failed = items.filter((i) => i.state === "error").length;
  const head = active.length
    ? `Uploading ${items.length - active.length + 1} of ${items.length}`
    : failed
      ? `${failed} upload${failed === 1 ? "" : "s"} failed`
      : `Uploaded ${done} file${done === 1 ? "" : "s"}`;
  return (
    <aside className={`tray${collapsed ? " is-collapsed" : ""}`} aria-label="Uploads">
      <div className="tray__head">
        <span aria-live="polite">{head}</span>
        {active.length > 0 && (
          <span className="faint">
            {bytes(left)} left{rate > 0 ? `, ${duration(left / rate)}` : ""}
          </span>
        )}
        <span className="grow" />
        {active.length === 0 ? (
          <button className="btn btn--sm btn--quiet" onClick={() => manager.clearFinished()}>
            Clear
          </button>
        ) : (
          <button className="btn btn--sm btn--quiet" onClick={() => manager.cancelAll()}>
            Cancel all
          </button>
        )}
        <button className="btn btn--sm btn--quiet btn--icon" aria-label={collapsed ? "Show uploads" : "Hide uploads"} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          <Icon name="i-chev-d" />
        </button>
      </div>
      {!collapsed && (
        <div className="tray__list">
          {items.map((it) => {
            const pct = it.size ? Math.round((it.sent / it.size) * 100) : 100;
            const state =
              it.state === "queued" ? "Waiting"
              : it.state === "uploading" ? `${pct} %${it.rate ? `, ${bytes(it.rate)}/s` : ""}`
              : it.state === "retrying" ? `Reconnecting at ${pct} %`
              : it.state === "done" ? "Done"
              : it.state === "cancelled" ? "Cancelled"
              : (it.error ?? "Failed");
            return (
              <div className="tray__item" key={it.key}>
                <FileIcon kind={kindOf(it.name)} name={it.name} />
                <span className="tray__name" title={it.relPath ? `${it.relPath}/${it.name}` : it.name}>
                  {it.name}
                </span>
                <span className={`tray__state${it.state === "error" ? " is-error" : ""}`}>{state}</span>
                {it.state === "error" ? (
                  <button className="btn btn--sm btn--quiet" onClick={() => manager.retry(it.key)}>
                    Retry
                  </button>
                ) : it.state !== "done" && it.state !== "cancelled" ? (
                  <button className="btn btn--sm btn--quiet btn--icon" aria-label={`Cancel ${it.name}`} onClick={() => manager.cancel(it.key)}>
                    <Icon name="i-x" size="sm" />
                  </button>
                ) : null}
                <div className={`progress${it.state === "error" ? " progress--danger" : it.state === "done" ? " progress--ok" : ""}`}>
                  <div className="progress__bar" style={{ "--value": `${pct}%` } as React.CSSProperties} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

/** A rough kind from the name, for the tray's icon color. */
function kindOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "tif", "tiff", "bmp"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "m4v", "avi"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["docx", "doc", "odt", "xlsx", "xls", "ods", "pptx", "ppt", "odp"].includes(ext)) return "office";
  return "other";
}
