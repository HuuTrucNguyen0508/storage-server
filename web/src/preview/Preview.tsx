import { lazy, Suspense, useCallback, useEffect, useRef, useState, type TouchEvent } from "react";
import { ApiError, type ContentSource, type PreviewKind } from "../api";
import { formatBytes, formatDuration, plural } from "../format";
import { isMarkdown } from "../paths";
import { Icon } from "../ui/icons";
import { Markdown } from "../ui/Markdown";
import { ZoomImage } from "./ZoomImage";

const PdfView = lazy(() => import("./PdfView"));

export interface PreviewItem {
  path: string;
  name: string;
  size: number;
  kind: PreviewKind;
}

const TEXT_LIMIT = 2 * 1024 * 1024;

function failureText(err: unknown): string {
  if (err instanceof ApiError && err.status === 410) return "This link can't open any more files.";
  return "This file could not be read. Download it instead.";
}

function TextView({ url, markdown, size }: { url: string; markdown: boolean; size: number }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    setText(null);
    setFailed(null);
    fetch(url, { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` }, signal: stop.signal })
      .then(async (res) => {
        if (!res.ok && res.status !== 416) throw new ApiError(res.status, "preview", res.statusText);
        setText(res.status === 416 ? "" : await res.text());
      })
      .catch((err: unknown) => {
        if (!stop.signal.aborted) setFailed(failureText(err));
      });
    return () => stop.abort();
  }, [url]);
  if (failed !== null) return <p className="stage-note">{failed}</p>;
  if (text === null) return <p className="stage-note">Loading</p>;
  return (
    <div className="doc" tabIndex={0}>
      {markdown ? <Markdown source={text} /> : <pre>{text}</pre>}
      {size > TEXT_LIMIT && <p className="doc-more">Showing the first {formatBytes(TEXT_LIMIT)} of {formatBytes(size)}.</p>}
    </div>
  );
}

export function Preview({
  items,
  index,
  source,
  onIndex,
  onClose,
  onShare,
}: {
  items: readonly PreviewItem[];
  index: number;
  source: ContentSource;
  onIndex: (index: number) => void;
  onClose: () => void;
  onShare?: (item: PreviewItem) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [facts, setFacts] = useState("");
  const swipeFrom = useRef<number | null>(null);
  const item = items[index];

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => setFacts(""), [index]);

  const step = useCallback(
    (delta: 1 | -1) => {
      const next = index + delta;
      if (next >= 0 && next < items.length) onIndex(next);
    },
    [index, items.length, onIndex],
  );

  const onPages = useCallback((pages: number) => setFacts(plural(pages, "page")), []);

  if (item === undefined) return null;

  const swipe = {
    onTouchStart: (e: TouchEvent) => {
      swipeFrom.current = e.touches.length === 1 ? (e.touches[0]?.clientX ?? null) : null;
    },
    onTouchEnd: (e: TouchEvent) => {
      const from = swipeFrom.current;
      const to = e.changedTouches[0]?.clientX;
      if (from !== null && to !== undefined && Math.abs(to - from) > 60) step(to < from ? 1 : -1);
    },
  };

  const url = source.contentUrl(item.path);
  const position = items.length > 1 ? `${index + 1} of ${items.length}` : "";
  const line = [formatBytes(item.size), facts, position].filter((part) => part !== "").join(", ");

  return (
    <dialog
      ref={ref}
      className="overlay"
      aria-label={`Preview of ${item.name}`}
      onClose={onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "ArrowLeft") step(-1);
        if (e.key === "ArrowRight") step(1);
      }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target === ref.current || target.classList.contains("stage")) ref.current?.close();
      }}
    >
      <header className="bar-top">
        <button className="btn icon" type="button" aria-label="Close preview" onClick={() => ref.current?.close()}>
          <Icon name="close" />
        </button>
        <p className="t">
          <span className="name">{item.name}</span>
          <span className="s">{line}</span>
        </p>
        {onShare !== undefined && (
          <button className="btn" type="button" onClick={() => onShare(item)}>
            <Icon name="link" />
            <span className="label">Share</span>
          </button>
        )}
        <a className="btn" href={source.downloadUrl(item.path)} download={item.name}>
          <Icon name="download" />
          <span className="label">Download</span>
        </a>
      </header>
      <div className="stage" {...(item.kind === "image" ? {} : swipe)}>
        {item.kind === "image" && <ZoomImage key={item.path} src={url} alt={item.name} onFacts={setFacts} onSwipe={step} />}
        {item.kind === "video" && (
          <video key={item.path} src={url} controls playsInline onLoadedMetadata={(e) => setFacts(`${formatDuration(e.currentTarget.duration)}, ${e.currentTarget.videoWidth} by ${e.currentTarget.videoHeight}`)} />
        )}
        {item.kind === "audio" && <audio key={item.path} src={url} controls onLoadedMetadata={(e) => setFacts(formatDuration(e.currentTarget.duration))} />}
        {item.kind === "pdf" && (
          <Suspense fallback={<p className="stage-note">Loading</p>}>
            <PdfView key={item.path} url={url} onPages={onPages} />
          </Suspense>
        )}
        {item.kind === "text" && <TextView url={url} markdown={isMarkdown(item.name)} size={item.size} />}
      </div>
      {items.length > 1 && (
        <div className="arrows">
          <button className="btn" type="button" aria-label="Previous file" disabled={index === 0} onClick={() => step(-1)}>
            <Icon name="chevronLeft" />
          </button>
          <button className="btn" type="button" aria-label="Next file" disabled={index === items.length - 1} onClick={() => step(1)}>
            <Icon name="chevronRight" />
          </button>
        </div>
      )}
      <footer className="bar-bot">Left and right arrows move between files. Swipe on a phone. Escape closes.</footer>
    </dialog>
  );
}
