package server_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/config"
)

func pngBytes(t *testing.T) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 640, 480))
	for x := 0; x < 640; x++ {
		for y := 0; y < 480; y++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func zipBytes(t *testing.T, files map[string]string) []byte {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for name, body := range files {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	return b.Bytes()
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

func TestResumableUpload(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.MaxChunkSize = 1 << 20 })
	alice := e.as("alice")
	root := alice.root()
	data := randomBytes(3<<20 + 12345)
	var created struct {
		Upload struct {
			ID     string `json:"id"`
			Offset int64  `json:"offset"`
		} `json:"upload"`
	}
	alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": root, "name": "big.bin", "size": len(data), "relativePath": "nested/deeper"}), 201).json(&created)
	id := created.Upload.ID
	// The declared size is reserved against the quota at once.
	var me struct{ Usage struct{ ReservedBytes int64 } }
	alice.must(alice.get("/api/me"), 200).json(&me)
	if me.Usage.ReservedBytes != int64(len(data)) {
		t.Fatalf("reserved %d", me.Usage.ReservedBytes)
	}
	alice.must(alice.req("PUT", "/api/uploads/"+id, data[:1<<20], "Upload-Offset", "0"), 200)
	// A chunk larger than the maximum is refused before anything is written.
	alice.must(alice.req("PUT", "/api/uploads/"+id, data[1<<20:3<<20], "Upload-Offset", strconv.Itoa(1<<20)), 413)
	// A wrong offset tells the client where to resume.
	var conflict struct {
		Upload struct{ Offset int64 } `json:"upload"`
	}
	alice.must(alice.req("PUT", "/api/uploads/"+id, data[:10], "Upload-Offset", "0"), 409).json(&conflict)
	if conflict.Upload.Offset != 1<<20 {
		t.Fatalf("conflict offset %d", conflict.Upload.Offset)
	}
	// The connection drops halfway through the second chunk.
	interruptedChunk(t, e, id, data[1<<20:2<<20], 1<<20, 300_000)
	var st struct {
		Upload struct{ Offset int64 } `json:"upload"`
	}
	alice.must(alice.get("/api/uploads/"+id), 200).json(&st)
	if st.Upload.Offset <= 1<<20 || st.Upload.Offset > 1<<20+300_000 {
		t.Fatalf("offset after interruption %d", st.Upload.Offset)
	}
	// Resume from the server's offset, never from zero.
	off := st.Upload.Offset
	var done struct {
		Node   node   `json:"node"`
		SHA256 string `json:"sha256"`
	}
	for off < int64(len(data)) {
		end := min(off+1<<20, int64(len(data)))
		r := alice.req("PUT", "/api/uploads/"+id, data[off:end], "Upload-Offset", strconv.FormatInt(off, 10))
		if end == int64(len(data)) {
			alice.must(r, 201).json(&done)
		} else {
			alice.must(r, 200)
		}
		off = end
	}
	sum := sha256.Sum256(data)
	if done.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("server sha %s", done.SHA256)
	}
	got := alice.must(alice.get("/api/nodes/"+done.Node.ID+"/content"), 200).Body
	if !bytes.Equal(got, data) {
		t.Fatal("downloaded bytes differ")
	}
	var meta struct{ Crumbs []struct{ Name string } }
	alice.must(alice.get("/api/nodes/"+done.Node.ID), 200).json(&meta)
	if len(meta.Crumbs) != 4 || meta.Crumbs[1].Name != "nested" || meta.Crumbs[2].Name != "deeper" {
		t.Fatalf("folder path: %+v", meta.Crumbs)
	}
	alice.must(alice.get("/api/me"), 200).json(&me)
	if me.Usage.ReservedBytes != 0 {
		t.Fatalf("reservation left after finishing: %d", me.Usage.ReservedBytes)
	}
	if e.metric(`storage_uploads_total{result="ok"}`) != 1 || e.metric("storage_upload_bytes_total") != float64(len(data)) {
		t.Fatalf("upload metrics ok=%v bytes=%v", e.metric(`storage_uploads_total{result="ok"}`), e.metric("storage_upload_bytes_total"))
	}
}

