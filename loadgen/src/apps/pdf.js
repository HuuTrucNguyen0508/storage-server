// PDF journey (Stirling PDF through the ingress with the SSO cookie): merge two PDFs,
// compress the result, turn a page into a PNG, and now and then convert a docx
// (LibreOffice-bound, so rare). Concurrency is capped by the profile, not here.
import { get, post, verify } from "../lib/http.js";
import { fixture } from "../lib/data.js";
import { multipart, think } from "../lib/util.js";
import { OFFICE_SHARE, SMOKE } from "../lib/config.js";

const APP = "pdf";
const pdf1 = fixture(import.meta.resolve("../../fixtures/sample.pdf"));
const pdf2 = fixture(import.meta.resolve("../../fixtures/sample2.pdf"));
const docx = fixture(import.meta.resolve("../../fixtures/sample.docx"));

const isPdf = (r) => String(r.headers["Content-Type"]).includes("application/pdf") && r.body.byteLength > 500 && String(String.fromCharCode.apply(null, new Uint8Array(r.body, 0, 5))) === "%PDF-";

function form(parts) {
  const m = multipart(parts);
  return { body: m.body, contentType: m.contentType, binary: true, kind: "convert" };
}
const file = (name, data, filename, type) => ({ name, data, filename, type });
const field = (name, value) => ({ name, value });

export function journey() {
  const status = get(APP, "/api/v1/info/status", { name: "GET /api/v1/info/status" });
  verify(APP, status, { "status: UP": (r) => r.status === 200 && String(r.body).includes('"UP"') });
  think();

  const merged = post(APP, "/api/v1/general/merge-pdfs", Object.assign(form([
    file("fileInput", pdf1, "a.pdf", "application/pdf"),
    file("fileInput", pdf2, "b.pdf", "application/pdf"),
    field("sortType", "orderProvided"),
    field("removeCertSign", "true"),
  ]), { name: "POST /api/v1/general/merge-pdfs" }));
  verify(APP, merged, { "merge: a PDF comes back": (r) => r.status === 200 && isPdf(r) });
  think();

  const input = merged.status === 200 ? merged.body : pdf1;
  const compressed = post(APP, "/api/v1/misc/compress-pdf", Object.assign(form([
    file("fileInput", input, "merged.pdf", "application/pdf"),
    field("optimizeLevel", "3"),
    field("expectedOutputSize", "25KB"),
    field("linearize", "false"),
    field("normalize", "false"),
    field("grayscale", "false"),
  ]), { name: "POST /api/v1/misc/compress-pdf" }));
  verify(APP, compressed, { "compress: a PDF comes back": (r) => r.status === 200 && isPdf(r) });
  think();

  const image = post(APP, "/api/v1/convert/pdf/img", Object.assign(form([
    file("fileInput", pdf1, "page.pdf", "application/pdf"),
    field("imageFormat", "png"),
    field("singleOrMultiple", "single"),
    field("colorType", "color"),
    field("dpi", "72"),
    field("pageNumbers", "1"),
  ]), { name: "POST /api/v1/convert/pdf/img" }));
  verify(APP, image, { "pdf to image: a PNG comes back": (r) => r.status === 200 && String(r.headers["Content-Type"]).includes("image/png") && r.body.byteLength > 1000 });

  if (SMOKE || Math.random() < OFFICE_SHARE) {
    think();
    const converted = post(APP, "/api/v1/convert/file/pdf", Object.assign(form([
      file("fileInput", docx, "sample.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ]), { name: "POST /api/v1/convert/file/pdf", timeout: "120s" }));
    verify(APP, converted, { "docx to pdf: a PDF comes back": (r) => r.status === 200 && isPdf(r) });
  }
  think();
}
