package server

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/filetype"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/preview"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
)

// contentCSP is sent with every response that carries user bytes. Even when
// a browser navigates straight to such a URL, nothing can run.
const contentCSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"

// countingWriter adds body bytes to a metric.
type countingWriter struct {
	http.ResponseWriter
	add func(float64)
}

func (c countingWriter) Write(b []byte) (int, error) {
	n, err := c.ResponseWriter.Write(b)
	c.add(float64(n))
	return n, err
}

func (c countingWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

func disposition(kind, name string) string {
	if v := mime.FormatMediaType(kind, map[string]string{"filename": name}); v != "" {
		return v
	}
	return kind
}

// userContentHeaders are the headers every user-bytes response carries.
func userContentHeaders(w http.ResponseWriter, ctype, disp, name string) {
	h := w.Header()
	noStore(w)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", contentCSP)
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", disposition(disp, name))
}

// rawType decides how the viewer endpoint serves a file: only allowlisted
// media inline; PDFs and text as attachments the SPA reads with fetch;
// everything else as an opaque download. viewable is false for that last
// case: the SPA has no viewer that reads such a file through /raw.
func rawType(name string) (ctype, disp string, viewable bool) {
	ft := filetype.Detect(name)
	switch {
	case ft.InlineType != "":
		return ft.InlineType, "inline", true
	case ft.Kind == filetype.PDF:
		return "application/pdf", "attachment", true
	case filetype.IsTextual(ft.Kind):
		return "text/plain; charset=utf-8", "attachment", true
	}
	return "application/octet-stream", "attachment", false
}

// sendFile serves a file node's blob with Range support.
func (s *Server) sendFile(w http.ResponseWriter, r *http.Request, n *store.Node, raw bool, metricKind string) {
	if n.IsDir {
		writeError(w, http.StatusBadRequest, "invalid", "this is a folder; download it as a ZIP")
		return
	}
	f, err := s.blobs.Open(n.BlobID)
	if err != nil {
		s.fail(w, r, fmt.Errorf("open blob %s: %w", n.BlobID, err))
		return
	}
	defer f.Close()
	ctype, disp := "application/octet-stream", "attachment"
	if raw {
		ctype, disp, _ = rawType(n.Name)
	}
	userContentHeaders(w, ctype, disp, n.Name)
	w.Header().Set("ETag", `"`+n.BlobID+`"`)
	var content io.ReadSeeker = f
	if raw && metricKind == "public" && filetype.IsTextual(filetype.Detect(n.Name).Kind) {
		content = io.NewSectionReader(f, 0, min(n.Size, s.cfg.TextPreviewCap))
	}
	http.ServeContent(countingWriter{w, s.m.DownloadBytes.WithLabelValues(metricKind).Add}, r, "", n.ModifiedAt, content)
}

func (s *Server) authorizeFile(w http.ResponseWriter, r *http.Request, subj store.Subject) (*store.Node, bool) {
	n, _, err := s.store.Authorize(r.Context(), s.store.Pool, subj, r.PathValue("id"), store.NeedRead)
	if err != nil {
		s.fail(w, r, err)
		return nil, false
	}
	return n, true
}

func (s *Server) content(w http.ResponseWriter, r *http.Request) {
	if n, ok := s.authorizeFile(w, r, userSubject(r)); ok {
		s.sendFile(w, r, n, false, "download")
	}
}

func (s *Server) raw(w http.ResponseWriter, r *http.Request) {
	if n, ok := s.authorizeFile(w, r, userSubject(r)); ok {
		s.countPreview(n)
		s.sendFile(w, r, n, true, "preview")
	}
}

func (s *Server) countPreview(n *store.Node) {
	if r := previewLabel(n); r != "" {
		s.m.PreviewRequests.WithLabelValues(r).Inc()
	}
}

func previewLabel(n *store.Node) string {
	if n.IsDir {
		return ""
	}
	return filetype.PreviewLabel(filetype.Detect(n.Name).Kind)
}

func (s *Server) thumbnail(w http.ResponseWriter, r *http.Request) {
	if n, ok := s.authorizeFile(w, r, userSubject(r)); ok {
		s.sendThumbnail(w, r, n, "preview")
	}
}

func (s *Server) sendThumbnail(w http.ResponseWriter, r *http.Request, n *store.Node, metricKind string) {
	size := 256
	if v := r.URL.Query().Get("size"); v != "" {
		size, _ = strconv.Atoi(v)
	}
	if !preview.Sizes[size] {
		writeError(w, http.StatusBadRequest, "invalid", "size must be 128, 256 or 512")
		return
	}
	if n.IsDir || !filetype.Detect(n.Name).Thumbnail {
		writeError(w, http.StatusNotFound, "no_thumbnail", "no thumbnail for this file")
		return
	}
	p, err := s.thumbs.Thumbnail(r.Context(), n.BlobID, size)
	if errors.Is(err, preview.ErrUnavailable) {
		writeError(w, http.StatusNotFound, "no_thumbnail", "no thumbnail for this file")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.sendCached(w, r, p, "image/jpeg", "inline", "thumbnail.jpg", fmt.Sprintf(`"t%d-%s"`, size, n.BlobID), metricKind)
}

func (s *Server) sendCached(w http.ResponseWriter, r *http.Request, path, ctype, disp, name, etag, metricKind string) {
	f, err := os.Open(path)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer f.Close()
	userContentHeaders(w, ctype, disp, name)
	w.Header().Set("ETag", etag)
	http.ServeContent(countingWriter{w, s.m.DownloadBytes.WithLabelValues(metricKind).Add}, r, "", time.Time{}, f)
}

func (s *Server) officePreview(w http.ResponseWriter, r *http.Request) {
	if n, ok := s.authorizeFile(w, r, userSubject(r)); ok {
		s.sendOffice(w, r, n, "preview")
	}
}

func (s *Server) sendOffice(w http.ResponseWriter, r *http.Request, n *store.Node, metricKind string) {
	if n.IsDir || !filetype.IsOffice(n.Name) {
		writeError(w, http.StatusBadRequest, "invalid", "not an Office document")
		return
	}
	s.m.PreviewRequests.WithLabelValues("office").Inc()
	p, err := s.office.PDF(r.Context(), n.BlobID, n.Name, n.Size)
	switch {
	case errors.Is(err, preview.ErrPending):
		w.Header().Set("Retry-After", "2")
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "converting"})
		return
	case errors.Is(err, preview.ErrBusy):
		w.Header().Set("Retry-After", "10")
		writeError(w, http.StatusServiceUnavailable, "preview_busy", "the converter is busy; try again shortly")
		return
	case errors.Is(err, preview.ErrUnavailable):
		writeError(w, http.StatusUnprocessableEntity, "preview_failed", "this document could not be converted for preview")
		return
	case err != nil:
		s.fail(w, r, err)
		return
	}
	base := strings.TrimSuffix(n.Name, extOf(n.Name))
	s.sendCached(w, r, p, "application/pdf", "attachment", base+".pdf", `"o-`+n.BlobID+`"`, metricKind)
}