// interruptedChunk sends the first n bytes of chunk and then breaks the connection.
func interruptedChunk(t *testing.T, e *env, id string, chunk []byte, offset, n int) {
	t.Helper()
	pr, pw := io.Pipe()
	req, _ := http.NewRequest("PUT", e.srv.URL+"/api/uploads/"+id, pr)
	req.ContentLength = int64(len(chunk))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Requested-With", "fetch")
	req.Header.Set("Upload-Offset", strconv.Itoa(offset))
	req.Header.Set("Remote-User", "alice")
	req.Header.Set("Remote-Groups", "users")
	errc := make(chan error, 1)
	go func() {
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			res.Body.Close()
		}
		errc <- err
	}()
	pw.Write(chunk[:n])
	time.Sleep(200 * time.Millisecond)
	pw.CloseWithError(io.ErrUnexpectedEOF)
	<-errc
	// Give the server a moment to record what arrived.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var off int64
		e.st.Pool.QueryRow(context.Background(), "SELECT received FROM upload_sessions WHERE id = $1", id).Scan(&off)
		if off > int64(offset) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestQuotaAndCancelAndAbandonedUploads(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.DefaultQuota = 1000 })
	alice := e.as("alice")
	root := alice.root()
	alice.upload(root, "a.bin", randomBytes(600))
	alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": root, "name": "b.bin", "size": 500}), 507)
	if e.metric(`storage_uploads_total{result="quota"}`) != 1 {
		t.Fatal("quota refusal not counted")
	}
	alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": root, "name": "huge.bin", "size": 11 << 30}), 413)
	// An open session reserves its size.
	var up struct{ Upload struct{ ID string } }
	alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": root, "name": "c.bin", "size": 300}), 201).json(&up)
	alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": root, "name": "d.bin", "size": 200}), 507)
	// Cancelling releases it.
	alice.must(alice.req("PUT", "/api/uploads/"+up.Upload.ID, randomBytes(100), "Upload-Offset", "0"), 200)
	alice.must(alice.req("DELETE", "/api/uploads/"+up.Upload.ID, nil), 204)
	if _, err := os.Stat(filepath.Join(e.dir, "uploads", up.Upload.ID)); !os.IsNotExist(err) {
		t.Fatal("cancelled upload left its bytes")
	}
	alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": root, "name": "d.bin", "size": 200}), 201).json(&up)
	alice.must(alice.req("PUT", "/api/uploads/"+up.Upload.ID, randomBytes(50), "Upload-Offset", "0"), 200)
	// Abandoned for over 24 hours: purged, and the bytes no longer count.
	e.st.Pool.Exec(context.Background(), "UPDATE upload_sessions SET updated_at = now() - interval '25 hours'")
	e.s.Cleanup(context.Background())
	alice.must(alice.get("/api/uploads/"+up.Upload.ID), 404)
	if _, err := os.Stat(filepath.Join(e.dir, "uploads", up.Upload.ID)); !os.IsNotExist(err) {
		t.Fatal("abandoned upload left its bytes")
	}
	var me struct {
		Usage struct{ UsedBytes, ReservedBytes int64 }
	}
	alice.must(alice.get("/api/me"), 200).json(&me)
	if me.Usage.ReservedBytes != 0 || me.Usage.UsedBytes != 600 {
		t.Fatalf("usage after purge: %+v", me.Usage)
	}
	// Copies count too.
	f := alice.upload(root, "e.bin", randomBytes(300))
	alice.must(alice.req("POST", "/api/nodes/copy", map[string]any{"ids": []string{f.ID}, "parentId": root}), 507)
}

func TestVolumeFreeSpaceFloor(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.MinFreePercent = 99.999 })
	alice := e.as("alice")
	r := alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": alice.root(), "name": "x.bin", "size": 10 << 20}), 507)
	if !strings.Contains(string(r.Body), "volume_full") {
		t.Fatalf("body %s", r.Body)
	}
}

