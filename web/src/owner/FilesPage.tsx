import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { owner, postDownload, type Listing, type SearchEnd } from "../api";
import { formatBytes, plural } from "../format";
import { baseName, crumbs, displayOrder, filesHref, join, parent } from "../paths";
import { noSelection, selectedInOrder, selectionReducer, type Selection, type SelectionAction } from "../selection";
import { Preview, type PreviewItem } from "../preview/Preview";
import { useBackDismiss, useLoad, useNow, usePhone, useTitle } from "../ui/hooks";
import { FolderIcon, Icon } from "../ui/icons";
import type { MenuItem } from "../ui/Menu";
import { followLink, navigate } from "../ui/router";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { pickedFromInput, readDrop, type Dropped } from "../uploads/dropped";
import { FileRow, GhostRow, ListKeys, type Row, type RowHandlers } from "./FileList";
import { MoveSheet } from "./MoveSheet";
import { useCopyLink, ShareSheet, type ShareTarget } from "./ShareSheet";
import { useShell } from "./Shell";
import { PhoneTray, useUploads } from "./Tray";
import { errorText, wordsFor } from "./words";

const MOVE_TYPE = "application/x-storage-move";

type Modal =
  | { tag: "none" }
  | { tag: "newFolder" }
  | { tag: "share"; target: ShareTarget }
  | { tag: "move"; paths: string[] };

type DragState = { kind: "files" | "move"; dir: string; dirName: string };

function rowsOf(listing: Listing): Row[] {
  return displayOrder(listing.entries).map((e) => ({ path: join(listing.path, e.name), name: e.name, kind: e.kind, size: e.size, modTime: e.modTime, preview: e.preview, where: null }));
}

type SearchState = { hits: Row[]; end: SearchEnd | null; failed: string | null };

function useSearch(q: string, path: string, run: number): SearchState {
  const [state, setState] = useState<SearchState>({ hits: [], end: null, failed: null });
  useEffect(() => {
    setState({ hits: [], end: null, failed: null });
    if (q === "") return;
    const stop = new AbortController();
    owner
      .search(
        q,
        path,
        (hit) => {
          const row: Row = { path: hit.path, name: hit.name, kind: hit.kind, size: hit.size, modTime: hit.modTime, preview: hit.preview, where: parent(hit.path) };
          setState((s) => ({ ...s, hits: [...s.hits, row] }));
        },
        stop.signal,
      )
      .then(
        (end) => setState((s) => ({ ...s, end })),
        (err: unknown) => {
          if (!stop.signal.aborted) setState((s) => ({ ...s, failed: errorText(err) }));
        },
      );
    return () => stop.abort();
  }, [q, path, run]);
  return state;
}

function NewFolderSheet({ dir, onDone, onClose }: { dir: string; onDone: () => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title="New folder" onClose={onClose}>
      <h2>New folder</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          owner.mkdir(join(dir, name.trim())).then(
            () => {
              onDone();
              onClose();
            },
            (err: unknown) => setError(errorText(err)),
          );
        }}
      >
        <div className="sheet-field">
          <label className="lbl" htmlFor="folder-name">
            Name
          </label>
          <div className="field">
            <input id="folder-name" value={name} autoFocus required onChange={(e) => setName(e.target.value)} />
          </div>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="sheet-actions">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit">
            Create folder
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function DropRing({ drag, count }: { drag: DragState; count: number }) {
  return (
    <div className="dropring">
      <p>{drag.kind === "files" ? `Drop to upload into ${drag.dirName}` : `Move ${plural(count, "item")} into ${drag.dirName}`}</p>
    </div>
  );
}

