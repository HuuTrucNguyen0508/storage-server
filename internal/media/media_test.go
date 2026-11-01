package media

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"storage-server/internal/disk"
)

const wantCSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"

func TestHeaders(t *testing.T) {
	for _, c := range []struct {
		name        string
		download    bool
		contentType string
		disposition string
	}{
		{"page.html", false, "text/plain; charset=utf-8", "inline; filename*=UTF-8''page.html"},
		{"PAGE.HTM", false, "text/plain; charset=utf-8", "inline; filename*=UTF-8''PAGE.HTM"},
		{"x.js", false, "text/plain; charset=utf-8", "inline; filename*=UTF-8''x.js"},
		{"x.svg", false, "image/svg+xml", "inline; filename*=UTF-8''x.svg"},
		{"x.pdf", false, "application/pdf", "inline; filename*=UTF-8''x.pdf"},
		{"x.jpg", true, "image/jpeg", "attachment; filename*=UTF-8''x.jpg"},
		{"x.exe", false, "application/octet-stream", "attachment; filename*=UTF-8''x.exe"},
		{"noext", false, "application/octet-stream", "attachment; filename*=UTF-8''noext"},
		{"naïve \"q\".txt", false, "text/plain; charset=utf-8", "inline; filename*=UTF-8''na%C3%AFve%20%22q%22.txt"},
	} {
		h := http.Header{}
		SetHeaders(h, c.name, c.download)
		for key, want := range map[string]string{
			"Content-Type":                 c.contentType,
			"Content-Disposition":          c.disposition,
			"Content-Security-Policy":      wantCSP,
			"X-Content-Type-Options":       "nosniff",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Referrer-Policy":              "no-referrer",
		} {
			if got := h.Get(key); got != want {
				t.Errorf("%s %s = %q, want %q", c.name, key, got, want)
			}
		}
	}
}

func TestClassOfFollowsThePolicyTable(t *testing.T) {
	for name, want := range map[string]Class{
		"a.JPG": ClassImage, "a.svg": ClassImage, "a.mkv": ClassVideo, "a.flac": ClassAudio,
		"a.pdf": ClassPDF, "a.md": ClassText, "a.html": ClassText, "a.exe": ClassNone, "a": ClassNone,
	} {
		if got := ClassOf(name); got != want {
			t.Errorf("ClassOf(%s) = %q, want %q", name, got, want)
		}
	}
}

func tree(t *testing.T) (*disk.Disk, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	d, err := disk.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d, root
}