func TestNamesFoldersMoveCopyRename(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	root := alice.root()
	for _, bad := range []string{"", " ", ".", "..", "a/b", `a\b`, "bad\x00name", "x‮txt.exe", strings.Repeat("a", 256)} {
		alice.must(alice.req("POST", "/api/folders", map[string]any{"parentId": root, "name": bad}), 400)
		alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": root, "name": bad, "size": 1}), 400)
	}
	alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": root, "name": "ok.txt", "size": 1, "relativePath": "a/../b"}), 400)
	// NFC normalization: e + combining acute equals é.
	a := alice.mkdir(root, "café")
	if a.Name != "café" {
		t.Fatalf("not NFC: %q", a.Name)
	}
	alice.must(alice.req("POST", "/api/folders", map[string]any{"parentId": root, "name": "CAFÉ"}), 409)
	// Duplicate uploads get numbers.
	n1 := alice.upload(a.ID, "report.pdf", []byte("1"))
	n2 := alice.upload(a.ID, "report.pdf", []byte("2"))
	n3 := alice.upload(a.ID, "Report.pdf", []byte("3"))
	if n1.Name != "report.pdf" || n2.Name != "report (1).pdf" || n3.Name != "Report (2).pdf" {
		t.Fatalf("dedupe: %s %s %s", n1.Name, n2.Name, n3.Name)
	}
	alice.must(alice.req("PATCH", "/api/nodes/"+n2.ID, map[string]any{"name": "report.pdf"}), 409)
	alice.must(alice.req("PATCH", "/api/nodes/"+n2.ID, map[string]any{"name": "final.pdf"}), 200)
	alice.must(alice.req("PATCH", "/api/nodes/"+root, map[string]any{"name": "x"}), 403)
	b := alice.mkdir(a.ID, "b")
	// A folder cannot move into itself or below itself.
	alice.must(alice.req("POST", "/api/nodes/move", map[string]any{"ids": []string{a.ID}, "parentId": b.ID}), 400)
	alice.must(alice.req("POST", "/api/nodes/move", map[string]any{"ids": []string{a.ID}, "parentId": a.ID}), 400)
	alice.must(alice.req("POST", "/api/nodes/copy", map[string]any{"ids": []string{a.ID}, "parentId": b.ID}), 400)
	// Move by drag and drop; clash gets a number.
	alice.upload(b.ID, "final.pdf", []byte("other"))
	var moved struct{ Items []node }
	alice.must(alice.req("POST", "/api/nodes/move", map[string]any{"ids": []string{n2.ID}, "parentId": b.ID}), 200).json(&moved)
	if moved.Items[0].Name != "final (1).pdf" {
		t.Fatalf("moved name %q", moved.Items[0].Name)
	}
	// Copy a whole folder: new ids, same bytes, original untouched.
	var copied struct{ Items []node }
	alice.must(alice.req("POST", "/api/nodes/copy", map[string]any{"ids": []string{a.ID}, "parentId": root}), 201).json(&copied)
	if copied.Items[0].Name != "café (1)" || copied.Items[0].ID == a.ID {
		t.Fatalf("copy: %+v", copied.Items)
	}
	inner := names(alice.children(copied.Items[0].ID))
	if strings.Join(inner, ",") != "b,Report (2).pdf,report.pdf" {
		t.Fatalf("copied folder: %v", inner)
	}
	// Search uses the trigram index and only sees the user's own space.
	var found struct{ Items []node }
	alice.must(alice.get("/api/search?q=EPOR"), 200).json(&found)
	if len(found.Items) != 4 {
		t.Fatalf("search found %v", names(found.Items))
	}
	alice.must(alice.get("/api/search?q=%25"), 200).json(&found)
	if len(found.Items) != 0 {
		t.Fatalf("LIKE wildcard not escaped: %v", names(found.Items))
	}
	// Stars and recents.
	alice.must(alice.req("PUT", "/api/nodes/"+n1.ID+"/star", nil), 204)
	var starred struct{ Items []node }
	alice.must(alice.get("/api/starred"), 200).json(&starred)
	if len(starred.Items) != 1 || !starred.Items[0].Starred {
		t.Fatalf("starred: %+v", starred.Items)
	}
	var recent struct{ Items []node }
	alice.must(alice.get("/api/recent"), 200).json(&recent)
	if len(recent.Items) == 0 || recent.Items[0].IsDir {
		t.Fatalf("recent: %+v", recent.Items)
	}
	// Sorting.
	alice.upload(root, "zz-small.txt", []byte("1"))
	alice.upload(root, "aa-big.txt", randomBytes(1000))
	var listing struct{ Items []node }
	alice.must(alice.get("/api/nodes/"+root+"/children?sort=size&order=desc"), 200).json(&listing)
	files := []string{}
	for _, n := range listing.Items {
		if !n.IsDir {
			files = append(files, n.Name)
		}
	}
	if strings.Join(files, ",") != "aa-big.txt,zz-small.txt" {
		t.Fatalf("size sort: %v", files)
	}
}

