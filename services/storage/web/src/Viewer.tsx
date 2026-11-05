// The full-window file viewer: title bar, next/previous through the folder,
// keyboard shortcuts, and one body per kind of file.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { download, type Node, nodeUrl, type Source } from "./api";
import { bytes, when } from "./format";
import { FileIcon, Icon, typing, useFocusTrap } from "./ui";
import { ArchiveView, CodeView, CsvView, Fallback, ImageView, MarkdownView, MediaView, OfficeView, PdfView, type ViewerProps } from "./viewers";

export interface ViewerShellProps {
  src: Source;
  node: Node;
  /** The files of the folder, in display order, for next and previous. */
  siblings: Node[];
  onClose: () => void;
  onNavigate: (id: string) => void;
  /** Extra buttons for the bar (Share, Details). */
  actions?: ReactNode;
  /** A side panel (details), shown to the right of the stage. */
  panel?: ReactNode;
  textCap: number;
  backLabel: string;
}

function body(p: ViewerProps) {
  switch (p.node.kind) {
    case "image":
      return <ImageView {...p} />;
    case "video":
    case "audio":
      return <MediaView {...p} />;
    case "pdf":
      return <PdfView {...p} />;
    case "office":
      return <OfficeView {...p} />;
    case "markdown":
      return <MarkdownView {...p} />;
    case "csv":
      return <CsvView {...p} />;
    case "code":
    case "text":
    case "json":
      return <CodeView {...p} />;
    case "archive":
      return <ArchiveView {...p} />;
    default:
      return <Fallback src={p.src} node={p.node} />;
  }
}

const media = (k: string) => k === "image" || k === "video" || k === "audio";

export function Viewer({ src, node, siblings, onClose, onNavigate, actions, panel, textCap, backLabel }: ViewerShellProps) {
  const [controls, setControlsState] = useState<ReactNode>(null);
  const setControls = useCallback((c: ReactNode) => setControlsState(c), []);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  const files = siblings.filter((n) => !n.isDir);
  const idx = files.findIndex((n) => n.id === node.id);
  const prev = idx > 0 ? files[idx - 1] : undefined;
  const next = idx >= 0 && idx < files.length - 1 ? files[idx + 1] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".overlay")) {
        e.preventDefault();
        onClose();
        return;
      }
      if (typing(e) || e.altKey || e.metaKey || e.ctrlKey) return;
      // Media keeps arrow keys for seeking when the player has focus.
      if ((e.target as HTMLElement).tagName === "VIDEO" || (e.target as HTMLElement).tagName === "AUDIO") return;
      if (e.key === "ArrowLeft" && prev) onNavigate(prev.id);
      else if (e.key === "ArrowRight" && next) onNavigate(next.id);
      else if (e.key === "d") download(nodeUrl(src, node.id, "content"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onNavigate, onClose, src, node.id]);

  useEffect(() => {
    document.title = `${node.name} – Storage`;
  }, [node.name]);

  const docKind = !media(node.kind) && node.kind !== "pdf" && node.kind !== "office";
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={node.name} ref={ref} tabIndex={-1}>
      <div className="viewer__bar">
        <button className="btn btn--quiet btn--icon" aria-label={`Back to ${backLabel}`} title="Close (Esc)" onClick={onClose}>
          <Icon name="i-arrow-l" />
        </button>
        <div className="viewer__title">
          <FileIcon kind={node.kind} name={node.name} className="hide-sm" />
          <span className="truncate" title={node.name}>
            {node.name}
          </span>
          <span className="faint text-2 hide-sm viewer__meta">
            {bytes(node.size)}, {when(node.modifiedAt).toLowerCase().replace(/^today/, "today")}
          </span>
        </div>
        {files.length > 1 && idx >= 0 && (
          <span className="viewer__pager hide-sm" aria-live="polite">
            {idx + 1} of {files.length}
          </span>
        )}
        {controls}
        {actions}
        <button className="btn" onClick={() => download(nodeUrl(src, node.id, "content"))} title="Download (D)">
          <Icon name="i-download" />
          <span className="hide-sm">Download</span>
        </button>
      </div>
      <div className={`viewer__main${panel ? " has-panel" : ""}`}>
        <div className={`viewer__stage ${media(node.kind) ? "viewer__stage--media" : "viewer__stage--doc"}${docKind ? " is-doc" : ""}`}>
          {body({ src, node, setControls, textCap })}
          {prev && (
            <button className="viewer__nav viewer__nav--prev" aria-label={`Previous: ${prev.name}`} title="Previous (←)" onClick={() => onNavigate(prev.id)}>
              <Icon name="i-chev-l" />
            </button>
          )}
          {next && (
            <button className="viewer__nav viewer__nav--next" aria-label={`Next: ${next.name}`} title="Next (→)" onClick={() => onNavigate(next.id)}>
              <Icon name="i-chev-r" />
            </button>
          )}
        </div>
        {panel}
      </div>
    </div>
  );
}
