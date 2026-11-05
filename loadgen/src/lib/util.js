import { sleep } from "k6";
import { THINK } from "./config.js";

export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
export const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));

// A short unique token for names created by one iteration.
export function uniq() {
  return `${__VU.toString(36)}${__ITER.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

// Wait like a person between actions. Zero when THINK is 0 (smoke).
export function think(lo = 0.4, hi = 1.6) {
  if (THINK > 0) sleep(rand(lo, hi) * THINK);
}

export function json(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

// Builds a multipart/form-data body. parts: [{name, value}] or
// [{name, data: ArrayBuffer|Uint8Array, filename, type}]. k6's own multipart support takes
// an object, which cannot repeat a field name (Stirling's merge needs `fileInput` twice).
export function multipart(parts) {
  const boundary = `----k6${Math.floor(Math.random() * 1e12).toString(36)}`;
  const enc = new TextEncoder();
  const pieces = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"\r\nContent-Type: ${p.type || "application/octet-stream"}`;
    head += "\r\n\r\n";
    pieces.push(enc.encode(head));
    pieces.push(p.data !== undefined ? new Uint8Array(p.data.buffer || p.data) : enc.encode(String(p.value)));
    pieces.push(enc.encode("\r\n"));
  }
  pieces.push(enc.encode(`--${boundary}--\r\n`));
  const total = pieces.reduce((n, a) => n + a.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const a of pieces) {
    body.set(a, off);
    off += a.length;
  }
  return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