func TestTrashRestorePurge(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	root := alice.root()
	dir := alice.mkdir(root, "Docs")
	f := alice.upload(dir.ID, "a.txt", []byte("aaa"))
	g := alice.upload(dir.ID, "b.txt", []byte("bbb"))
	alice.must(alice.req("DELETE", "/api/nodes/"+g.ID, nil), 204)
	alice.must(alice.req("POST", "/api/nodes/trash", map[string]any{"ids": []string{dir.ID}}), 204)
	if len(alice.children(root)) != 0 {
		t.Fatal("trashed folder still listed")
	}
	alice.must(alice.get("/api/nodes/"+f.ID+"/content"), 404)
	var tr struct {
		Items []struct {
			ID         string    `json:"id"`
			FromFolder string    `json:"fromFolder"`
			PurgeAt    time.Time `json:"purgeAt"`
		}
	}
	alice.must(alice.get("/api/trash"), 200).json(&tr)
	if len(tr.Items) != 2 {
		t.Fatalf("trash: %+v", tr.Items)
	}
	// A name now taken at the original place gets a number on restore.
	alice.mkdir(root, "Docs")
	var restored struct{ Node node }
	alice.must(alice.req("POST", "/api/trash/"+dir.ID+"/restore", nil), 200).json(&restored)
	if restored.Node.Name != "Docs (1)" {
		t.Fatalf("restored name %q", restored.Node.Name)
	}
	if got := names(alice.children(dir.ID)); strings.Join(got, ",") != "a.txt" {
		t.Fatalf("restored children: %v (b.txt was trashed separately)", got)
	}
	alice.must(alice.req("POST", "/api/trash/"+g.ID+"/restore", nil), 200)
	alice.must(alice.req("DELETE", "/api/nodes/"+dir.ID, nil), 204)
	// Purge after 30 days removes rows and, once unreferenced, the blob.
	var blob string
	e.st.Pool.QueryRow(context.Background(), "SELECT blob_id FROM nodes WHERE id = $1", f.ID).Scan(&blob)
	blobPath := filepath.Join(e.dir, "blobs", blob[:2], blob)
	if _, err := os.Stat(blobPath); err != nil {
		t.Fatal(err)
	}
	e.st.Pool.Exec(context.Background(), "UPDATE nodes SET trashed_at = now() - interval '31 days' WHERE trash_root IS NOT NULL")
	e.s.Cleanup(context.Background())
	alice.must(alice.get("/api/trash"), 200).json(&tr)
	if len(tr.Items) != 0 {
		t.Fatalf("trash after purge: %+v", tr.Items)
	}
	if _, err := os.Stat(blobPath); !os.IsNotExist(err) {
		t.Fatal("blob of purged file still on disk")
	}
	// A copied blob survives deletion of the original.
	x := alice.upload(root, "x.txt", []byte("shared blob"))
	var cp struct{ Items []node }
	alice.must(alice.req("POST", "/api/nodes/copy", map[string]any{"ids": []string{x.ID}, "parentId": root}), 201).json(&cp)
	alice.must(alice.req("DELETE", "/api/nodes/"+x.ID, nil), 204)
	alice.must(alice.req("DELETE", "/api/trash", nil), 200)
	e.s.Cleanup(context.Background())
	if body := alice.must(alice.get("/api/nodes/"+cp.Items[0].ID+"/content"), 200).Body; string(body) != "shared blob" {
		t.Fatalf("copy after original deleted: %q", body)
	}
}

