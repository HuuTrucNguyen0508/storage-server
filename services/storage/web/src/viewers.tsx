// One component per kind of file. Each reads bytes through a Source, so the
// same viewers serve signed-in users and public-link guests.

import { useQuery } from "@tanstack/react-query";
import Papa from "papaparse";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ArchiveListing, download, get, type Node, nodeUrl, type Source } from "./api";
import { bytes, plural, when } from "./format";
import { highlight, lineCount, prettyJson, renderMarkdown, trimPartial } from "./render";
import { FileIcon, Icon, typing, useToast } from "./ui";

export interface ViewerProps {
  src: Source;
  node: Node;
  /** Toolbar controls the viewer adds to the bar, rendered by the shell. */
  setControls: (c: ReactNode) => void;
  textCap: number;
}

export function Fallback({ src, node, reason }: { src: Source; node: Node; reason?: string }) {
  return (
    <div className="empty viewer-fallback">
      <FileIcon kind={node.kind} name={node.name} large />
      <p className="empty__title">{node.name}</p>
      <p className="empty__text">
        {reason ?? "There is no preview for this kind of file."} {bytes(node.size)}, changed {when(node.modifiedAt).toLowerCase()}.
      </p>
      <div className="empty__actions">
        <button className="btn btn--primary" onClick={() => download(nodeUrl(src, node.id, "content"))}>
          <Icon name="i-download" />
          Download
        </button>
      </div>
    </div>
  );
}

// ---- images ----

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function ImageView({ src, node, setControls }: ViewerProps) {
  const [scale, setScale] = useState<number | null>(null); // null = fit
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const current = () => scale ?? (img.current ? img.current.clientWidth / (natural?.w || 1) : 1);
  const zoom = useCallback(
    (dir: 1 | -1) => {
      const c = current();
      const next = dir > 0 ? ZOOMS.find((z) => z > c + 0.01) : [...ZOOMS].reverse().find((z) => z < c - 0.01);
      setScale(next ?? c);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scale, natural],
  );
  useEffect(() => {
    setScale(null);
    setFailed(false);
  }, [node.id]);
  useEffect(() => {
    setControls(
      <div className="btn-group hide-sm" role="group" aria-label="Zoom">
        <button className="btn btn--icon" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoom(-1)}>
          <Icon name="i-zoom-out" />
        </button>
        <button className="btn btn--icon" aria-pressed={scale === null} aria-label="Fit to window" title="Fit (0)" onClick={() => setScale(null)}>
          <Icon name="i-fit" />
        </button>
        <button className="btn btn--icon" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoom(1)}>
          <Icon name="i-zoom-in" />
        </button>
      </div>,
    );
  }, [scale, zoom, setControls]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === "+" || e.key === "=") zoom(1);
      else if (e.key === "-") zoom(-1);
      else if (e.key === "0") setScale(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);
  if (failed) return <Fallback src={src} node={node} reason="This image could not be shown." />;
  const style: React.CSSProperties = scale && natural ? { width: natural.w * scale, height: natural.h * scale, maxWidth: "none", maxHeight: "none" } : {};
  return (
    <img
      ref={img}
      key={node.id}
      className={scale ? "viewer-img is-zoomed" : "viewer-img"}
      src={nodeUrl(src, node.id, "raw")}
      alt={node.name}
      style={style}
      onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      onError={() => setFailed(true)}
      onDoubleClick={() => setScale(scale ? null : 1)}
      draggable={false}
    />
  );
}

// ---- video and audio ----

export function MediaView({ src, node, setControls }: ViewerProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setControls(null);
    setFailed(false);
  }, [node.id, setControls]);
  if (failed) return <Fallback src={src} node={node} reason="Your browser can't play this file." />;
  const url = nodeUrl(src, node.id, "raw");
  return node.kind === "video" ? (
    <video key={node.id} className="viewer-video" src={url} controls preload="metadata" onError={() => setFailed(true)} autoPlay={false} />
  ) : (
    <div className="viewer-audio">
      <Icon name="i-play" size="lg" />
      <p className="text-2 muted">{node.name}</p>
      <audio key={node.id} src={url} controls preload="metadata" onError={() => setFailed(true)} />
    </div>
  );
}