func write(t *testing.T, root, rel string, body []byte) {
	t.Helper()
	full := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func parse(t *testing.T, raw string) disk.Path {
	t.Helper()
	p, err := disk.ParsePath(raw)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func open(t *testing.T, d *disk.Disk, raw string) *disk.File {
	t.Helper()
	f, err := d.Files.Open(parse(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func TestServeGivesRangeAndAStrongValidator(t *testing.T) {
	d, root := tree(t)
	write(t, root, "a.txt", []byte("0123456789"))
	f := open(t, d, "a.txt")
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Range", "bytes=2-4")
	rec := httptest.NewRecorder()
	Serve(rec, req, f, false)
	if rec.Code != 206 || rec.Body.String() != "234" || rec.Header().Get("Content-Range") != "bytes 2-4/10" {
		t.Fatalf("%d %q %q", rec.Code, rec.Body, rec.Header().Get("Content-Range"))
	}
	tag := rec.Header().Get("Etag")
	if len(tag) != 26 || tag[0] != '"' {
		t.Fatalf("etag = %q", tag)
	}
	req.Header.Set("If-Range", tag)
	rec = httptest.NewRecorder()
	if _, err := f.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	Serve(rec, req, f, false)
	if rec.Code != 206 {
		t.Fatalf("matching If-Range = %d", rec.Code)
	}
	req.Header.Set("If-Range", `"stale"`)
	rec = httptest.NewRecorder()
	if _, err := f.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	Serve(rec, req, f, false)
	if rec.Code != 200 || rec.Body.Len() != 10 {
		t.Fatalf("stale If-Range = %d, %d bytes", rec.Code, rec.Body.Len())
	}
}

func pngBytes(t *testing.T, w, h int, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func decodeThumb(t *testing.T, r io.ReadSeekCloser) image.Image {
	t.Helper()
	defer r.Close()
	img, err := jpeg.Decode(r)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func TestThumbnailFitsAndCaches(t *testing.T) {
	d, root := tree(t)
	cache := filepath.Join(t.TempDir(), "thumbs")
	th := NewThumbnails(cache)
	write(t, root, "wide.png", pngBytes(t, 800, 400, color.RGBA{R: 200, A: 255}))
	f := open(t, d, "wide.png")
	r, _, err := th.Get(context.Background(), f, 256)
	if err != nil {
		t.Fatal(err)
	}
	if b := decodeThumb(t, r).Bounds(); b.Dx() != 256 || b.Dy() != 128 {
		t.Fatalf("thumb = %v", b)
	}
	first, err := os.ReadDir(cache)
	if err != nil || len(first) != 1 {
		t.Fatalf("cache = %v, %v", first, err)
	}
	r, _, err = th.Get(context.Background(), f, 256)
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	if again, _ := os.ReadDir(cache); len(again) != 1 {
		t.Fatalf("cache grew to %v", again)
	}
	write(t, root, "small.png", pngBytes(t, 40, 20, color.Black))
	r, _, err = th.Get(context.Background(), open(t, d, "small.png"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if b := decodeThumb(t, r).Bounds(); b.Dx() != 40 {
		t.Fatalf("a small image was upscaled: %v", b)
	}
}

func withOrientation(jpg []byte, o uint16) []byte {
	var e bytes.Buffer
	e.WriteString("Exif\x00\x00II*\x00")
	binary.Write(&e, binary.LittleEndian, uint32(8))
	binary.Write(&e, binary.LittleEndian, uint16(1))
	binary.Write(&e, binary.LittleEndian, uint16(0x0112))
	binary.Write(&e, binary.LittleEndian, uint16(3))
	binary.Write(&e, binary.LittleEndian, uint32(1))
	binary.Write(&e, binary.LittleEndian, o)
	e.Write([]byte{0, 0})
	binary.Write(&e, binary.LittleEndian, uint32(0))
	var out bytes.Buffer
	out.Write(jpg[:2])
	out.Write([]byte{0xFF, 0xE1})
	binary.Write(&out, binary.BigEndian, uint16(e.Len()+2))
	out.Write(e.Bytes())
	out.Write(jpg[2:])
	return out.Bytes()
}

func TestThumbnailHonoursEXIFOrientation(t *testing.T) {
	d, root := tree(t)
	img := image.NewRGBA(image.Rect(0, 0, 400, 200))
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	write(t, root, "phone.jpg", withOrientation(b.Bytes(), 6))
	r, _, err := NewThumbnails(t.TempDir()).Get(context.Background(), open(t, d, "phone.jpg"), 256)
	if err != nil {
		t.Fatal(err)
	}
	if got := decodeThumb(t, r).Bounds(); got.Dx() != 128 || got.Dy() != 256 {
		t.Fatalf("thumb = %v, want a portrait 128x256", got)
	}
}

func bombPNG() []byte {
	var b bytes.Buffer
	b.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], 100_000)
	binary.BigEndian.PutUint32(ihdr[4:], 100_000)
	ihdr[8], ihdr[9] = 8, 6
	binary.Write(&b, binary.BigEndian, uint32(len(ihdr)))
	sum := crc32.NewIEEE()
	sum.Write([]byte("IHDR"))
	sum.Write(ihdr)
	b.WriteString("IHDR")
	b.Write(ihdr)
	binary.Write(&b, binary.BigEndian, sum.Sum32())
	return b.Bytes()
}

func TestThumbnailRefusals(t *testing.T) {
	d, root := tree(t)
	th := NewThumbnails(t.TempDir())
	write(t, root, "bomb.png", bombPNG())
	write(t, root, "a.svg", []byte("<svg/>"))
	write(t, root, "fake.jpg", []byte("not an image"))
	write(t, root, "doc.pdf", []byte("%PDF"))
	for _, name := range []string{"bomb.png", "a.svg", "fake.jpg", "doc.pdf"} {
		if _, _, err := th.Get(context.Background(), open(t, d, name), 256); !errors.Is(err, ErrNoThumbnail) {
			t.Errorf("%s = %v", name, err)
		}
	}
}

func zipEntries(t *testing.T, b []byte) map[string]string {
	t.Helper()
	r, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range r.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		if f.Method != zip.Store {
			t.Errorf("%s uses method %d", f.Name, f.Method)
		}
		out[f.Name] = string(body)
	}
	return out
}

func joined(m map[string]string) string {
	var parts []string
	for k, v := range m {
		parts = append(parts, k+"="+v)
	}
	slices.Sort(parts)
	return strings.Join(parts, " ")
}

func TestZipSelection(t *testing.T) {
	d, root := tree(t)
	write(t, root, "a/x.txt", []byte("ax"))
	write(t, root, "a/sub/y.txt", []byte("ay"))
	write(t, root, "b/x.txt", []byte("bx"))
	write(t, root, `b/back\slash.txt`, []byte("bs"))
	if err := os.MkdirAll(filepath.Join(root, "a/empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "a/link")); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	err := WriteZip(context.Background(), &b, d.Files, []disk.Path{parse(t, "a"), parse(t, "a/x.txt"), parse(t, "b/x.txt"), parse(t, `b/back\slash.txt`)})
	if err != nil {
		t.Fatal(err)
	}
	want := "a/= a/empty/= a/sub/= a/sub/y.txt=ay a/x.txt=ax back_slash.txt=bs x.txt (1)=bx x.txt=ax"
	if got := joined(zipEntries(t, b.Bytes())); got != want {
		t.Fatalf("zip =\n%s\nwant\n%s", got, want)
	}
}

func TestZipOfARootHasNoLeadingFolder(t *testing.T) {
	d, root := tree(t)
	write(t, root, "share/x.txt", []byte("x"))
	sub, err := d.Files.Sub(parse(t, "share"))
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	var b bytes.Buffer
	if err := WriteZip(context.Background(), &b, sub, []disk.Path{{}}); err != nil {
		t.Fatal(err)
	}
	if got := joined(zipEntries(t, b.Bytes())); got != "x.txt=x" {
		t.Fatalf("zip = %s", got)
	}
}

func TestZipStopsOnAnUnreadableFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	d, root := tree(t)
	write(t, root, "a/1.txt", []byte("one"))
	write(t, root, "a/2.txt", []byte("two"))
	if err := os.Chmod(filepath.Join(root, "a/2.txt"), 0); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := WriteZip(context.Background(), &b, d.Files, []disk.Path{parse(t, "a")}); err == nil {
		t.Fatal("a read error did not stop the zip")
	}
}