func TestRangeRequestsAndContentHeaders(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	root := alice.root()
	data := randomBytes(100_000)
	v := alice.upload(root, "clip.mp4", data)
	r := alice.must(alice.get("/api/nodes/"+v.ID+"/raw", "Range", "bytes=1000-1999"), 206)
	if !bytes.Equal(r.Body, data[1000:2000]) || r.Header.Get("Content-Range") != "bytes 1000-1999/100000" {
		t.Fatalf("range: %d bytes, %s", len(r.Body), r.Header.Get("Content-Range"))
	}
	if r.Header.Get("Content-Type") != "video/mp4" || !strings.HasPrefix(r.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("video headers: %v", r.Header)
	}
	checkSafe := func(r *resp) {
		t.Helper()
		if r.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(r.Header.Get("Content-Security-Policy"), "sandbox; default-src 'none'") ||
			r.Header.Get("Cache-Control") != "private, no-store" || r.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("unsafe headers: %v", r.Header)
		}
	}
	checkSafe(r)
	// Script-capable types are never inline: they are plain text attachments.
	for _, name := range []string{"evil.html", "evil.svg", "evil.xml", "evil.xhtml", "evil.js", "noext"} {
		n := alice.upload(root, name, []byte("<script>alert(1)</script>"))
		raw := alice.must(alice.get("/api/nodes/"+n.ID+"/raw"), 200)
		checkSafe(raw)
		ct := raw.Header.Get("Content-Type")
		if !strings.HasPrefix(raw.Header.Get("Content-Disposition"), "attachment") || strings.Contains(ct, "html") || strings.Contains(ct, "svg") || strings.Contains(ct, "xml") {
			t.Errorf("%s served as %s / %s", name, ct, raw.Header.Get("Content-Disposition"))
		}
		dl := alice.must(alice.get("/api/nodes/"+n.ID+"/content"), 200)
		checkSafe(dl)
		if dl.Header.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(dl.Header.Get("Content-Disposition"), "attachment") {
			t.Errorf("%s download headers %v", name, dl.Header)
		}
	}
	p := alice.upload(root, "pic.png", pngBytes(t))
	img := alice.must(alice.get("/api/nodes/"+p.ID+"/raw"), 200)
	checkSafe(img)
	if img.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("png type %s", img.Header.Get("Content-Type"))
	}
	th := alice.must(alice.get("/api/nodes/"+p.ID+"/thumbnail?size=256"), 200)
	checkSafe(th)
	cfg, format, err := image.DecodeConfig(bytes.NewReader(th.Body))
	if err != nil || format != "jpeg" || cfg.Width != 256 || cfg.Height != 192 {
		t.Fatalf("thumbnail %s %dx%d %v", format, cfg.Width, cfg.Height, err)
	}
	alice.must(alice.get("/api/nodes/"+p.ID+"/thumbnail?size=999"), 400)
	alice.must(alice.get("/api/nodes/"+v.ID+"/thumbnail"), 404)
	// Unicode file names survive Content-Disposition.
	u := alice.upload(root, "résumé \"final\".txt", []byte("cv"))
	if cd := alice.must(alice.get("/api/nodes/"+u.ID+"/content"), 200).Header.Get("Content-Disposition"); !strings.Contains(cd, "filename*=utf-8''r%C3%A9sum%C3%A9") {
		t.Fatalf("content-disposition %q", cd)
	}
	// API responses are not cacheable and carry no CORS headers.
	me := alice.must(alice.get("/api/me", "Origin", "https://evil.example"), 200)
	if me.Header.Get("Cache-Control") != "private, no-store" || me.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("api headers %v", me.Header)
	}
	// The SPA page has a strict CSP.
	page := alice.must(alice.get("/"), 200)
	csp := page.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval';") || strings.Contains(csp, "unsafe-inline' 'self'") || strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Fatalf("spa csp %q", csp)
	}
}

