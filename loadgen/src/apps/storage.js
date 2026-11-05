// Storage journey: browse, create a folder, upload (small, medium, in chunks), list, search,
// download, thumbnail and inline preview, share by password link and open it as a guest,
// revoke the link, then delete everything and empty the trash.
import { sleep } from "k6";
import { get, post, put, del, verify, newGuestJar } from "../lib/http.js";
import { blob, text, fixture } from "../lib/data.js";
import { json, randInt, think, uniq } from "../lib/util.js";
import { CHUNK_BYTES, MEDIUM_MAX_MIB, MEDIUM_MIN_MIB, OFFICE_SHARE, SMOKE } from "../lib/config.js";
import { itemName, sweepable } from "../lib/names.js";

const APP = "storage";
const photo = fixture(import.meta.resolve("../../fixtures/photo.png"));
const notes = fixture(import.meta.resolve("../../fixtures/notes.md"));
const samplePdf = fixture(import.meta.resolve("../../fixtures/sample.pdf"));
const sampleDocx = fixture(import.meta.resolve("../../fixtures/sample.docx"));
const enc = new TextEncoder();

// Uploads `data` into `parentId` the way the web app does: reserve, then PUT chunks.
// Returns the created node, or null when something failed (checks record why).
function upload(parentId, name, data, chunkBytes) {
  const size = data.byteLength;
  const start = post(APP, "/api/uploads", { name: "POST /api/uploads", json: { parentId, name, size } });
  const session = json(start);
  if (!verify(APP, start, { "upload: reserved (201)": (r) => r.status === 201 && session && session.upload })) return null;
  const { id: uid, chunkMax } = session.upload;
  const step = Math.min(chunkBytes || size, chunkMax || size);
  let offset = 0;
  while (offset < size) {
    const end = Math.min(size, offset + step);
    const res = put(APP, `/api/uploads/${uid}`, {
      name: "PUT /api/uploads/{uid}",
      kind: "transfer",
      headers: { "Upload-Offset": String(offset) },
      body: data.slice(offset, end),
      contentType: "application/octet-stream",
      expect: [200, 201],
    });
    const body = json(res);
    if (res.status === 201) {
      verify(APP, res, { "upload: finished (node returned)": () => body && body.node && body.node.size === size });
      return body && body.node;
    }
    if (res.status !== 200 || !body) {
      verify(APP, res, { "upload: chunk accepted": () => false });
      return null;
    }
    offset = body.upload.offset;
  }
  return null;
}

function fetchSpa() {
  const page = get(APP, "/", { name: "GET /", kind: "page", binary: false });
  verify(APP, page, { "spa: index 200 html": (r) => r.status === 200 && String(r.body).includes("<div id=") });
  const assets = [];
  const re = /(?:src|href)="(\/assets\/[^"]+)"/g;
  let m;
  while ((m = re.exec(String(page.body))) !== null) assets.push(m[1]);
  for (const a of assets.slice(0, 6)) {
    const res = get(APP, a, { name: "GET /assets/{file}", kind: "page", guest: true, none: true });
    verify(APP, res, { "spa: asset 200": (r) => r.status === 200 });
  }
}

function officePreview(id) {
  for (let i = 0; i < 45; i++) {
    const res = get(APP, `/api/nodes/${id}/office-preview`, { name: "GET /api/nodes/{id}/office-preview", kind: "convert", binary: true });
    if (res.status === 200) {
      verify(APP, res, { "office-preview: converted to PDF": (r) => String(r.headers["Content-Type"]).includes("pdf") && r.body.byteLength > 500 });
      return;
    }
    if (res.status !== 202) {
      verify(APP, res, { "office-preview: 200 or 202": () => false });
      return;
    }
    sleep(Number(res.headers["Retry-After"] || 2));
  }
  verify(APP, { status: 0 }, { "office-preview: ready within 90 s": () => false });
}

