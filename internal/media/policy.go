// Package media decides how bytes leave the server: the content-type policy for
// hostile files, thumbnails, and the streamed zip.
package media

import (
	"context"
	"io"
	"net/http"
	"time"

	"storage-server/internal/disk"
)

// Class is what the frontend may preview. It is derived from the same table as
// the headers, so the app can never offer a preview the server refuses.
type Class string

const (
	ClassNone  Class = ""
	ClassImage Class = "image"
	ClassVideo Class = "video"
	ClassAudio Class = "audio"
	ClassPDF   Class = "pdf"
	ClassText  Class = "text"
)

// sandbox makes a navigated document a script-free opaque origin. Nothing the
// server sends for stored bytes omits it except PDF, whose browser viewer the
// harness must prove cannot run script either.
const (
	sandboxCSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"
	pdfCSP     = "default-src 'none'; object-src 'self'; script-src 'none'"
)

type rule struct {
	contentType string
	class       Class
	csp         string
}

// rules is keyed by lowercase extension and is the whole policy. The uploader's
// claimed type is never read and the browser may not sniff. HTML, JS and CSS map
// to text/plain, so a hostile page previews as its source. An unlisted extension
// is application/octet-stream with attachment.
var rules = map[string]rule{
	".jpg": {"image/jpeg", ClassImage, sandboxCSP}, ".jpeg": {"image/jpeg", ClassImage, sandboxCSP},
	".png": {"image/png", ClassImage, sandboxCSP}, ".gif": {"image/gif", ClassImage, sandboxCSP},
	".webp": {"image/webp", ClassImage, sandboxCSP}, ".avif": {"image/avif", ClassImage, sandboxCSP},
	".svg": {"image/svg+xml", ClassImage, sandboxCSP},
	".mp4": {"video/mp4", ClassVideo, sandboxCSP}, ".m4v": {"video/mp4", ClassVideo, sandboxCSP},
	".webm": {"video/webm", ClassVideo, sandboxCSP}, ".mov": {"video/quicktime", ClassVideo, sandboxCSP},
	".mkv": {"video/x-matroska", ClassVideo, sandboxCSP},
	".mp3": {"audio/mpeg", ClassAudio, sandboxCSP}, ".m4a": {"audio/mp4", ClassAudio, sandboxCSP},
	".flac": {"audio/flac", ClassAudio, sandboxCSP}, ".ogg": {"audio/ogg", ClassAudio, sandboxCSP},
	".opus": {"audio/ogg", ClassAudio, sandboxCSP}, ".wav": {"audio/wav", ClassAudio, sandboxCSP},
	".pdf": {"application/pdf", ClassPDF, pdfCSP},
	".txt": {"text/plain; charset=utf-8", ClassText, sandboxCSP}, ".md": {"text/plain; charset=utf-8", ClassText, sandboxCSP},
	".log": {"text/plain; charset=utf-8", ClassText, sandboxCSP}, ".csv": {"text/plain; charset=utf-8", ClassText, sandboxCSP},
	".json": {"text/plain; charset=utf-8", ClassText, sandboxCSP}, ".yaml": {"text/plain; charset=utf-8", ClassText, sandboxCSP},
	".yml": {"text/plain; charset=utf-8", ClassText, sandboxCSP}, ".xml": {"text/plain; charset=utf-8", ClassText, sandboxCSP},
	".html": {"text/plain; charset=utf-8", ClassText, sandboxCSP}, ".htm": {"text/plain; charset=utf-8", ClassText, sandboxCSP},
	".js": {"text/plain; charset=utf-8", ClassText, sandboxCSP}, ".css": {"text/plain; charset=utf-8", ClassText, sandboxCSP},
}

// ClassOf is what a listing reports for a name.
func ClassOf(name string) Class { panic("not implemented") }

// SetHeaders writes every header for stored bytes: type, CSP, nosniff,
// disposition, CORP, no-referrer. It is the only code that sets them, and
// serving a file without calling it is impossible because Serve calls it.
func SetHeaders(h http.Header, name string, download bool) { panic("not implemented") }

// Serve answers one file through http.ServeContent, which gives Range, If-Range
// and sendfile. The caller's writer must keep ReadFrom for sendfile to apply.
func Serve(w http.ResponseWriter, r *http.Request, f *disk.File, download bool) {
	SetHeaders(w.Header(), f.Info.Name, download)
	http.ServeContent(w, r, "", f.Info.ModTime, f)
}

// Thumbnails renders and caches JPEG previews under the state directory.
type Thumbnails struct {
	dir   string
	limit chan struct{}
}

func NewThumbnails(dir string) *Thumbnails { panic("not implemented") }

// Get returns a cached or fresh JPEG. The key is device, inode, size, mtime and
// width, so a replaced file misses. It checks dimensions with DecodeConfig
// before decoding, so a decompression bomb is refused. SVG is never rasterised.
func (t *Thumbnails) Get(ctx context.Context, tree *disk.Tree, p disk.Path, width int) (io.ReadSeekCloser, time.Time, error) {
	panic("not implemented")
}

// Prune deletes the oldest cache files past the size bound.
func (t *Thumbnails) Prune(ctx context.Context) error { panic("not implemented") }

// WriteZip streams the selection with archive/zip, method Store, through the
// tree's Walk, so symlinks and other kinds are skipped by construction. A
// backslash in an entry name becomes "_" so a Windows extractor cannot read it
// as a separator. An error after the first byte aborts the connection, so a
// truncated body cannot look like a complete archive.
func WriteZip(ctx context.Context, w io.Writer, tree *disk.Tree, paths []disk.Path) error {
	panic("not implemented")
}