func TestZipDownloadAndArchiveListing(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	root := alice.root()
	dir := alice.mkdir(root, "Project")
	sub := alice.mkdir(dir.ID, "src")
	alice.upload(dir.ID, "README.md", []byte("# hi"))
	alice.upload(sub.ID, "main.go", []byte("package main"))
	gone := alice.upload(sub.ID, "deleted.txt", []byte("x"))
	alice.must(alice.req("DELETE", "/api/nodes/"+gone.ID, nil), 204)
	other := alice.mkdir(root, "Other")
	alice.mkdir(other.ID, "Project")
	r := alice.must(alice.get("/api/zip?id="+dir.ID), 200)
	if r.Header.Get("Content-Type") != "application/zip" || !strings.Contains(r.Header.Get("Content-Disposition"), "Project.zip") {
		t.Fatalf("zip headers %v", r.Header)
	}
	zr, err := zip.NewReader(bytes.NewReader(r.Body), int64(len(r.Body)))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		got[f.Name] = string(b)
	}
	want := map[string]string{"Project/": "", "Project/README.md": "# hi", "Project/src/": "", "Project/src/main.go": "package main"}
	if len(got) != len(want) {
		t.Fatalf("zip entries %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("zip entry %s = %q", k, got[k])
		}
	}
	// Two selected folders with the same name do not collide.
	q := "/api/zip?id=" + dir.ID + "&id=" + mustChild(t, alice, other.ID, "Project")
	zr2b := alice.must(alice.get(q), 200).Body
	zr2, _ := zip.NewReader(bytes.NewReader(zr2b), int64(len(zr2b)))
	seen := map[string]bool{}
	for _, f := range zr2.File {
		seen[f.Name] = true
	}
	if !seen["Project/"] || !seen["Project (1)/"] {
		t.Fatalf("multi zip entries %v", seen)
	}
	// ZIP files can be listed in the viewer.
	z := alice.upload(root, "bundle.zip", zipBytes(t, map[string]string{"a.txt": "a", "dir/b.txt": "bb"}))
	var listing struct {
		Entries []struct {
			Name string
			Size int
		}
		Total int
	}
	alice.must(alice.get("/api/nodes/"+z.ID+"/archive"), 200).json(&listing)
	if listing.Total != 2 {
		t.Fatalf("listing %+v", listing)
	}
	broken := alice.upload(root, "broken.zip", []byte("not a zip"))
	alice.must(alice.get("/api/nodes/"+broken.ID+"/archive"), 422)
}

func mustChild(t *testing.T, c *client, parent, name string) string {
	for _, n := range c.children(parent) {
		if n.Name == name {
			return n.ID
		}
	}
	t.Fatalf("no %s in %s", name, parent)
	return ""
}