function sharedLinkRoundTrip(fileId, expectedSize) {
  const password = `pw-${uniq()}-k6`;
  const made = post(APP, `/api/nodes/${fileId}/links`, {
    name: "POST /api/nodes/{id}/links",
    json: { kind: "view", password, maxDownloads: 1000 },
  });
  const link = json(made);
  if (!verify(APP, made, { "link: created with token": (r) => r.status === 201 && link && link.token && link.token.length >= 40 && link.link })) return null;
  const token = link.token;
  const linkId = link.link.id;

  const jar = newGuestJar(); // a guest: no account cookie
  const g = (method, path, o) => (method === "GET" ? get : post)(APP, path, Object.assign({ guest: true, jar }, o));
  think(0.2, 0.8);
  const page = g("GET", `/s/${token}`, { name: "GET /s/{token}", kind: "page" });
  verify(APP, page, { "guest: page loads": (r) => r.status === 200 });
  const before = g("GET", `/api/public/${token}`, { name: "GET /api/public/{token}" });
  verify(APP, before, { "guest: password required": () => json(before) && json(before).link && json(before).link.requiresPassword === true });
  const locked = g("GET", `/api/public/${token}/nodes/${fileId}/content`, { name: "GET /api/public/{token}/nodes/{id}/content", expect: [401], none: true });
  verify(APP, locked, { "guest: locked before the password": (r) => r.status === 401 });
  const unlock = g("POST", `/api/public/${token}/unlock`, { name: "POST /api/public/{token}/unlock", json: { password } });
  verify(APP, unlock, { "guest: right password unlocks": (r) => r.status === 200 });
  const after = g("GET", `/api/public/${token}`, { name: "GET /api/public/{token}" });
  verify(APP, after, { "guest: node visible once unlocked": () => json(after) && json(after).node && json(after).node.id === fileId });
  const thumb = g("GET", `/api/public/${token}/nodes/${fileId}/thumbnail?size=128`, { name: "GET /api/public/{token}/nodes/{id}/thumbnail", kind: "preview", binary: true });
  verify(APP, thumb, { "guest: thumbnail": (r) => r.status === 200 });
  const dl = g("GET", `/api/public/${token}/nodes/${fileId}/content`, { name: "GET /api/public/{token}/nodes/{id}/content", kind: "transfer", binary: true });
  verify(APP, dl, { "guest: download has the file's bytes": (r) => r.status === 200 && r.body.byteLength === expectedSize });

  think(0.2, 0.6);
  const revoke = del(APP, `/api/links/${linkId}`, { name: "DELETE /api/links/{id}", expect: [204] });
  verify(APP, revoke, { "link: revoked (204)": (r) => r.status === 204 });
  const gone = g("GET", `/api/public/${token}`, { name: "GET /api/public/{token}", expect: [404, 410] });
  verify(APP, gone, { "guest: revoked link stops working": (r) => r.status === 404 || r.status === 410 });
  return linkId;
}

