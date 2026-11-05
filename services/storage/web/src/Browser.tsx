// The file browser: one folder, or a flat list (shared, recent, starred,
// search results), in list or grid view, with selection, keyboard control,
// drag-to-move, menus, and the viewer.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ActivityEntry, del, download, type Folder, get, type Node, nodeUrl, patch, type Permission, post, privateSource, put, thumbUrl, zipUrl,
} from "./api";
import { useApp } from "./context";
import { bytes, plural, sharingText, when } from "./format";
import { ShareDialog } from "./ShareDialog";
import {
  A, ConfirmDialog, Dialog, errorText, FileIcon, Icon, Menu, type MenuItem, NameDialog, navigate, typing, useLocation, usePersisted, useToast, withQuery,
} from "./ui";
import { filesFromDrop } from "./uploads";
import { Viewer } from "./Viewer";

export type BrowserMode =
  | { type: "folder"; id: string }
  | { type: "shared" }
  | { type: "recent" }
  | { type: "starred" }
  | { type: "search"; q: string };

type SortKey = "name" | "size" | "modified" | "type";

const DRAG_TYPE = "application/x-storage-nodes";

function sortNodes(items: Node[], key: SortKey, desc: boolean): Node[] {
  const out = [...items];
  const cmpName = (a: Node, b: Node) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let c = 0;
    if (key === "size") c = a.size - b.size;
    else if (key === "modified") c = a.modifiedAt.localeCompare(b.modifiedAt);
    else if (key === "type") c = a.kind.localeCompare(b.kind) || cmpName(a, b);
    else c = cmpName(a, b);
    return desc ? -c : c;
  });
  return out;
}

const canEdit = (p?: Permission | string) => p === "owner" || p === "edit";

function useFolderData(mode: BrowserMode) {
  return useQuery({
    queryKey: ["folder", mode],
    queryFn: async (): Promise<Folder | { items: Node[] }> => {
      switch (mode.type) {
        case "folder":
          return get<Folder>(`/api/nodes/${encodeURIComponent(mode.id)}/children`);
        case "search":
          return get<{ items: Node[] }>(`/api/search?q=${encodeURIComponent(mode.q)}`);
        default:
          return get<{ items: Node[] }>(`/api/${mode.type}`);
      }
    },
    placeholderData: (prev, prevQuery) => (prevQuery && JSON.stringify(prevQuery.queryKey) === JSON.stringify(["folder", mode]) ? prev : undefined),
  });
}

const TITLES: Record<Exclude<BrowserMode["type"], "folder">, string> = {
  shared: "Shared with me",
  recent: "Recent",
  starred: "Starred",
  search: "Search",
};

const EMPTY: Record<Exclude<BrowserMode["type"], "folder">, [string, string]> = {
  shared: ["Nothing shared with you yet", "When a friend shares a file or folder with you, it shows up here."],
  recent: ["No files yet", "Files you upload or change show up here, newest first."],
  starred: ["Nothing starred", "Star files and folders you open often. Press the star in a row's menu."],
  search: ["No matches", "Search looks at file and folder names in your files."],
};