// ---- text, code, markdown, JSON, CSV ----

interface TextResult {
  text: string;
  truncated: boolean;
}

function useText(src: Source, node: Node, cap: number) {
  return useQuery<TextResult>({
    queryKey: ["text", src.base, node.id, node.modifiedAt],
    queryFn: async ({ signal }) => {
      const truncated = node.size > cap;
      const res = await fetch(nodeUrl(src, node.id, "raw"), {
        signal,
        credentials: "same-origin",
        headers: truncated ? { Range: `bytes=0-${cap - 1}` } : {},
      });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      return { text: trimPartial(text, truncated), truncated };
    },
    staleTime: 60_000,
  });
}

function Truncated({ src, node, cap }: { src: Source; node: Node; cap: number }) {
  return (
    <div className="notice notice--warn viewer-truncated">
      <Icon name="i-info" />
      <div>
        Showing the first {bytes(cap)} of {bytes(node.size)}.{" "}
        <button className="btn btn--sm" onClick={() => download(nodeUrl(src, node.id, "content"))}>
          Download to see the rest
        </button>
      </div>
    </div>
  );
}

export function CodeView({ src, node, setControls, textCap }: ViewerProps) {
  const q = useText(src, node, textCap);
  const toast = useToast();
  const [wrap, setWrap] = useState(false);
  const json = node.kind === "json" && q.data ? prettyJson(q.data.text) : null;
  const text = json ?? q.data?.text ?? "";
  const lang = node.kind === "json" ? "json" : node.language;
  useEffect(() => {
    setControls(
      <>
        <button className="btn btn--quiet hide-sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          <Icon name="i-wrap" />
          Wrap lines
        </button>
        <button
          className="btn hide-sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast({ text: "Copied to the clipboard.", tone: "ok" });
            } catch {
              toast({ text: "Your browser blocked the clipboard.", tone: "warn" });
            }
          }}
        >
          <Icon name="i-copy" />
          Copy
        </button>
      </>,
    );
  }, [wrap, text, setControls, toast]);
  if (q.isPending) return <div className="skeleton skeleton--block viewer-doc-skel" />;
  if (q.isError) return <Fallback src={src} node={node} reason="This file could not be read." />;
  const lines = lineCount(text);
  return (
    <div className="viewer-doc">
      {q.data.truncated && <Truncated src={src} node={node} cap={textCap} />}
      <div className={`code${wrap ? " is-wrapped" : ""}`} role="region" aria-label="File contents" tabIndex={0}>
        <pre className="code__gutter" aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
        </pre>
        <pre className="code__body hljs" dangerouslySetInnerHTML={{ __html: highlight(text, lang) }} />
      </div>
    </div>
  );
}

export function MarkdownView({ src, node, setControls, textCap }: ViewerProps) {
  const q = useText(src, node, textCap);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    setControls(
      <div className="seg hide-sm" role="radiogroup" aria-label="Show">
        <label className="seg__opt">
          <input className="sr-only" type="radio" name="md-mode" checked={!raw} onChange={() => setRaw(false)} />
          <span>Formatted</span>
        </label>
        <label className="seg__opt">
          <input className="sr-only" type="radio" name="md-mode" checked={raw} onChange={() => setRaw(true)} />
          <span>Source</span>
        </label>
      </div>,
    );
  }, [raw, setControls]);
  if (q.isPending) return <div className="skeleton skeleton--block viewer-doc-skel" />;
  if (q.isError) return <Fallback src={src} node={node} reason="This file could not be read." />;
  if (raw) return <CodeView src={src} node={{ ...node, kind: "code", language: "markdown" }} setControls={() => {}} textCap={textCap} />;
  return (
    <div className="viewer-doc">
      {q.data.truncated && <Truncated src={src} node={node} cap={textCap} />}
      <article className="prose viewer-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(q.data.text) }} />
    </div>
  );
}