export function FilesPage({ path, q }: { path: string; q: string }) {
  const { engine, refreshCounts } = useShell();
  const toast = useToast();
  const copyLink = useCopyLink();
  const uploads = useUploads(engine);
  const now = useNow();
  const phone = usePhone();
  const listing = useLoad(`list:${path}`, () => owner.list(path));
  const [searchRun, setSearchRun] = useState(0);
  const search = useSearch(q, path, searchRun);
  const searching = q !== "";
  const folderName = path === "" ? "Files" : baseName(path);
  useTitle(searching ? `Search: ${q}` : folderName);

  const rows = useMemo<Row[]>(() => {
    if (searching) return search.hits;
    return listing.state.tag === "ready" ? rowsOf(listing.state.value) : [];
  }, [searching, search.hits, listing.state]);
  const order = useMemo(() => rows.map((r) => r.path), [rows]);
  const orderRef = useRef(order);
  orderRef.current = order;

  const [selection, dispatch] = useReducer(
    (s: Selection, a: SelectionAction) => selectionReducer(s, a, orderRef.current),
    noSelection,
  );
  const selected = useMemo(() => selectedInOrder(selection, order), [selection, order]);
  const [modal, setModal] = useState<Modal>({ tag: "none" });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<{ items: PreviewItem[]; index: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const moveFocus = useRef(false);
  const dragPaths = useRef<string[]>([]);
  const picker = useRef<HTMLInputElement>(null);

  useBackDismiss(selection.touchMode, () => dispatch({ type: "clear" }));

  useEffect(() => dispatch({ type: "clear" }), [path, q]);
  useEffect(() => dispatch({ type: "prune" }), [order]);

  useEffect(() => {
    if (moveFocus.current && selection.focus !== null) {
      rowEls.current.get(selection.focus)?.focus();
      rowEls.current.get(selection.focus)?.scrollIntoView({ block: "nearest" });
    }
    moveFocus.current = false;
  }, [selection.focus]);

  const ghosts = uploads.filter((u) => u.state.tag !== "done" && parent(u.path) === path);
  const finishedHere = uploads.filter((u) => u.state.tag === "done" && (path === "" || u.path.startsWith(`${path}/`))).length;
  useEffect(() => {
    if (finishedHere > 0) void listing.reload();
  }, [finishedHere, listing.reload]);

  const refresh = useCallback(() => {
    void listing.reload();
    setSearchRun((n) => n + 1);
    refreshCounts();
  }, [listing.reload, refreshCounts]);

  const report = useCallback(
    (verb: string, failures: { path: string; error: string }[], total: number) => {
      const first = failures[0];
      if (first !== undefined) toast({ text: `${failures.length} of ${total} could not be ${verb}. ${wordsFor(first.error)}.` });
    },
    [toast],
  );

  const trash = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        const results = await owner.trash(paths);
        const ids = results.flatMap((r) => ("ok" in r ? [r.ok] : []));
        report("trashed", results.flatMap((r) => ("error" in r ? [r] : [])), paths.length);
        dispatch({ type: "clear" });
        refresh();
        if (ids.length > 0) {
          toast({
            text: `${plural(ids.length, "item")} in Trash`,
            ms: 8000,
            action: {
              label: "Undo",
              run: () => {
                void Promise.all(ids.map((id) => owner.restore(id))).then(refresh, (err: unknown) => toast({ text: errorText(err) }));
              },
            },
          });
        }
      } catch (err) {
        toast({ text: errorText(err) });
      }
    },
    [refresh, report, toast],
  );

  const move = useCallback(
    async (paths: string[], to: string) => {
      try {
        const results = await owner.move(paths, to);
        report("moved", results.flatMap((r) => ("error" in r ? [r] : [])), paths.length);
        dispatch({ type: "clear" });
        refresh();
      } catch (err) {
        toast({ text: errorText(err) });
      }
    },
    [refresh, report, toast],
  );

  const download = useCallback((paths: string[], rowsNow: readonly Row[]) => {
    const only = paths.length === 1 ? rowsNow.find((r) => r.path === paths[0]) : undefined;
    if (only?.kind === "file") {
      const a = document.createElement("a");
      a.href = owner.source.downloadUrl(only.path);
      a.download = only.name;
      a.click();
    } else if (paths.length > 0) {
      postDownload(owner.zipUrl, paths);
    }
  }, []);

  const open = useCallback(
    async (row: Row, rowsNow: readonly Row[]) => {
      if (row.kind === "dir") {
        navigate(filesHref(row.path));
        return;
      }
      if (row.kind !== "file") {
        toast({ text: row.kind === "symlink" ? "Symlinks can't be opened" : "The server can't read this name" });
        return;
      }
      const hit = row.where !== null;
      const kind = row.preview;
      if (kind === null) {
        download([row.path], rowsNow);
        return;
      }
      if (hit) {
        setPreviewing({ items: [{ path: row.path, name: row.name, size: row.size, kind }], index: 0 });
        return;
      }
      const items = rowsNow.flatMap((r): PreviewItem[] => (r.preview === null ? [] : [{ path: r.path, name: r.name, size: r.size, kind: r.preview }]));
      setPreviewing({ items, index: items.findIndex((i) => i.path === row.path) });
    },
    [download, toast],
  );

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const touchModeRef = useRef(selection.touchMode);
  touchModeRef.current = selection.touchMode;

  const shareRow = useCallback((row: Pick<Row, "path" | "name" | "kind">) => {
    setPreviewing(null);
    setModal({ tag: "share", target: { path: row.path, name: row.name, isFolder: row.kind === "dir" } });
  }, []);

  const handlers = useMemo<RowHandlers>(
    () => ({
      onRowClick: (e, row) => {
        if (e.shiftKey) dispatch({ type: "extend", id: row.path });
        else if (e.ctrlKey || e.metaKey) dispatch({ type: "toggle", id: row.path });
        else if (touchModeRef.current) dispatch({ type: "toggle", id: row.path });
        else dispatch({ type: "focus", id: row.path });
      },
      onCheck: (e, row) => {
        e.stopPropagation();
        const touch = (e.nativeEvent as PointerEvent).pointerType === "touch";
        if (e.shiftKey) dispatch({ type: "extend", id: row.path });
        else if (touch && !touchModeRef.current) dispatch({ type: "longPress", id: row.path });
        else dispatch({ type: "toggle", id: row.path });
      },
      onOpen: (e, row) => {
        e.preventDefault();
        if (e.shiftKey || e.ctrlKey || e.metaKey || touchModeRef.current) return;
        e.stopPropagation();
        void open(row, rowsRef.current);
      },
      onLongPress: (row) => dispatch({ type: "longPress", id: row.path }),
      onRowFocus: (row) => dispatch({ type: "focus", id: row.path }),
      onDragStart: (e, row) => {
        const paths = selectedRef.current.includes(row.path) ? selectedRef.current : [row.path];
        dragPaths.current = paths;
        e.dataTransfer.setData(MOVE_TYPE, JSON.stringify(paths));
        e.dataTransfer.effectAllowed = "move";
      },
      menuFor: (row) => {
        const items: MenuItem[] = [];
        if (row.kind === "file" || row.kind === "dir") {
          items.push({ label: "Open", icon: "open", run: () => void open(row, rowsRef.current) });
          items.push({ label: row.kind === "dir" ? "Download zip" : "Download", icon: "download", run: () => download([row.path], rowsRef.current) });
          items.push({ label: "Share", icon: "link", run: () => shareRow(row) });
        }
        items.push({ label: "Rename", icon: "rename", run: () => setRenaming(row.path) });
        items.push({ label: "Move", icon: "move", run: () => setModal({ tag: "move", paths: [row.path] }) });
        items.push({ label: "Trash", icon: "trash", danger: true, run: () => void trash([row.path]) });
        return items;
      },
      onRenameDone: (row, name) => {
        setRenaming(null);
        rowEls.current.get(row.path)?.focus();
        if (name === null) return;
        owner.rename(row.path, name).then(refresh, (err: unknown) => toast({ text: errorText(err) }));
      },
    }),
    [download, open, refresh, shareRow, toast, trash],
  );
  const registerRow = useCallback((rowPath: string, el: HTMLDivElement | null) => {
    if (el === null) rowEls.current.delete(rowPath);
    else rowEls.current.set(rowPath, el);
  }, []);

  const onListKey = (e: KeyboardEvent) => {
    if (renaming !== null) return;
    const { focus } = selection;
    const row = rows.find((r) => r.path === focus);
    const mod = e.ctrlKey || e.metaKey;
    const moveTo = (to: "up" | "down" | "home" | "end") => {
      moveFocus.current = true;
      dispatch({ type: "move", to, extend: e.shiftKey });
    };
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo("down"),
      ArrowUp: () => moveTo("up"),
      Home: () => moveTo("home"),
      End: () => moveTo("end"),
      " ": () => {
        if (row !== undefined) dispatch({ type: "toggle", id: row.path });
      },
      Enter: () => {
        if (row !== undefined) void open(row, rows);
      },
      Backspace: () => {
        if (path !== "") navigate(filesHref(parent(path)));
      },
      Delete: () => void trash(selected.length > 0 ? selected : row === undefined ? [] : [row.path]),
      F2: () => {
        if (row !== undefined) setRenaming(row.path);
      },
      Escape: () => dispatch({ type: "clear" }),
    };
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      keys.Backspace?.();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      dispatch({ type: "all" });
      return;
    }
    if (mod && e.key.toLowerCase() === "c" && selected.length === 1) {
      e.preventDefault();
      owner.shares().then(
        (shares) => {
          const link = shares.find((s) => s.path === selected[0] && s.state === "active");
          if (link === undefined) toast({ text: "This item has no live link" });
          else void copyLink(link.url);
        },
        (err: unknown) => toast({ text: errorText(err) }),
      );
      return;
    }
    if (mod || (e.target as HTMLElement).closest(".menu") !== null) return;
    const run = keys[e.key];
    if (run !== undefined) {
      e.preventDefault();
      run();
    }
  };

  const addDropped = useCallback(
    (dropped: Dropped, dir: string) => {
      for (const folder of dropped.emptyFolders) void owner.mkdir(join(dir, folder)).then(refresh);
      engine.add(dropped.files.map((f) => ({ ...f, relativePath: join(dir, f.relativePath) })));
    },
    [engine, refresh],
  );

  useEffect(() => {
    const here = { dir: path, dirName: folderName };
    const targetOf = (e: globalThis.DragEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-drop-dir]");
      return el?.dataset.dropDir === undefined ? here : { dir: el.dataset.dropDir, dirName: el.dataset.dropName ?? "" };
    };
    const kindOf = (e: globalThis.DragEvent) => {
      const types = e.dataTransfer?.types ?? [];
      if (types.includes(MOVE_TYPE)) return "move" as const;
      return types.includes("Files") ? ("files" as const) : null;
    };
    const over = (e: globalThis.DragEvent) => {
      const kind = kindOf(e);
      if (kind === null) return;
      e.preventDefault();
      const target = targetOf(e);
      setDrag((d) => (d?.kind === kind && d.dir === target.dir ? d : { kind, ...target }));
    };
    const leave = (e: globalThis.DragEvent) => {
      if (e.relatedTarget === null) setDrag(null);
    };
    const drop = (e: globalThis.DragEvent) => {
      const kind = kindOf(e);
      setDrag(null);
      if (kind === null || e.dataTransfer === null) return;
      e.preventDefault();
      const { dir } = targetOf(e);
      if (kind === "move") {
        if (dir !== parent(dragPaths.current[0] ?? "") && !dragPaths.current.includes(dir)) void move(dragPaths.current, dir);
        return;
      }
      void readDrop(e.dataTransfer).then((dropped) => addDropped(dropped, dir));
    };
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  }, [addDropped, folderName, move, path]);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    engine.add(pickedFromInput(e.target).map((f) => ({ ...f, relativePath: join(path, f.relativePath) })));
    e.target.value = "";
  };

  const failed = !searching && listing.state.tag === "failed" ? errorText(listing.state.error) : null;
  const ready = searching ? search.end !== null : listing.state.tag === "ready";
  const fileBytes = rows.reduce((sum, r) => sum + (r.kind === "file" ? r.size : 0), 0);
  const meta = searching
    ? `${search.end === null ? "Searching" : plural(rows.length, "result")}${path === "" ? "" : ` in ${folderName}`}${search.end?.truncated ? ", showing the first 1000" : ""}`
    : rows.length === 0
      ? "Empty folder"
      : `${plural(rows.length, "item")}, ${formatBytes(fileBytes)}`;
  const single = selected.length === 1 ? rows.find((r) => r.path === selected[0]) : undefined;
  const canShare = single !== undefined && (single.kind === "file" || single.kind === "dir");
  const dropDir = drag?.dir;

  return (
    <div className={selection.touchMode ? "files selecting" : "files"}>
      <div className="place">
        <nav className="crumbs" aria-label="Path">
          {path !== "" && (
            <a className="up-one" href={filesHref(parent(path))} data-drop-dir={parent(path)} data-drop-name={parent(path) === "" ? "Files" : baseName(parent(path))} onClick={(e) => followLink(e, filesHref(parent(path)))}>
              <Icon name="chevronLeft" size={16} />
              {parent(path) === "" ? "Files" : baseName(parent(path))}
            </a>
          )}
          <span className="trail">
            <a href={filesHref("")} data-drop-dir="" data-drop-name="Files" className={dropDir === "" && path !== "" ? "hot" : ""} onClick={(e) => followLink(e, filesHref(""))}>
              Files
            </a>
            {crumbs(path).slice(0, -1).map((c) => (
              <span key={c.path} className="crumb">
                <Icon name="chevronRight" size={16} className="sep" />
                <a href={filesHref(c.path)} data-drop-dir={c.path} data-drop-name={c.name} className={dropDir === c.path ? "hot" : ""} onClick={(e) => followLink(e, filesHref(c.path))}>
                  {c.name}
                </a>
              </span>
            ))}
            {path !== "" && <Icon name="chevronRight" size={16} className="sep" />}
          </span>
        </nav>
        <div className="place-row">
          <div className="place-name">
            <h1>{searching ? `Results for ${q}` : folderName}</h1>
            <p className="meta" data-testid="folder-meta">{meta}</p>
          </div>
          <div className="actions">
            {selection.touchMode ? (
              <button className="btn" type="button" onClick={() => dispatch({ type: "all" })}>
                Select all
              </button>
            ) : (
              <>
                <button className="btn" type="button" aria-label="New folder" onClick={() => setModal({ tag: "newFolder" })}>
                  <Icon name="plus" />
                  <span className="label">New folder</span>
                </button>
                <button className="btn primary" type="button" onClick={() => picker.current?.click()}>
                  <Icon name="upload" />
                  Upload
                </button>
              </>
            )}
            <input ref={picker} className="sr" type="file" multiple tabIndex={-1} aria-label="Files to upload" onChange={onPick} />
          </div>
        </div>
      </div>

      {phone && <PhoneTray engine={engine} />}

      {failed !== null ? (
        <div className="list">
          <div className="empty">
            <h2>This folder can't be opened</h2>
            <p>{failed}.</p>
            <div className="cta">
              <a className="btn" href="/files/" onClick={(e) => followLink(e, "/files/")}>
                <Icon name="chevronLeft" />
                Back to files
              </a>
            </div>
          </div>
        </div>
      ) : search.failed !== null ? (
        <div className="list">
          <div className="empty">
            <h2>Search stopped</h2>
            <p>{search.failed}.</p>
          </div>
        </div>
      ) : !ready && rows.length === 0 ? (
        <div className="list">
          <p className="loading-line">{searching ? "Searching" : "Loading"}</p>
        </div>
      ) : rows.length === 0 && ghosts.length === 0 ? (
        <div className="list">
          {searching ? (
            <div className="empty">
              <Icon name="search" size={40} className="glyph" />
              <h2>No names match {q}</h2>
              <p>Search looks at file and folder names, not what is inside them.</p>
            </div>
          ) : (
            <div className="empty">
              <div className="glyph">
                <FolderIcon size={40} />
              </div>
              <h2>Nothing in {folderName} yet</h2>
              <p>Drop files or folders anywhere on this page to upload them here.</p>
              <div className="cta">
                <button className="btn primary" type="button" onClick={() => picker.current?.click()}>
                  <Icon name="upload" />
                  Upload
                </button>
                <button className="btn" type="button" onClick={() => setModal({ tag: "newFolder" })}>
                  <Icon name="plus" />
                  New folder
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <ListKeys onKeyDown={onListKey}>
          <div className="head" role="row">
            <div role="columnheader" className="sel-head">
              <button
                type="button"
                className={rows.length > 0 && selected.length === rows.length ? "cb on" : "cb"}
                role="checkbox"
                aria-checked={rows.length > 0 && selected.length === rows.length}
                aria-label="Select all"
                tabIndex={-1}
                onClick={() => dispatch({ type: selected.length === rows.length ? "clear" : "all" })}
              >
                <Icon name="check" />
              </button>
            </div>
            <div role="columnheader">Name</div>
            <div role="columnheader">{searching ? "Folder" : "Modified"}</div>
            <div role="columnheader" className="right">
              Size
            </div>
            <div role="columnheader" aria-label="Actions" />
          </div>
          {rows.map((row, i) => (
            <FileRow
              key={row.path}
              row={row}
              source={owner.source}
              selected={selection.ids.has(row.path)}
              focused={selection.focus === row.path || (selection.focus === null && i === 0)}
              renaming={renaming === row.path}
              dropTarget={dropDir === row.path}
              now={now}
              handlers={handlers}
              registerRow={registerRow}
            />
          ))}
          {!searching && ghosts.map((item) => <GhostRow key={item.id} item={item} />)}
        </ListKeys>
      )}

      {selected.length > 0 && (
        <div
          className="selbar"
          role="toolbar"
          aria-label="Selection"
          onKeyDown={(e) => {
            if (e.key === "Escape") dispatch({ type: "clear" });
          }}
        >
          <span className="count">{selected.length} selected</span>
          <button className="btn" type="button" aria-label="Download zip" onClick={() => download(selected, rows)}>
            <Icon name="download" />
            <span className="label">Download zip</span>
          </button>
          <button className="btn" type="button" aria-label="Share" disabled={!canShare} title={canShare ? undefined : "Select one item to share"} onClick={() => single !== undefined && shareRow(single)}>
            <Icon name="link" />
            <span className="label">Share</span>
          </button>
          <button className="btn" type="button" aria-label="Move" onClick={() => setModal({ tag: "move", paths: selected })}>
            <Icon name="move" />
            <span className="label">Move</span>
          </button>
          <button className="btn" type="button" aria-label="Trash" onClick={() => void trash(selected)}>
            <Icon name="trash" />
            <span className="label">Trash</span>
          </button>
          <button className="btn" type="button" aria-label="Clear selection" onClick={() => dispatch({ type: "clear" })}>
            <Icon name="close" />
          </button>
        </div>
      )}

      {drag !== null && <DropRing drag={drag} count={dragPaths.current.length} />}

      {previewing !== null && (
        <Preview
          items={previewing.items}
          index={previewing.index}
          source={owner.source}
          onIndex={(index) => setPreviewing((p) => (p === null ? p : { ...p, index }))}
          onClose={() => setPreviewing(null)}
          onShare={(item) => shareRow({ path: item.path, name: item.name, kind: "file" })}
        />
      )}
      {modal.tag === "newFolder" && <NewFolderSheet dir={path} onDone={refresh} onClose={() => setModal({ tag: "none" })} />}
      {modal.tag === "share" && <ShareSheet target={modal.target} onCreated={refreshCounts} onClose={() => setModal({ tag: "none" })} />}
      {modal.tag === "move" && <MoveSheet paths={modal.paths} from={path} onMove={(to) => void move(modal.paths, to)} onClose={() => setModal({ tag: "none" })} />}
    </div>
  );
}

