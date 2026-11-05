#!/usr/bin/env node
// Generates the fixtures the k6 journeys upload and convert. No third-party documents:
// everything is built here from fixed text and a seeded random generator, so reruns
// produce identical bytes. No dependencies; Node 22 or newer (zlib.crc32).
//
//   node loadgen/fixtures/generate.mjs
//
// Output (next to this file): sample.pdf (1 page), sample2.pdf (2 pages), sample.docx,
// photo.png (about 150 KiB, for thumbnails and the image viewer), notes.md.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const out = (name, data) => {
  writeFileSync(join(here, name), data);
  console.log(`${name}: ${data.length} bytes`);
};

// Small deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOREM = [
  "The load generator signs in once per virtual user and reuses the session cookie.",
  "Every request is tagged with the app and a route template, never a raw identifier.",
  "This page exists only to give the PDF tools something small and valid to work on.",
  "Merging, compressing and rasterising it should finish in well under a second.",
];

// --- PDF ------------------------------------------------------------------------------
function buildPdf(pages) {
  const objects = []; // index = object number - 1
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(""); // 1, filled in below
  const pagesObj = add(""); // 2
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // 3
  const kids = [];
  pages.forEach((lines, n) => {
    let text = `BT /F1 20 Tf 72 720 Td (${esc(`Load generator sample, page ${n + 1} of ${pages.length}`)}) Tj ET\n`;
    lines.forEach((line, i) => {
      text += `BT /F1 12 Tf 72 ${680 - i * 20} Td (${esc(line)}) Tj ET\n`;
    });
    // A few filled boxes so rasterising has something to draw.
    text += "0.2 0.4 0.8 rg 72 420 200 40 re f 0.9 0.5 0.1 rg 292 420 200 40 re f\n";
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}endstream`);
    const page = add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    kids.push(`${page} 0 R`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
const esc = (s) => s.replace(/[\\()]/g, "\\$&");

out("sample.pdf", buildPdf([LOREM]));
out("sample2.pdf", buildPdf([LOREM.slice().reverse(), LOREM.slice(1)]));

// --- ZIP / DOCX -----------------------------------------------------------------------
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const deflated = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0x0021, 10); // fixed time 00:01
    local.writeUInt16LE(0x5a21, 12); // fixed date 2025-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, deflated);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0x0021, 12);
    cd.writeUInt16LE(0x5a21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paragraph = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
const docBody = [
  paragraph("Load generator sample document", "Heading1"),
  ...LOREM.map((t) => paragraph(t)),
  paragraph("Second section", "Heading1"),
  ...LOREM.map((t) => paragraph(t)).reverse(),
].join("");
const docx = buildZip([
  [
    "[Content_Types].xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    ),
  ],
  [
    "_rels/.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
  ],
  [
    "word/_rels/document.xml.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
  ],
  [
    "word/styles.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`,
    ),
  ],
  [
    "word/document.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${docBody}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
    ),
  ],
]);
out("sample.docx", docx);

// --- PNG ------------------------------------------------------------------------------
// 256 x 256 RGB: a smooth gradient plus seeded noise, so it compresses to roughly 150 KiB.
function buildPng(w, h) {
  const rand = rng(42);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const n = () => Math.floor(rand() * 48);
      raw[p++] = Math.min(255, Math.floor((x / w) * 200) + n());
      raw[p++] = Math.min(255, Math.floor((y / h) * 200) + n());
      raw[p++] = Math.min(255, 255 - Math.floor(((x + y) / (w + h)) * 200) + n() - 24);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
out("photo.png", buildPng(256, 256));

// --- Markdown -------------------------------------------------------------------------
out(
  "notes.md",
  Buffer.from(
    `# Load generator notes\n\n${LOREM.map((l) => `- ${l}`).join("\n")}\n\n| Profile | Purpose |\n|---|---|\n| smoke | one pass per app |\n| load | 20 virtual users for ten minutes |\n\n\`\`\`js\nconsole.log("hello from the viewer");\n\`\`\`\n`,
  ),
);