export function journey() {
  const me = get(APP, "/api/me", { name: "GET /api/me" });
  const user = json(me);
  if (!verify(APP, me, { "me: 200 with rootId": (r) => r.status === 200 && user && user.user && user.user.rootId })) return;
  const rootId = user.user.rootId;
  if (SMOKE || Math.random() < 0.2) fetchSpa(); // a fresh page load, not every iteration

  const root = get(APP, `/api/nodes/${rootId}/children`, { name: "GET /api/nodes/{id}/children" });
  verify(APP, root, { "list root: 200": (r) => r.status === 200 && Array.isArray(json(r).items) });
  think();

  const u = uniq();
  const folder = post(APP, "/api/folders", { name: "POST /api/folders", json: { parentId: rootId, name: itemName(u) } });
  const folderNode = json(folder);
  if (!verify(APP, folder, { "folder: created (201)": (r) => r.status === 201 && folderNode && folderNode.node })) return;
  const folderId = folderNode.node.id;

  try {
    think();
    const mediumSize = randInt(MEDIUM_MIN_MIB, MEDIUM_MAX_MIB) * 1024 * 1024 + randInt(0, 1023);
    const smallSize = randInt(4, 64) * 1024;
    const small = upload(folderId, `${u}-small.bin`, blob(smallSize));
    const readme = upload(folderId, `${u}-readme.txt`, enc.encode(text(4096)).buffer);
    const md = upload(folderId, `${u}-notes.md`, notes);
    const img = upload(folderId, `${u}-photo.png`, photo);
    const pdf = upload(folderId, `${u}-sample.pdf`, samplePdf);
    think();
    const medium = upload(folderId, `${u}-medium.bin`, blob(mediumSize), CHUNK_BYTES);
    const doOffice = SMOKE || Math.random() < OFFICE_SHARE;
    const docx = doOffice ? upload(folderId, `${u}-sample.docx`, sampleDocx) : null;
    const uploaded = [small, readme, md, img, pdf, medium].concat(doOffice ? [docx] : []);
    const count = uploaded.filter(Boolean).length;
    think();

    const list = get(APP, `/api/nodes/${folderId}/children?sort=modified&order=desc`, { name: "GET /api/nodes/{id}/children" });
    verify(APP, list, { "list folder: has every upload": () => json(list) && json(list).items && json(list).items.length === count });

    const search = get(APP, `/api/search?q=${u}`, { name: "GET /api/search" });
    verify(APP, search, { "search: finds the new files": () => json(search) && json(search).items && json(search).items.length >= count });
    think();

    if (medium) {
      const dl = get(APP, `/api/nodes/${medium.id}/content`, { name: "GET /api/nodes/{id}/content", kind: "transfer", none: true });
      verify(APP, dl, {
        "download: medium file 200 with attachment": (r) => r.status === 200 && String(r.headers["Content-Disposition"]).startsWith("attachment"),
        "download: medium file length": (r) => Number(r.headers["Content-Length"] || medium.size) === medium.size,
      });
    }
    if (small) {
      const dl = get(APP, `/api/nodes/${small.id}/content`, { name: "GET /api/nodes/{id}/content", kind: "transfer", binary: true });
      verify(APP, dl, { "download: small file bytes": (r) => r.status === 200 && r.body.byteLength === smallSize });
    }
    if (img) {
      const thumb = get(APP, `/api/nodes/${img.id}/thumbnail?size=256`, { name: "GET /api/nodes/{id}/thumbnail", kind: "preview", binary: true });
      verify(APP, thumb, { "thumbnail: JPEG": (r) => r.status === 200 && String(r.headers["Content-Type"]).includes("image/jpeg") });
      const raw = get(APP, `/api/nodes/${img.id}/raw`, { name: "GET /api/nodes/{id}/raw", kind: "preview", headers: { Range: "bytes=0-65535" }, binary: true });
      verify(APP, raw, { "preview: image range 206": (r) => r.status === 206 && r.body.byteLength === 65536 });
    }
    if (md) {
      const raw = get(APP, `/api/nodes/${md.id}/raw`, { name: "GET /api/nodes/{id}/raw", kind: "preview" });
      verify(APP, raw, { "preview: markdown as text": (r) => r.status === 200 && String(r.headers["Content-Type"]).startsWith("text/plain") });
    }
    if (pdf) {
      const raw = get(APP, `/api/nodes/${pdf.id}/raw`, { name: "GET /api/nodes/{id}/raw", kind: "preview", binary: true });
      verify(APP, raw, { "preview: pdf bytes": (r) => r.status === 200 && String(r.headers["Content-Type"]).includes("application/pdf") });
    }
    if (docx) officePreview(docx.id);
    if (SMOKE || Math.random() < 0.2) {
      const zip = get(APP, `/api/zip?id=${folderId}`, { name: "GET /api/zip", kind: "transfer", none: true });
      verify(APP, zip, { "zip: folder streams": (r) => r.status === 200 });
    }
    think();

    if (img) sharedLinkRoundTrip(img.id, img.size);
  } finally {
    const trashed = del(APP, `/api/nodes/${folderId}`, { name: "DELETE /api/nodes/{id}", expect: [204] });
    verify(APP, trashed, { "cleanup: folder trashed": (r) => r.status === 204 });
    const gone = del(APP, `/api/trash/${folderId}`, { name: "DELETE /api/trash/{id}", expect: [204] });
    verify(APP, gone, { "cleanup: folder deleted for good": (r) => r.status === 204 });
  }
}

// After the run: remove anything a killed iteration left behind, then empty the trash.
export function sweep() {
  const me = json(get(APP, "/api/me", { name: "GET /api/me" }));
  if (!me || !me.user) return;
  const list = json(get(APP, `/api/nodes/${me.user.rootId}/children`, { name: "GET /api/nodes/{id}/children" }));
  for (const n of (list && list.items) || []) {
    if (sweepable(n.name)) del(APP, `/api/nodes/${n.id}`, { name: "DELETE /api/nodes/{id}", expect: [204] });
  }
  del(APP, "/api/trash", { name: "DELETE /api/trash", expect: [200, 204] });
}