func TestRequestForgeryRules(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	root := alice.root()
	body := map[string]any{"parentId": root, "name": "x"}
	alice.must(alice.req("POST", "/api/folders", body, "X-Requested-With", ""), 403)
	alice.must(alice.req("POST", "/api/folders", body, "X-Requested-With", "XMLHttpRequest"), 403)
	alice.must(alice.req("POST", "/api/folders", body, "Origin", "https://pdf.lab.localhost"), 403)
	alice.must(alice.req("POST", "/api/folders", body, "Origin", "https://storage.lab.localhost.evil.com"), 403)
	alice.must(alice.req("POST", "/api/folders", body, "Origin", "null"), 403)
	alice.must(alice.req("POST", "/api/folders", body, "Content-Type", "text/plain"), 403)
	alice.must(alice.req("POST", "/api/folders", body, "Content-Type", "application/x-www-form-urlencoded"), 403)
	// octet-stream is only for upload chunks.
	alice.must(alice.req("POST", "/api/folders", []byte(`{"parentId":"`+root+`","name":"x"}`)), 403)
	alice.must(alice.req("DELETE", "/api/trash", nil, "Origin", "https://pdf.lab.localhost"), 403)
	if len(alice.children(root)) != 0 {
		t.Fatal("a refused request changed state")
	}
	alice.must(alice.req("POST", "/api/folders", body, "Origin", origin), 201)
	// GET never changes state: mutating routes do not answer GET.
	alice.must(alice.get("/api/nodes/trash"), 404)
	alice.must(alice.req("OPTIONS", "/api/me", nil), 405)
	if e.metric(`storage_forgery_refused_total{reason="origin"}`) < 4 {
		t.Fatal("refusals not counted")
	}
}

func TestLogsAndMetricsNeverCarryTokens(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	f := alice.upload(alice.root(), "x.txt", []byte("x"))
	l := alice.link(f.ID, map[string]any{"kind": "view", "password": "s3cret-pass"})
	g := e.guest()
	g.req("POST", "/api/public/"+l.Token+"/unlock", map[string]any{"password": "s3cret-pass"})
	g.get("/api/public/" + l.Token + "/nodes/" + f.ID + "/content")
	g.get("/s/" + l.Token)
	logs := e.logs.String()
	for _, secret := range []string{l.Token, "s3cret-pass", "storage_link_"} {
		if strings.Contains(logs, secret) {
			t.Fatalf("logs contain %q", secret)
		}
	}
	if !strings.Contains(logs, `"path":"/api/public/{token}/nodes/`+f.ID+`/content"`) || !strings.Contains(logs, `"route":"/api/public/{token}/nodes/{id}/content"`) {
		t.Fatalf("access log missing redacted path: %s", logs)
	}
	for _, key := range []string{`"level":"info"`, `"service":"storage"`, `"trace_id":"`, `"user":"alice"`, `"duration_ms":`, `"status":200`} {
		if !strings.Contains(logs, key) {
			t.Errorf("log lines lack %s", key)
		}
	}
	res, _ := http.Get(e.metSrv.URL + "/metrics")
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	metrics := string(b)
	if strings.Contains(metrics, l.Token) {
		t.Fatal("metrics contain a token")
	}
	for _, name := range []string{"http_server_request_duration_seconds_bucket", "http_server_active_requests", "storage_download_bytes_total", "storage_files", "storage_volume_free_bytes", "go_goroutines", "process_cpu_seconds_total"} {
		if !strings.Contains(metrics, name) {
			t.Errorf("metrics lack %s", name)
		}
	}
	// The app port does not serve metrics.
	alice.must(alice.get("/metrics"), 200) // the SPA, not Prometheus text
	if strings.Contains(string(alice.get("/metrics").Body), "go_goroutines") {
		t.Fatal("metrics on the app port")
	}
}