export function Browser({ mode }: { mode: BrowserMode }) {
  const { me, setUploadTarget, uploads } = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const { query } = useLocation();
  const viewId = query.get("view");
  const q = useFolderData(mode);
  const [view, setView] = usePersisted<"list" | "grid">("storage.view", "list");
  const [sortKey, setSortKey] = usePersisted<SortKey>("storage.sort", "name");
  const [sortDir, setSortDir] = usePersisted<"asc" | "desc">("storage.sortDir", "asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ node: Node; at: { x: number; y: number } } | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [search, setSearch] = useState(mode.type === "search" ? mode.q : "");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const folder = q.data && "node" in q.data ? q.data : null;
  const permission: Permission | undefined = folder?.permission;
  const editable = mode.type === "folder" && canEdit(permission);
  const items = useMemo(() => sortNodes(q.data?.items ?? [], sortKey, sortDir === "desc"), [q.data, sortKey, sortDir]);
  const byId = useMemo(() => new Map(items.map((n) => [n.id, n])), [items]);
  const selection = items.filter((n) => selected.has(n.id));
  const title = mode.type === "folder" ? (folder ? (folder.node.parentId === null ? "Files" : folder.node.name) : "") : TITLES[mode.type];

  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [JSON.stringify(mode)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!viewId) document.title = title ? `${title} – Storage` : "Storage";
  }, [title, viewId]);

  // This folder is where drops and the Upload button send files.
  useEffect(() => {
    if (mode.type === "folder" && folder && editable) setUploadTarget({ id: folder.node.id, name: title });
    else setUploadTarget(null);
    return () => setUploadTarget(null);
  }, [mode.type, folder?.node.id, editable, title, setUploadTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["folder"] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  }, [qc]);

  const open = (n: Node) => {
    if (n.isDir) navigate(`/f/${n.id}`);
    else navigate(withQuery("view", n.id));
  };

  const trash = useMutation({
    mutationFn: (ids: string[]) => post("/api/nodes/trash", { ids }),
    onSuccess: (_r, ids) => {
      setSelected(new Set());
      refresh();
      toast({
        text: ids.length === 1 ? `Moved ${byId.get(ids[0]!)?.name ?? "1 item"} to trash.` : `Moved ${ids.length} items to trash.`,
        action: { label: "Undo", run: () => Promise.all(ids.map((id) => post(`/api/trash/${id}/restore`))).then(refresh) },
      });
    },
    onError: (e) => toast({ text: errorText(e), tone: "danger" }),
  });

  const move = useMutation({
    mutationFn: (v: { ids: string[]; parentId: string; copy?: boolean }) => post<{ items: Node[] }>(`/api/nodes/${v.copy ? "copy" : "move"}`, { ids: v.ids, parentId: v.parentId }),
    onSuccess: (r, v) => {
      setSelected(new Set());
      refresh();
      toast({ text: `${v.copy ? "Copied" : "Moved"} ${r.items.length === 1 ? r.items[0]!.name : plural(r.items.length, "item")}.`, tone: "ok" });
    },
    onError: (e) => toast({ text: errorText(e), tone: "danger" }),
  });

  const star = useMutation({
    mutationFn: (n: Node) => (n.starred ? del(`/api/nodes/${n.id}/star`) : put(`/api/nodes/${n.id}/star`)),
    onSuccess: (_r, n) => {
      refresh();
      toast({ text: n.starred ? `Removed the star from ${n.name}.` : `Starred ${n.name}.` });
    },
  });

  const rename = (n: Node) =>
    setDialog(
      <NameDialog
        title={`Rename ${n.isDir ? "folder" : "file"}`}
        label="Name"
        initial={n.name}
        action="Rename"
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          await patch(`/api/nodes/${n.id}`, { name });
          refresh();
          toast({ text: `Renamed to ${name}.`, tone: "ok" });
        }}
      />,
    );

  const newFolder = () =>
    folder &&
    setDialog(
      <NameDialog
        title="New folder"
        label="Folder name"
        initial=""
        action="Create folder"
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          await post("/api/folders", { parentId: folder.node.id, name });
          refresh();
          toast({ text: `Created ${name}.`, tone: "ok" });
        }}
      />,
    );

  const pickFolder = (nodes: Node[], copy: boolean) =>
    setDialog(
      <FolderPicker
        title={`${copy ? "Copy" : "Move"} ${nodes.length === 1 ? nodes[0]!.name : plural(nodes.length, "item")}`}
        action={copy ? "Copy here" : "Move here"}
        start={folder?.node.id ?? me.user.rootId}
        exclude={new Set(nodes.map((n) => n.id))}
        onClose={() => setDialog(null)}
        onPick={(parentId) => move.mutate({ ids: nodes.map((n) => n.id), parentId, copy })}
      />,
    );

  const share = (n: Node) => setDialog(<ShareDialog node={n} me={me.user.username} onClose={() => setDialog(null)} />);

  const downloadNodes = (nodes: Node[]) => {
    if (nodes.length === 1 && !nodes[0]!.isDir) download(nodeUrl(privateSource, nodes[0]!.id, "content"));
    else download(zipUrl(privateSource, nodes.map((n) => n.id)));
  };

  const confirmTrash = (nodes: Node[]) => trash.mutate(nodes.map((n) => n.id));

  const menuItems = (n: Node): MenuItem[] => {
    const own = n.owner === me.user.username;
    const edit = own || canEdit(n.permission) || (mode.type === "folder" && canEdit(permission));
    const items: MenuItem[] = [
      { label: n.isDir ? "Open folder" : "Open file", icon: n.isDir ? "i-folder" : "i-eye", kbd: "Enter", onSelect: () => open(n) },
      { label: n.isDir ? "Download as ZIP" : "Download", icon: "i-download", onSelect: () => downloadNodes([n]) },
    ];
    if (own) items.push({ label: "Share", icon: "i-share", kbd: "S", onSelect: () => share(n) });
    if (edit) items.push({ label: "Rename", icon: "i-pencil", kbd: "F2", onSelect: () => rename(n) });
    if (edit) items.push({ label: "Move to", icon: "i-folder", onSelect: () => pickFolder([n], false) });
    items.push({ label: "Copy to", icon: "i-copy", onSelect: () => pickFolder([n], true) });
    items.push({ label: n.starred ? "Remove star" : "Star", icon: "i-check", onSelect: () => star.mutate(n) });
    if (mode.type !== "folder" && n.parentId) items.push({ label: "Show in folder", icon: "i-external", onSelect: () => navigate(`/f/${n.parentId}`) });
    if (edit) items.push({ label: "Move to trash", icon: "i-trash", kbd: "Del", danger: true, separatorBefore: true, onSelect: () => confirmTrash([n]) });
    return items;
  };

  // ---- selection ----

  const toggle = (id: string, e?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (e?.shiftKey && anchor) {
        const a = items.findIndex((n) => n.id === anchor);
        const b = items.findIndex((n) => n.id === id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) next.add(items[i]!.id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!e?.shiftKey) setAnchor(id);
  };

  const focusRow = (i: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-row]");
    rows?.[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
  };

  // ---- keyboard ----

  useEffect(() => {
    if (viewId || dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        setSelected(new Set(items.map((n) => n.id)));
        return;
      }
      if (e.key === "Escape" && selected.size) {
        setSelected(new Set());
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const rowId = active?.dataset.row;
      const node = rowId ? byId.get(rowId) : undefined;
      const targets = selection.length ? selection : node ? [node] : [];
      if (e.key === "Delete" && targets.length && (editable || targets.every((n) => n.owner === me.user.username))) {
        e.preventDefault();
        confirmTrash(targets);
      } else if (e.key === "F2" && node) {
        e.preventDefault();
        rename(node);
      } else if (e.key === "s" && node && node.owner === me.user.username) {
        e.preventDefault();
        share(node);
      } else if (e.key === "n" && editable) {
        e.preventDefault();
        newFolder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onRowKey = (e: React.KeyboardEvent, n: Node, i: number) => {
    const step = view === "grid" ? gridColumns(listRef.current) : 1;
    if (e.key === "ArrowDown" || (view === "grid" && e.key === "ArrowRight")) {
      e.preventDefault();
      focusRow(i + (e.key === "ArrowDown" ? step : 1));
      if (e.shiftKey) toggle(items[Math.min(items.length - 1, i + 1)]!.id, { shiftKey: true });
    } else if (e.key === "ArrowUp" || (view === "grid" && e.key === "ArrowLeft")) {
      e.preventDefault();
      focusRow(i - (e.key === "ArrowUp" ? step : 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(n);
    } else if (e.key === " ") {
      e.preventDefault();
      toggle(n.id);
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ node: n, at: { x: r.right - 220, y: r.top + 8 } });
    }
  };

  // ---- drag and drop ----

  const dragProps = (n: Node) => ({
    draggable: editable || n.owner === me.user.username,
    onDragStart: (e: React.DragEvent) => {
      const ids = selected.has(n.id) ? [...selected] : [n.id];
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = "copyMove";
    },
  });

  const dropProps = (n: Node) =>
    n.isDir && (editable || n.owner === me.user.username)
      ? {
          onDragOver: (e: React.DragEvent) => {
            const internal = e.dataTransfer.types.includes(DRAG_TYPE);
            const files = e.dataTransfer.types.includes("Files");
            if (!internal && !files) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = internal ? (e.altKey || e.ctrlKey ? "copy" : "move") : "copy";
            setDropTarget(n.id);
          },
          onDragLeave: () => setDropTarget((t) => (t === n.id ? null : t)),
          onDrop: async (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(null);
            const raw = e.dataTransfer.getData(DRAG_TYPE);
            if (raw) {
              const ids = (JSON.parse(raw) as string[]).filter((id) => id !== n.id);
              if (ids.length) move.mutate({ ids, parentId: n.id, copy: e.altKey || e.ctrlKey });
              return;
            }
            const files = await filesFromDrop(e.dataTransfer);
            if (files.length) uploads.add(files, n.id, n.name);
          },
        }
      : {};

  // ---- render ----

  const viewNode = viewId ? (byId.get(viewId) ?? null) : null;
  const directView = useQuery({
    queryKey: ["node", viewId],
    queryFn: () => get<{ node: Node; permission: Permission }>(`/api/nodes/${viewId}`),
    enabled: !!viewId && !viewNode && !q.isPending,
  });
  const shownNode = viewNode ?? directView.data?.node ?? null;

  const crumbs = folder?.crumbs ?? [];
  const sortLabel: Record<SortKey, string> = { name: "Name", size: "Size", modified: "Modified", type: "Type" };
  const header = (key: SortKey, label: string, cls = "") => (
    <th className={cls} aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
      <button
        className="th-sort"
        onClick={() => {
          if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
          else {
            setSortKey(key);
            setSortDir(key === "modified" || key === "size" ? "desc" : "asc");
          }
        }}
      >
        {label}
        {sortKey === key && <Icon name="i-sort" size="sm" />}
      </button>
    </th>
  );

  const emptyText = mode.type === "folder" ? null : EMPTY[mode.type];
  // In your own folders the column says who else has access; elsewhere, whose it is.
  const ownerOnly = mode.type === "folder" ? folder?.permission === "owner" : mode.type !== "shared";

  return (
    <>
      <div className="browser-head">
        <nav className="crumbs" aria-label="Folder path">
          {mode.type === "folder" ? (
            crumbs.map((c, i) =>
              i === crumbs.length - 1 ? (
                <h1 className="crumbs__here" key={c.id}>
                  {i === 0 && !folder?.viaShare ? "Files" : c.name}
                </h1>
              ) : (
                <span className="crumbs__step" key={c.id}>
                  <A href={i === 0 && !folder?.viaShare ? "/" : `/f/${c.id}`}>{i === 0 && !folder?.viaShare ? "Files" : c.name}</A>
                  <span className="crumbs__sep">
                    <Icon name="i-chev-r" />
                  </span>
                </span>
              ),
            )
          ) : (
            <h1 className="crumbs__here">{mode.type === "search" ? `Results for “${mode.q}”` : title}</h1>
          )}
          {folder?.viaShare && (
            <span className="badge badge--outline crumbs-badge">
              {folder.node.owner}'s, you can {permission === "edit" ? "edit" : "view"}
            </span>
          )}
        </nav>
        <div className="toolbar browser-toolbar">
          <form
            className={`input-wrap grow browser-search${mode.type === "search" ? "" : " hide-sm"}`}
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) navigate(`/search?q=${encodeURIComponent(search.trim())}`);
            }}
          >
            <Icon name="i-search" />
            <input
              ref={searchRef}
              className="input"
              type="search"
              placeholder="Search your files"
              aria-label="Search your files"
              autoFocus={mode.type === "search" && !mode.q}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
              }}
            />
            <span className="kbd">/</span>
          </form>
          <span className="toolbar__spacer" />
          {editable && (
            <button className="btn hide-sm" onClick={newFolder}>
              <Icon name="i-plus" />
              New folder
            </button>
          )}
          <label className="select select--sm sort-select">
            <span className="sr-only">Sort by</span>
            <select
              value={`${sortKey}:${sortDir}`}
              onChange={(e) => {
                const [k, d] = e.target.value.split(":") as [SortKey, "asc" | "desc"];
                setSortKey(k);
                setSortDir(d);
              }}
            >
              {(["name", "modified", "size", "type"] as SortKey[]).flatMap((k) =>
                (["asc", "desc"] as const).map((d) => (
                  <option key={k + d} value={`${k}:${d}`}>
                    {sortLabel[k]}, {k === "name" || k === "type" ? (d === "asc" ? "A to Z" : "Z to A") : d === "desc" ? (k === "size" ? "largest first" : "newest first") : k === "size" ? "smallest first" : "oldest first"}
                  </option>
                )),
              )}
            </select>
          </label>
          <div className="btn-group" role="group" aria-label="View">
            <button className="btn btn--icon" aria-pressed={view === "list"} aria-label="List" onClick={() => setView("list")}>
              <Icon name="i-list" />
            </button>
            <button className="btn btn--icon" aria-pressed={view === "grid"} aria-label="Grid" onClick={() => setView("grid")}>
              <Icon name="i-grid" />
            </button>
          </div>
        </div>
        {selection.length > 0 && (
          <div className="selbar" role="status">
            <span className="selbar__count">{selection.length} selected</span>
            <button className="btn btn--sm" onClick={() => downloadNodes(selection)}>
              <Icon name="i-download" />
              Download
            </button>
            {selection.length === 1 && selection[0]!.owner === me.user.username && (
              <button className="btn btn--sm" onClick={() => share(selection[0]!)}>
                <Icon name="i-share" />
                Share
              </button>
            )}
            {(editable || selection.every((n) => n.owner === me.user.username)) && (
              <button className="btn btn--sm hide-sm" onClick={() => pickFolder(selection, false)}>
                <Icon name="i-folder" />
                Move
              </button>
            )}
            <button className="btn btn--sm hide-sm" onClick={() => pickFolder(selection, true)}>
              <Icon name="i-copy" />
              Copy
            </button>
            {(editable || selection.every((n) => n.owner === me.user.username)) && (
              <button className="btn btn--sm btn--danger" onClick={() => confirmTrash(selection)}>
                <Icon name="i-trash" />
                Trash
              </button>
            )}
            <span className="toolbar__spacer" />
            <button className="btn btn--sm btn--quiet btn--icon" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
              <Icon name="i-x" />
            </button>
          </div>
        )}
      </div>

      <div ref={listRef} className="browser-body">
        {q.isPending ? (
          <div className="skeleton-list" aria-busy="true" aria-label="Loading">
            {Array.from({ length: 6 }, (_, i) => (
              <div className="skeleton-row" key={i}>
                <span className="skeleton skeleton--text" />
              </div>
            ))}
          </div>
        ) : q.isError ? (
          <div className="empty">
            <p className="empty__title">{(q.error as { status?: number }).status === 404 ? "This folder isn't here" : "Couldn't load this list"}</p>
            <p className="empty__text">
              {(q.error as { status?: number }).status === 404 ? "It was moved to trash, or the share was removed." : "Check your connection and try again."}
            </p>
            <div className="empty__actions">
              <A className="btn" href="/">
                Go to your files
              </A>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="empty">
            <Icon name={mode.type === "folder" ? "i-folder" : mode.type === "search" ? "i-search" : "i-share"} size="lg" className="empty__icon" />
            <p className="empty__title">{emptyText ? emptyText[0] : "This folder is empty"}</p>
            <p className="empty__text">{emptyText ? emptyText[1] : editable ? "Drop files or a folder anywhere on this page, or use Upload." : "Nothing has been added here yet."}</p>
          </div>
        ) : view === "list" ? (
          <table className="table browser-table" aria-label={`Files in ${title}`}>
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    className="check"
                    type="checkbox"
                    aria-label="Select all"
                    checked={selection.length > 0 && selection.length === items.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selection.length > 0 && selection.length < items.length;
                    }}
                    onChange={(e) => setSelected(e.target.checked ? new Set(items.map((n) => n.id)) : new Set())}
                  />
                </th>
                {header("name", "Name")}
                <th className="hide-sm">{ownerOnly ? "Shared" : "Owner"}</th>
                {header("modified", "Modified", "hide-sm")}
                {header("size", "Size", "col-num")}
                <th className="col-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((n, i) => (
                <tr
                  key={n.id}
                  data-row={n.id}
                  tabIndex={0}
                  className={`${selected.has(n.id) ? "is-selected" : ""}${dropTarget === n.id ? " is-drop" : ""}`}
                  aria-selected={selected.has(n.id)}
                  onKeyDown={(e) => onRowKey(e, n, i)}
                  onDoubleClick={() => open(n)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) toggle(n.id, e);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ node: n, at: { x: e.clientX, y: e.clientY } });
                  }}
                  {...dragProps(n)}
                  {...dropProps(n)}
                >
                  <td className="col-check">
                    <input className="check" type="checkbox" tabIndex={-1} aria-label={`Select ${n.name}`} checked={selected.has(n.id)} onChange={() => toggle(n.id)} onClick={(e) => e.stopPropagation()} />
                  </td>
                  <td>
                    <div className="name-cell">
                      <FileIcon kind={n.kind} name={n.name} />
                      <a
                        href={n.isDir ? `/f/${n.id}` : withQuery("view", n.id)}
                        tabIndex={-1}
                        className="truncate"
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                          e.preventDefault();
                          open(n);
                        }}
                      >
                        {n.name}
                      </a>
                      {n.starred && <Icon name="i-check" size="sm" className="star-mark" label="Starred" />}
                    </div>
                  </td>
                  <td className="hide-sm">
                    {n.owner === me.user.username ? (
                      n.sharing ? (
                        <span className="row">
                          {n.sharing.people[0] ? (
                            <span className="avatar avatar--sm">{n.sharing.people[0].username[0]?.toUpperCase()}</span>
                          ) : (
                            <Icon name="i-link" size="sm" className="faint" />
                          )}
                          <span className="text-2 muted">{sharingText(n.sharing)}</span>
                        </span>
                      ) : (
                        <span className="faint">Only you</span>
                      )
                    ) : (
                      <span className="row">
                        <span className="avatar avatar--sm">{n.owner[0]?.toUpperCase()}</span>
                        <span className="text-2 muted">
                          {n.owner}
                          {n.permission ? `, you can ${n.permission === "edit" ? "edit" : "view"}` : ""}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="hide-sm num">{when(n.modifiedAt)}</td>
                  <td className="col-num">{n.isDir ? <span className="muted">Folder</span> : bytes(n.size)}</td>
                  <td className="col-actions">
                    <span className="row-actions">
                      <button
                        className="btn btn--sm btn--quiet btn--icon"
                        aria-label={`Actions for ${n.name}`}
                        aria-haspopup="menu"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setMenu({ node: n, at: { x: r.right - 220, y: r.bottom + 4 } });
                        }}
                      >
                        <Icon name="i-more" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="grid browser-grid" role="list" aria-label={`Files in ${title}`}>
            {items.map((n, i) => (
              <div
                key={n.id}
                role="listitem"
                data-row={n.id}
                tabIndex={0}
                className={`tile${selected.has(n.id) ? " is-selected" : ""}${dropTarget === n.id ? " is-drop" : ""}`}
                aria-selected={selected.has(n.id)}
                aria-label={n.name}
                onKeyDown={(e) => onRowKey(e, n, i)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) toggle(n.id, e);
                  else open(n);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ node: n, at: { x: e.clientX, y: e.clientY } });
                }}
                {...dragProps(n)}
                {...dropProps(n)}
              >
                <input
                  className="check tile__check"
                  type="checkbox"
                  tabIndex={-1}
                  aria-label={`Select ${n.name}`}
                  checked={selected.has(n.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(n.id)}
                />
                <div className="tile__thumb">
                  {n.thumbnail ? <img src={thumbUrl(privateSource, n, 256)} alt="" loading="lazy" draggable={false} /> : <FileIcon kind={n.kind} name={n.name} large />}
                </div>
                <div className="tile__name" title={n.name}>
                  {n.name}
                </div>
                <div className="tile__meta">{n.isDir ? "Folder" : bytes(n.size)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {menu && <Menu label={menu.node.name} items={menuItems(menu.node)} at={menu.at} onClose={() => setMenu(null)} />}
      {dialog}
      {viewId && shownNode && (
        <Viewer
          src={privateSource}
          node={shownNode}
          siblings={viewNode ? items : [shownNode]}
          textCap={me.textPreviewCap}
          backLabel={title || "files"}
          onClose={() => {
            setDetails(false);
            navigate(withQuery("view", null));
            setTimeout(() => (listRef.current?.querySelector(`[data-row="${shownNode.id}"]`) as HTMLElement | null)?.focus(), 0);
          }}
          onNavigate={(id) => navigate(withQuery("view", id), { replace: true })}
          actions={
            <>
              {shownNode.owner === me.user.username && (
                <button className="btn hide-sm" onClick={() => share(shownNode)}>
                  <Icon name="i-share" />
                  Share
                </button>
              )}
              <button className="btn btn--quiet btn--icon" aria-pressed={details} aria-label="Details" title="Details" onClick={() => setDetails(!details)}>
                <Icon name="i-info" />
              </button>
            </>
          }
          panel={details ? <Details node={shownNode} own={shownNode.owner === me.user.username} onClose={() => setDetails(false)} /> : undefined}
        />
      )}
      {viewId && !shownNode && directView.isError && (
        <ConfirmDialog title="This file isn't available" action="Close" onConfirm={() => navigate(withQuery("view", null))} onClose={() => navigate(withQuery("view", null))}>
          <p>It was moved to trash, or you no longer have access.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function gridColumns(el: HTMLElement | null): number {
  const grid = el?.querySelector(".grid");
  if (!grid) return 1;
  return getComputedStyle(grid).gridTemplateColumns.split(" ").length || 1;
}

const ACTIONS: Record<string, string> = {
  created: "created this",
  uploaded: "uploaded this",
  uploaded_by_link: "uploaded this through a link",
  renamed: "renamed this",
  moved: "moved this",
  copied: "made this copy",
  trashed: "moved this to trash",
  restored: "restored this",
  shared: "shared this",
  unshared: "stopped sharing this",
  link_created: "created a link",
  link_revoked: "turned off a link",
  downloaded_by_link: "downloaded this through a link",
};

/** Properties and history of a file, in the viewer's side panel. */
export function Details({ node, own, onClose }: { node: Node; own: boolean; onClose: () => void }) {
  const act = useQuery({ queryKey: ["activity", node.id], queryFn: () => get<{ items: ActivityEntry[] }>(`/api/nodes/${node.id}/activity`), enabled: own });
  return (
    <aside className="panel viewer-panel" aria-label="Details">
      <div className="panel__head">
        <h2 className="text-1">Details</h2>
        <button className="btn btn--quiet btn--icon btn--sm" aria-label="Close details" onClick={onClose}>
          <Icon name="i-x" />
        </button>
      </div>
      <div className="panel__body stack">
        <dl className="stack stack--sm">
          <div className="prop">
            <dt className="prop__name">Size</dt>
            <dd className="prop__value num">{bytes(node.size)}</dd>
          </div>
          <div className="prop">
            <dt className="prop__name">Type</dt>
            <dd className="prop__value">{node.mime}</dd>
          </div>
          <div className="prop">
            <dt className="prop__name">Modified</dt>
            <dd className="prop__value">{when(node.modifiedAt)}</dd>
          </div>
          <div className="prop">
            <dt className="prop__name">Added</dt>
            <dd className="prop__value">{when(node.createdAt)}</dd>
          </div>
          <div className="prop">
            <dt className="prop__name">Owner</dt>
            <dd className="prop__value">{own ? "You" : node.owner}</dd>
          </div>
        </dl>
        {own && (
          <div className="stack stack--sm">
            <h3 className="text-2 activity-title">Activity</h3>
            {act.data?.items.length === 0 && <p className="muted text-2">Nothing yet.</p>}
            <ol className="activity">
              {act.data?.items.map((a, i) => (
                <li key={i}>
                  <span>
                    <strong>{a.actor}</strong> {ACTIONS[a.action] ?? a.action}
                    {a.detail ? `: ${a.detail}` : ""}
                  </span>
                  <span className="faint text-2">{when(a.createdAt)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </aside>
  );
}

/** Choose a folder to move or copy into. */
function FolderPicker({
  title, action, start, exclude, onPick, onClose,
}: { title: string; action: string; start: string; exclude: Set<string>; onPick: (id: string) => void; onClose: () => void }) {
  const [at, setAt] = useState(start);
  const q = useQuery({ queryKey: ["picker", at], queryFn: () => get<Folder>(`/api/nodes/${at}/children`) });
  const folders = (q.data?.items ?? []).filter((n) => n.isDir && !exclude.has(n.id));
  const writable = canEdit(q.data?.permission);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!writable || exclude.has(at)}
            onClick={() => {
              onPick(at);
              onClose();
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <nav className="crumbs picker-crumbs" aria-label="Folder path">
        {q.data?.crumbs.map((c, i, all) => (
          <span key={c.id} className="crumbs__step">
            {i < all.length - 1 ? (
              <button className="btn btn--sm btn--quiet" onClick={() => setAt(c.id)}>
                {i === 0 && !q.data?.viaShare ? "Files" : c.name}
              </button>
            ) : (
              <strong>{i === 0 && !q.data?.viaShare ? "Files" : c.name}</strong>
            )}
            {i < all.length - 1 && (
              <span className="crumbs__sep">
                <Icon name="i-chev-r" />
              </span>
            )}
          </span>
        ))}
      </nav>
      <ul className="list list--boxed picker-list" aria-label="Folders">
        {folders.length === 0 && <li className="list__item muted">No folders inside.</li>}
        {folders.map((f) => (
          <li key={f.id}>
            <button className="list__item picker-item" onClick={() => setAt(f.id)}>
              <FileIcon kind="folder" name={f.name} />
              <span className="list__body list__title">{f.name}</span>
              <Icon name="i-chev-r" className="faint" />
            </button>
          </li>
        ))}
      </ul>
      {!writable && q.data && <p className="field__error">You can't add files to this folder.</p>}
    </Dialog>
  );
}
