import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

function Page({ doc, number, width }: { doc: PDFDocumentProxy; number: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState(1.414);

  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setVisible(true);
    }, { rootMargin: "400px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || canvas.current === null) return;
    const el = canvas.current;
    let cancelled = false;
    let stop = () => {};
    void doc.getPage(number).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = Math.min(window.devicePixelRatio, 2);
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      el.width = viewport.width;
      el.height = viewport.height;
      const task = page.render({ canvas: el, viewport });
      stop = () => task.cancel();
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [doc, number, visible, width]);

  return <canvas ref={canvas} className="pdf-page" aria-label={`Page ${number}`} style={{ width, height: width * ratio }} />;
}

/** The server's sandbox CSP blocks a browser's viewer, and Android Chrome has none, so the bytes draw on canvases here. */
export default function PdfView({ url, onPages }: { url: string; onPages: (pages: number) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const task = getDocument({
      url,
      useWasm: false,
      wasmUrl: "/pdfjs/wasm/",
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
    });
    task.promise.then(
      (loaded) => {
        setDoc(loaded);
        onPages(loaded.numPages);
      },
      () => setFailed(true),
    );
    return () => void task.destroy();
  }, [url, onPages]);

  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = () => setWidth(Math.min(el.clientWidth, 900));
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  return (
    <div className="pdf" ref={box} tabIndex={0}>
      {failed && <p className="stage-note">This PDF could not be opened. Download it instead.</p>}
      {doc !== null && width > 0 && Array.from({ length: doc.numPages }, (_, i) => <Page key={i} doc={doc} number={i + 1} width={width} />)}
    </div>
  );
}