const CSV_ROWS = 1000;

export function CsvView({ src, node, setControls, textCap }: ViewerProps) {
  const q = useText(src, node, textCap);
  useEffect(() => setControls(null), [setControls]);
  if (q.isPending) return <div className="skeleton skeleton--block viewer-doc-skel" />;
  if (q.isError) return <Fallback src={src} node={node} reason="This file could not be read." />;
  const parsed = Papa.parse<string[]>(q.data.text, { skipEmptyLines: true, delimiter: node.name.toLowerCase().endsWith(".tsv") ? "\t" : "" });
  const rows = parsed.data;
  const [head, ...body] = rows;
  return (
    <div className="viewer-doc viewer-doc--wide">
      {(q.data.truncated || body.length > CSV_ROWS) && (
        <div className="notice notice--warn viewer-truncated">
          <Icon name="i-info" />
          <div>
            Showing the first {Math.min(body.length, CSV_ROWS).toLocaleString("en-GB")} rows.{" "}
            <button className="btn btn--sm" onClick={() => download(nodeUrl(src, node.id, "content"))}>
              Download to see the rest
            </button>
          </div>
        </div>
      )}
      <div className="table-wrap card">
        <table className="table table--compact">
          <thead>
            <tr>
              <th className="col-num">#</th>
              {head?.map((h, i) => <th key={i}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {body.slice(0, CSV_ROWS).map((r, i) => (
              <tr key={i}>
                <td className="col-num faint">{i + 1}</td>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- ZIP archives ----

export function ArchiveView({ src, node, setControls }: ViewerProps) {
  useEffect(() => setControls(null), [setControls]);
  const q = useQuery({ queryKey: ["archive", src.base, node.id], queryFn: () => get<ArchiveListing>(nodeUrl(src, node.id, "archive")) });
  if (q.isPending) return <div className="skeleton skeleton--block viewer-doc-skel" />;
  if (q.isError) return <Fallback src={src} node={node} reason="This archive could not be read." />;
  const files = q.data.entries.filter((e) => !e.isDir);
  const total = files.reduce((s, e) => s + e.size, 0);
  return (
    <div className="viewer-doc viewer-doc--wide">
      <p className="muted text-2 viewer-archive-sum">
        {plural(q.data.total, "entry", "entries")}, {bytes(total)} unpacked{q.data.truncated ? `; showing the first ${q.data.entries.length}` : ""}.
      </p>
      <div className="table-wrap card">
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Name</th>
              <th className="hide-sm">Modified</th>
              <th className="col-num">Size</th>
            </tr>
          </thead>
          <tbody>
            {q.data.entries.map((e, i) => (
              <tr key={i}>
                <td>
                  <div className="name-cell">
                    <Icon name={e.isDir ? "i-folder" : "i-file"} className="faint" />
                    <span className="truncate mono text-2">{e.name}</span>
                  </div>
                </td>
                <td className="hide-sm num">{when(e.modified)}</td>
                <td className="col-num">{e.isDir ? "" : bytes(e.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- PDF (and Office documents converted to PDF) ----

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })();
  return pdfjsPromise;
}

export function OfficeView(props: ViewerProps) {
  const { src, node, setControls } = props;
  const [state, setState] = useState<"converting" | "ready" | "failed" | "busy">("converting");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setState("converting");
    setControls(null);
    const ctl = new AbortController();
    // The server converts in the background and answers 202 until the PDF is
    // ready; poll, then let pdf.js read it. Give up after three minutes.
    void (async () => {
      const deadline = Date.now() + 180_000;
      while (!ctl.signal.aborted) {
        let status = 0;
        try {
          const r = await fetch(nodeUrl(src, node.id, "office-preview"), {
            headers: { Range: "bytes=0-0" },
            signal: ctl.signal,
            credentials: "same-origin",
            redirect: "manual",
          });
          status = r.status;
        } catch {
          if (ctl.signal.aborted) return;
        }
        if (status === 200 || status === 206) return setState("ready");
        if (status === 503) return setState("busy");
        if (status !== 202 || Date.now() > deadline) return setState("failed");
        await new Promise((res) => setTimeout(res, 2000));
      }
    })();
    return () => ctl.abort();
  }, [src, node.id, attempt, setControls]);
  if (state === "converting")
    return (
      <div className="empty">
        <div className="spinner" aria-hidden="true" />
        <p className="empty__title">Preparing a preview</p>
        <p className="empty__text">Converting {node.name} to PDF. Large documents take a few seconds.</p>
      </div>
    );
  if (state === "busy")
    return (
      <div className="empty">
        <p className="empty__title">The converter is busy</p>
        <p className="empty__text">Other documents are being converted right now.</p>
        <div className="empty__actions">
          <button className="btn" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </button>
          <button className="btn btn--primary" onClick={() => download(nodeUrl(src, node.id, "content"))}>
            <Icon name="i-download" />
            Download
          </button>
        </div>
      </div>
    );
  if (state === "failed") return <Fallback src={src} node={node} reason="This document could not be converted for preview." />;
  return <PdfView {...props} url={nodeUrl(src, node.id, "office-preview")} />;
}

export function PdfView({ src, node, setControls, url }: ViewerProps & { url?: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null); // null = fit width
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[] | null>(null);
  const [searching, setSearching] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const pageText = useRef(new Map<number, string>());
  const source = url ?? nodeUrl(src, node.id, "raw");

  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    setDoc(null);
    setError(false);
    setPage(1);
    setMatches(null);
    pageText.current.clear();
    loadPdfjs()
      .then((lib) => {
        const t = lib.getDocument({
          url: source,
          withCredentials: true,
          // Copied next to the bundle by vite.config.ts; same origin, allowed by the CSP.
          cMapUrl: "/assets/pdfjs/cmaps/",
          standardFontDataUrl: "/assets/pdfjs/standard_fonts/",
          wasmUrl: "/assets/pdfjs/wasm/",
        });
        task = t;
        return t.promise;
      })
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [source]);

  // Render the current page and its text layer (for selection and search highlights).
  useLayoutEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      const lib = await loadPdfjs();
      const p = await doc.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const width = (stage.current?.clientWidth ?? 800) - 32;
      const scale = zoom ?? Math.max(0.25, Math.min(3, width / base.width));
      const vp = p.getViewport({ scale });
      const c = canvas.current!;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width = `${vp.width}px`;
      c.style.height = `${vp.height}px`;
      const rt = p.render({ canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      task = rt;
      await rt.promise.catch(() => {});
      if (cancelled) return;
      const tl = textLayer.current!;
      tl.replaceChildren();
      tl.style.width = `${vp.width}px`;
      tl.style.height = `${vp.height}px`;
      tl.style.setProperty("--scale-factor", String(scale));
      tl.style.setProperty("--total-scale-factor", String(scale));
      const layer = new lib.TextLayer({ textContentSource: p.streamTextContent(), container: tl, viewport: vp });
      await layer.render().catch(() => {});
      if (cancelled) return;
      markMatches(tl, query);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, zoom]);

  useEffect(() => {
    if (textLayer.current) markMatches(textLayer.current, matches ? query : "");
  }, [matches, query]);

  const pages = doc?.numPages ?? 0;
  const go = useCallback((n: number) => setPage((p) => Math.max(1, Math.min(pages || p, n))), [pages]);

  const search = useCallback(
    async (dir: 1 | -1 = 1) => {
      if (!doc || !query.trim()) {
        setMatches(null);
        return;
      }
      setSearching(true);
      const needle = query.toLowerCase();
      const found: number[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        let t = pageText.current.get(i);
        if (t === undefined) {
          const p = await doc.getPage(i);
          const tc = await p.getTextContent();
          t = tc.items.map((it) => ("str" in it ? it.str : "")).join(" ").toLowerCase();
          pageText.current.set(i, t);
        }
        if (t.includes(needle)) found.push(i);
      }
      setSearching(false);
      setMatches(found);
      if (found.length) {
        const next = dir > 0 ? (found.find((p) => p > page) ?? found[0]!) : ([...found].reverse().find((p) => p < page) ?? found[found.length - 1]!);
        setPage(next);
      }
    },
    [doc, query, page],
  );

  useEffect(() => {
    setControls(
      <>
        <form
          className="input-wrap hide-sm pdf-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            void search(1);
          }}
        >
          <Icon name="i-search" />
          <input
            className="input"
            type="search"
            placeholder="Find in document"
            aria-label="Find in document"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatches(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                void search(-1);
              }
            }}
          />
          {searching ? (
            <span className="faint text-2">Searching</span>
          ) : matches ? (
            <span className="faint text-2" aria-live="polite">
              {matches.length ? `${plural(matches.length, "page")}` : "No matches"}
            </span>
          ) : null}
        </form>
        <div className="row pdf-pager">
          <button className="btn btn--icon" aria-label="Previous page" disabled={page <= 1} onClick={() => go(page - 1)}>
            <Icon name="i-chev-l" />
          </button>
          <label className="text-2 num">
            <span className="sr-only">Page</span>
            <input
              className="input input--sm pdf-page-input"
              inputMode="numeric"
              value={page}
              aria-label="Page number"
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (n) go(n);
              }}
            />{" "}
            of {pages || "…"}
          </label>
          <button className="btn btn--icon" aria-label="Next page" disabled={page >= pages} onClick={() => go(page + 1)}>
            <Icon name="i-chev-r" />
          </button>
        </div>
        <div className="btn-group hide-sm" role="group" aria-label="Zoom">
          <button className="btn btn--icon" aria-label="Zoom out" onClick={() => setZoom(Math.max(0.25, (zoom ?? 1) / 1.25))}>
            <Icon name="i-zoom-out" />
          </button>
          <button className="btn btn--icon" aria-pressed={zoom === null} aria-label="Fit width" onClick={() => setZoom(null)}>
            <Icon name="i-fit" />
          </button>
          <button className="btn btn--icon" aria-label="Zoom in" onClick={() => setZoom(Math.min(5, (zoom ?? 1) * 1.25))}>
            <Icon name="i-zoom-in" />
          </button>
        </div>
      </>,
    );
  }, [page, pages, zoom, query, matches, searching, go, search, setControls]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === "PageDown" || e.key === "j") go(page + 1);
      else if (e.key === "PageUp" || e.key === "k") go(page - 1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(5, (z ?? 1) * 1.25));
      else if (e.key === "-") setZoom((z) => Math.max(0.25, (z ?? 1) / 1.25));
      else if (e.key === "0") setZoom(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, page]);

  if (error) return <Fallback src={src} node={node} reason="This PDF could not be opened." />;
  return (
    <div className="pdf-stage" ref={stage}>
      {!doc && <div className="skeleton skeleton--block viewer-doc-skel" />}
      <div className="pdf-page" hidden={!doc}>
        <canvas ref={canvas} aria-label={`Page ${page} of ${node.name}`} role="img" />
        <div ref={textLayer} className="textLayer" />
      </div>
    </div>
  );
}

function markMatches(layer: HTMLElement, query: string) {
  const q = query.trim().toLowerCase();
  layer.querySelectorAll("span").forEach((s) => {
    s.classList.toggle("is-match", !!q && (s.textContent ?? "").toLowerCase().includes(q));
  });
}
