// Package media decides how bytes leave the server: the content-type policy for
// hostile files, thumbnails, and the streamed zip.
package media

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
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

// sandboxCSP makes a navigated document a script-free opaque origin. Every stored
// byte gets it. PDF is no exception: the frontend renders it with pdfjs-dist on a
// canvas, so no browser viewer needs a looser policy.
const sandboxCSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"

type rule struct {
	contentType string
	class       Class
}

// rules is keyed by lowercase extension and is the whole policy. The uploader's
// claimed type is never read and the browser may not sniff. HTML, JS and CSS map
// to text/plain, so a hostile page previews as its source. An unlisted extension
// is application/octet-stream with attachment.
var rules = map[string]rule{
	".jpg": {"image/jpeg", ClassImage}, ".jpeg": {"image/jpeg", ClassImage},
	".png": {"image/png", ClassImage}, ".gif": {"image/gif", ClassImage},
	".webp": {"image/webp", ClassImage}, ".avif": {"image/avif", ClassImage},
	".svg": {"image/svg+xml", ClassImage},
	".mp4": {"video/mp4", ClassVideo}, ".m4v": {"video/mp4", ClassVideo},
	".webm": {"video/webm", ClassVideo}, ".mov": {"video/quicktime", ClassVideo},
	".mkv": {"video/x-matroska", ClassVideo},
	".mp3": {"audio/mpeg", ClassAudio}, ".m4a": {"audio/mp4", ClassAudio},
	".flac": {"audio/flac", ClassAudio}, ".ogg": {"audio/ogg", ClassAudio},
	".opus": {"audio/ogg", ClassAudio}, ".wav": {"audio/wav", ClassAudio},
	".pdf": {"application/pdf", ClassPDF},
	".txt": {"text/plain; charset=utf-8", ClassText}, ".md": {"text/plain; charset=utf-8", ClassText},
	".log": {"text/plain; charset=utf-8", ClassText}, ".csv": {"text/plain; charset=utf-8", ClassText},
	".json": {"text/plain; charset=utf-8", ClassText}, ".yaml": {"text/plain; charset=utf-8", ClassText},
	".yml": {"text/plain; charset=utf-8", ClassText}, ".xml": {"text/plain; charset=utf-8", ClassText},
	".html": {"text/plain; charset=utf-8", ClassText}, ".htm": {"text/plain; charset=utf-8", ClassText},
	".js": {"text/plain; charset=utf-8", ClassText}, ".css": {"text/plain; charset=utf-8", ClassText},
}

func ruleOf(name string) (rule, bool) {
	r, ok := rules[strings.ToLower(path.Ext(name))]
	return r, ok
}

// ClassOf is what a listing reports for a name.
func ClassOf(name string) Class {
	r, _ := ruleOf(name)
	return r.class
}

func setCommon(h http.Header) {
	h.Set("Content-Security-Policy", sandboxCSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "private, no-cache")
}

// disposition always uses RFC 8187, so a hostile name cannot end the header value.
func disposition(kind, name string) string {
	var b strings.Builder
	b.WriteString(kind)
	b.WriteString("; filename*=UTF-8''")
	for _, c := range []byte(name) {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', strings.IndexByte("!#$&+-.^_`|~", c) >= 0:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// SetHeaders writes every header for stored bytes: type, CSP, nosniff,
// disposition, CORP, no-referrer. It is the only code that sets them, and
// serving a file without calling it is impossible because Serve calls it.
func SetHeaders(h http.Header, name string, download bool) {
	r, listed := ruleOf(name)
	setCommon(h)
	if !listed {
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Disposition", disposition("attachment", name))
		return
	}
	h.Set("Content-Type", r.contentType)
	if download {
		h.Set("Content-Disposition", disposition("attachment", name))
	} else {
		h.Set("Content-Disposition", disposition("inline", name))
	}
}

// SetArchiveHeaders is SetHeaders for a generated zip.
func SetArchiveHeaders(h http.Header, name string) {
	setCommon(h)
	h.Set("Content-Type", "application/zip")
	h.Set("Content-Disposition", disposition("attachment", name))
}

// etag is strong, so If-Range works, and hashed, so it does not publish an inode.
func etag(i disk.Info) string {
	sum := sha256.Sum256(fmt.Appendf(nil, "%d/%d/%d/%d", i.Dev, i.Inode, i.Size, i.ModTime.UnixNano()))
	return `"` + hex.EncodeToString(sum[:12]) + `"`
}

// Serve answers one file through http.ServeContent, which gives Range, If-Range
// and sendfile. It passes the *os.File itself, because the kernel path only
// recognises that type, and the caller's writer must keep ReadFrom.
func Serve(w http.ResponseWriter, r *http.Request, f *disk.File, download bool) {
	SetHeaders(w.Header(), f.Info.Name, download)
	w.Header().Set("Etag", etag(f.Info))
	http.ServeContent(w, r, "", f.Info.ModTime, f.File)
}

// ServeThumb answers a generated JPEG with the same protective headers.
func ServeThumb(w http.ResponseWriter, r *http.Request, c io.ReadSeeker, mod time.Time) {
	setCommon(w.Header())
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeContent(w, r, "", mod, c)
}
