import { memo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type { ContentSource, EntryKind, PreviewKind } from "../api";
import { formatBytes, formatWhen } from "../format";
import { filesHref } from "../paths";
import { entryIcon, FolderIcon, Icon } from "../ui/icons";
import { Menu, type MenuItem } from "../ui/Menu";
import type { UploadItem } from "../uploads/machine";
import { statusText, UploadBar } from "./Tray";

export interface Row {
  path: string;
  name: string;
  kind: EntryKind;
  size: number;
  modTime: Date;
  /** null is "not previewable" in a listing, and "not known yet" for a search hit. */
  preview: PreviewKind | null;
  /** The folder a search hit lives in. */
  where: string | null;
}

export function sizeWord(row: Row): string {
  switch (row.kind) {
    case "dir":
      return "Folder";
    case "symlink":
      return "Symlink";
    case "other":
      return "Unreadable name";
    case "file":
      return formatBytes(row.size);
  }
}

function RowIcon({ row, source }: { row: Row; source: ContentSource }) {
  const [broken, setBroken] = useState(false);
  if (row.kind === "dir") return <FolderIcon />;
  if (row.preview === "image" && !broken) {
    return <img className="thumb" src={source.thumbUrl(row.path, 256)} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />;
  }
  return <Icon name={entryIcon(row)} />;
}

export interface RowHandlers {
  onRowClick: (e: MouseEvent, row: Row) => void;
  onCheck: (e: MouseEvent, row: Row) => void;
  onOpen: (e: MouseEvent, row: Row) => void;
  onLongPress: (row: Row) => void;
  onDragStart: (e: DragEvent, row: Row) => void;
  menuFor: (row: Row) => MenuItem[];
  onRenameDone: (row: Row, name: string | null) => void;
  onRowFocus: (row: Row) => void;
}

const LONG_PRESS_MS = 500;

/** Lifting the finger after a long press still clicks, on whatever is under it by then. */
let releaseClickPending = false;

function usePress(row: Row, onLongPress: (row: Row) => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };
  return {
    bind: {
      onPointerDown: (e: PointerEvent) => {
        releaseClickPending = false;
        if (e.pointerType !== "touch") return;
        start.current = { x: e.clientX, y: e.clientY };
        timer.current = window.setTimeout(() => {
          releaseClickPending = true;
          onLongPress(row);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e: PointerEvent) => {
        if (start.current !== null && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
  };
}

function RenameInput({ row, onDone }: { row: Row; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(row.name);
  const dot = row.kind === "dir" ? -1 : row.name.lastIndexOf(".");
  return (
    <input
      className="rename"
      aria-label={`New name for ${row.name}`}
      value={value}
      autoFocus
      onFocus={(e) => e.target.setSelectionRange(0, dot > 0 ? dot : row.name.length)}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value.trim() === row.name || value.trim() === "" ? null : value.trim());
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

export const FileRow = memo(function FileRow({
  row,
  source,
  selected,
  focused,
  renaming,
  dropTarget,
  now,
  handlers,
  registerRow,
}: {
  row: Row;
  source: ContentSource;
  selected: boolean;
  focused: boolean;
  renaming: boolean;
  dropTarget: boolean;
  now: Date;
  handlers: RowHandlers;
  registerRow: (path: string, el: HTMLDivElement | null) => void;
}) {
  const press = usePress(row, handlers.onLongPress);
  const unreadable = row.kind === "symlink" || row.kind === "other";
  const when = formatWhen(row.modTime, now);
  const sub = row.where === null ? `${sizeWord(row)}, ${when}` : `${row.where === "" ? "Files" : row.where}, ${sizeWord(row)}`;
  return (
    <div
      ref={(el) => registerRow(row.path, el)}
      className={dropTarget ? "row droptarget" : "row"}
      role="row"
      aria-selected={selected}
      data-path={row.path}
      tabIndex={focused ? 0 : -1}
      draggable={!renaming}
      {...(row.kind === "dir" ? { "data-drop-dir": row.path, "data-drop-name": row.name } : {})}
      {...press.bind}
      onClickCapture={(e) => {
        if (releaseClickPending) {
          releaseClickPending = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={(e) => handlers.onRowClick(e, row)}
      onFocus={(e) => {
        if (e.target === e.currentTarget) handlers.onRowFocus(row);
      }}
      onContextMenu={(e) => {
        if (releaseClickPending) e.preventDefault();
      }}
      onDragStart={(e) => handlers.onDragStart(e, row)}
    >
      <div className="sel" role="gridcell" onClick={(e) => handlers.onCheck(e, row)}>
        <span className={selected ? "cb on" : "cb"} role="checkbox" aria-checked={selected} aria-label={`Select ${row.name}`}>
          <Icon name="check" />
        </span>
      </div>
      <div className="name" role="gridcell">
        <RowIcon row={row} source={source} />
        <div className="txt">
          {renaming ? (
            <RenameInput row={row} onDone={(name) => handlers.onRenameDone(row, name)} />
          ) : row.kind === "dir" ? (
            <a className="t" href={filesHref(row.path)} tabIndex={-1} draggable={false} onClick={(e) => handlers.onOpen(e, row)}>
              {row.name}
            </a>
          ) : unreadable ? (
            <span className="t">{row.name}</span>
          ) : (
            <button className="t" type="button" tabIndex={-1} onClick={(e) => handlers.onOpen(e, row)}>
              {row.name}
            </button>
          )}
          <span className="sub">{sub}</span>
        </div>
      </div>
      <div className="cell" role="gridcell" {...(row.where === null ? {} : { title: row.where })}>
        {row.where === null ? when : row.where === "" ? "Files" : row.where}
      </div>
      <div className="cell right" role="gridcell">
        {sizeWord(row)}
      </div>
      <div className="more-cell" role="gridcell" onClick={(e) => e.stopPropagation()}>
        <Menu label={`More for ${row.name}`} items={handlers.menuFor(row)} tabIndex={focused ? 0 : -1} />
      </div>
    </div>
  );
});

export function GhostRow({ item }: { item: UploadItem }) {
  const warn = item.state.tag === "paused" || item.state.tag === "reconnecting" || item.state.tag === "failed";
  return (
    <div className="row ghost" role="row" data-ghost={item.path}>
      <div className="sel" role="gridcell" />
      <div className="name" role="gridcell">
        <Icon name={entryIcon({ name: item.name, kind: "file" })} />
        <div className="txt">
          <span className="t">{item.name}</span>
          <span className={warn ? "sub warn-text" : "sub"}>{statusText(item)}</span>
        </div>
      </div>
      <div className={warn ? "cell span warn" : "cell span"} role="gridcell">
        {statusText(item)}
      </div>
      <UploadBar item={item} />
    </div>
  );
}

export function ListKeys({ onKeyDown, children }: { onKeyDown: (e: KeyboardEvent) => void; children: ReactNode }) {
  return (
    <div className="list" role="grid" aria-multiselectable="true" aria-label="Files" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