func TestOfficePreviewThroughStirling(t *testing.T) {
	var calls, inFlight, maxInFlight atomic.Int32
	stirling := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			m := maxInFlight.Load()
			if n <= m || maxInFlight.CompareAndSwap(m, n) {
				break
			}
		}
		if r.URL.Path != "/api/v1/convert/file/pdf" {
			http.NotFound(w, r)
			return
		}
		f, hdr, err := r.FormFile("fileInput")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		b, _ := io.ReadAll(f)
		switch {
		case strings.Contains(string(b), "hang"):
			time.Sleep(3 * time.Second)
		case strings.Contains(string(b), "fail"):
			http.Error(w, "conversion failed", 500)
			return
		}
		time.Sleep(100 * time.Millisecond)
		w.Header().Set("Content-Type", "application/pdf")
		w.Write([]byte("%PDF-1.7 converted " + hdr.Filename))
	}))
	defer stirling.Close()
	e := newEnv(t, func(c *config.Config) {
		c.StirlingURL = stirling.URL
		c.OfficeTimeout = time.Second
	})
	alice := e.as("alice")
	root := alice.root()
	doc := alice.upload(root, "Quarterly report.docx", []byte("docx bytes"))
	first := alice.get("/api/nodes/" + doc.ID + "/office-preview")
	if first.Status != 202 || first.Header.Get("Retry-After") == "" {
		t.Fatalf("first request should start the conversion and answer 202: %d %s", first.Status, first.Body)
	}
	r := alice.must(pollOffice(alice, doc.ID), 200)
	if string(r.Body) != "%PDF-1.7 converted document.docx" || r.Header.Get("Content-Type") != "application/pdf" {
		t.Fatalf("preview %q %v", r.Body, r.Header)
	}
	alice.must(alice.get("/api/nodes/"+doc.ID+"/office-preview"), 200)
	if calls.Load() != 1 {
		t.Fatalf("cache missed: %d calls", calls.Load())
	}
	bad := alice.upload(root, "bad.xlsx", []byte("fail"))
	alice.must(pollOffice(alice, bad.ID), 422)
	slow := alice.upload(root, "slow.pptx", []byte("hang"))
	start := time.Now()
	alice.must(pollOffice(alice, slow.ID), 422)
	if time.Since(start) > 2500*time.Millisecond {
		t.Fatalf("timeout not enforced: %v", time.Since(start))
	}
	if !strings.Contains(e.logs.String(), "office conversion failed") {
		t.Fatal("failed conversion not logged")
	}
	// Concurrency is capped at 2.
	for inFlight.Load() > 0 {
		time.Sleep(50 * time.Millisecond)
	}
	maxInFlight.Store(0)
	calls.Store(0)
	done := make(chan int, 5)
	for i := 0; i < 5; i++ {
		d := alice.upload(root, "doc"+strconv.Itoa(i)+".odt", []byte("ok "+strconv.Itoa(i)))
		go func() { done <- pollOffice(alice, d.ID).Status }()
	}
	for i := 0; i < 5; i++ {
		if s := <-done; s != 200 {
			t.Errorf("concurrent preview status %d", s)
		}
	}
	if maxInFlight.Load() > 2 {
		t.Fatalf("%d conversions ran at once", maxInFlight.Load())
	}
	alice.must(alice.get("/api/nodes/"+alice.upload(root, "n.txt", []byte("x")).ID+"/office-preview"), 400)
}

func TestParallelUploadsOfOneFolderShareItsFolders(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	root := alice.root()
	done := make(chan node, 12)
	for i := 0; i < 12; i++ {
		go func() {
			done <- alice.uploadTo("", root, "Trip notes/day "+strconv.Itoa(i%2), "f"+strconv.Itoa(i)+".txt", []byte("x"))
		}()
	}
	for i := 0; i < 12; i++ {
		<-done
	}
	top := alice.children(root)
	if len(top) != 1 || top[0].Name != "Trip notes" {
		t.Fatalf("top level: %v", names(top))
	}
	days := alice.children(top[0].ID)
	if strings.Join(names(days), ",") != "day 0,day 1" {
		t.Fatalf("days: %v", names(days))
	}
	if n := len(alice.children(days[0].ID)) + len(alice.children(days[1].ID)); n != 12 {
		t.Fatalf("%d files", n)
	}
	// A file that holds the name gets a numbered folder beside it.
	alice.upload(root, "notes", []byte("a file"))
	alice.uploadTo("", root, "notes", "a.txt", []byte("x"))
	if got := strings.Join(names(alice.children(root)), ","); got != "notes (1),Trip notes,notes" {
		t.Fatalf("root: %s", got)
	}
}

// pollOffice asks for an Office preview until it is no longer being prepared.
func pollOffice(c *client, id string) *resp {
	c.e.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		r := c.get("/api/nodes/" + id + "/office-preview")
		if r.Status != http.StatusAccepted || time.Now().After(deadline) {
			return r
		}
		time.Sleep(50 * time.Millisecond)
	}
}