func extOf(name string) string {
	if i := strings.LastIndexByte(name, '.'); i > 0 {
		return name[i:]
	}
	return ""
}

func (s *Server) archive(w http.ResponseWriter, r *http.Request) {
	if n, ok := s.authorizeFile(w, r, userSubject(r)); ok {
		s.sendArchive(w, r, n)
	}
}

func (s *Server) sendArchive(w http.ResponseWriter, r *http.Request, n *store.Node) {
	if n.IsDir || filetype.Detect(n.Name).Kind != filetype.Archive {
		writeError(w, http.StatusBadRequest, "invalid", "not a ZIP archive")
		return
	}
	s.m.PreviewRequests.WithLabelValues("other").Inc()
	f, err := s.blobs.Open(n.BlobID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer f.Close()
	listing, err := preview.ListZip(f, n.Size)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "preview_failed", "this archive could not be read")
		return
	}
	writeJSON(w, http.StatusOK, listing)
}

func (s *Server) zip(w http.ResponseWriter, r *http.Request) {
	ids := r.URL.Query()["id"]
	if len(ids) == 0 {
		ids = []string{user(r).RootID}
	}
	s.sendZip(w, r, userSubject(r), ids, "download")
}

// sendZip streams a ZIP of the given nodes (folders recursively). Entries
// are stored uncompressed: most large files are already compressed, and
// storing keeps the server's CPU out of the way of multi-GiB downloads.
func (s *Server) sendZip(w http.ResponseWriter, r *http.Request, subj store.Subject, ids []string, metricKind string) {
	if len(ids) > 1000 {
		writeError(w, http.StatusBadRequest, "invalid", "too many items")
		return
	}
	type part struct {
		top     string
		entries []store.TreeEntry
	}
	var parts []part
	used := map[string]bool{}
	zipName := "files.zip"
	for _, id := range ids {
		n, _, err := s.store.Authorize(r.Context(), s.store.Pool, subj, id, store.NeedRead)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		entries, err := s.store.Tree(r.Context(), n.ID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		top := n.Name
		if n.ParentID == nil {
			top = ""
			zipName = "My files.zip"
		} else if len(ids) == 1 {
			zipName = n.Name + ".zip"
			if !n.IsDir {
				zipName = strings.TrimSuffix(n.Name, extOf(n.Name)) + ".zip"
			}
		}
		// Two selected items with the same name (from different folders) get numbered.
		if top != "" {
			orig := top
			for i := 1; used[strings.ToLower(top)]; i++ {
				top = fmt.Sprintf("%s (%d)", orig, i)
			}
			used[strings.ToLower(top)] = true
			for i := range entries {
				entries[i].Path = top + strings.TrimPrefix(entries[i].Path, orig)
			}
		}
		parts = append(parts, part{top: top, entries: entries})
	}
	noStore(w)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", disposition("attachment", zipName))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", contentCSP)
	cw := countingWriter{w, s.m.DownloadBytes.WithLabelValues(metricKind).Add}
	zw := zip.NewWriter(cw)
	for _, p := range parts {
		for _, e := range p.entries {
			hdr := &zip.FileHeader{Name: e.Path, Method: zip.Store, Modified: e.Modified}
			if e.IsDir {
				hdr.Name += "/"
				if _, err := zw.CreateHeader(hdr); err != nil {
					panic(http.ErrAbortHandler)
				}
				continue
			}
			hdr.UncompressedSize64 = uint64(e.Size)
			out, err := zw.CreateHeader(hdr)
			if err != nil {
				panic(http.ErrAbortHandler)
			}
			f, err := s.blobs.Open(e.BlobID)
			if err != nil {
				s.log.ErrorContext(r.Context(), "zip: blob missing", "blob", e.BlobID, "err", err)
				panic(http.ErrAbortHandler)
			}
			_, err = io.Copy(out, f)
			f.Close()
			if err != nil {
				panic(http.ErrAbortHandler) // client went away
			}
		}
	}
	if err := zw.Close(); err != nil {
		panic(http.ErrAbortHandler)
	}
}
