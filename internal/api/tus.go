package api

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"storage-server/internal/disk"
	"storage-server/internal/metrics"
	"storage-server/internal/upload"
)

const (
	tusVersion  = "1.0.0"
	readTimeout = 60 * time.Second
	dropItem    = "drop"
)

var errClientStopped = errors.New("the client stopped sending")

func uploadScope(c *call) upload.Scope {
	if c.admission != nil {
		return upload.Scope{Drop: c.admission.Share.ID}
	}
	return upload.Scope{}
}

type body struct {
	r       *http.Request
	rc      *http.ResponseController
	add     func(int64)
	stopped atomic.Bool
}

func (b *body) Read(p []byte) (int, error) {
	if b.stopped.Load() {
		return 0, errClientStopped
	}
	if err := b.rc.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		return 0, fmt.Errorf("%w: %w", errClientStopped, err)
	}
	if b.stopped.Load() {
		return 0, errClientStopped
	}
	n, err := b.r.Body.Read(p)
	b.add(int64(n))
	if err != nil && !errors.Is(err, io.EOF) {
		return n, fmt.Errorf("%w: %w", errClientStopped, err)
	}
	return n, err
}

func (b *body) Interrupt() {
	b.stopped.Store(true)
	_ = b.rc.SetReadDeadline(time.Unix(1, 0))
}

func setTus(w http.ResponseWriter) { w.Header().Set("Tus-Resumable", tusVersion) }

func checkTus(r *http.Request) error {
	if r.Header.Get("Tus-Resumable") != tusVersion {
		return requestError{http.StatusPreconditionFailed, "tus_version", "this server speaks tus 1.0.0"}
	}
	return nil
}

func metadata(header, key string) (string, bool) {
	for pair := range strings.SplitSeq(header, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(pair), " ")
		if k != key {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(v)
		return string(decoded), err == nil
	}
	return "", false
}

func uploadPath(r *http.Request, c *call) (disk.Path, error) {
	raw, ok := metadata(r.Header.Get("Upload-Metadata"), "path")
	if !ok {
		return disk.Path{}, disk.ErrInvalidPath
	}
	p, err := disk.ParsePath(raw)
	if err != nil {
		return disk.Path{}, err
	}
	e, ok := p.Entry()
	if !ok || (c.admission != nil && !e.Dir.IsRoot()) {
		return disk.Path{}, disk.ErrInvalidPath
	}
	return p, nil
}

func setStored(w http.ResponseWriter, st upload.Status) {
	if !st.Stored.IsRoot() {
		w.Header().Set("X-Stored-Path", st.Stored.String())
	}
}

func (a *API) uploadCreate(w http.ResponseWriter, r *http.Request, c *call) {
	setTus(w)
	if err := checkTus(r); err != nil {
		a.fail(w, r, err)
		return
	}
	length, err := strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
	if err != nil || length < 0 {
		a.fail(w, r, requestError{http.StatusBadRequest, "invalid_length", "Upload-Length is not a size"})
		return
	}
	p, err := uploadPath(r, c)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := a.spend(r, c, dropItem); err != nil {
		a.fail(w, r, err)
		return
	}
	id, st, err := a.uploads.Create(r.Context(), uploadScope(c), p, length)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Location", r.URL.Path+"/"+string(id))
	w.Header().Set("Upload-Offset", strconv.FormatInt(st.Offset, 10))
	setStored(w, st)
	w.WriteHeader(http.StatusCreated)
}

func (a *API) uploadHead(w http.ResponseWriter, r *http.Request, c *call) {
	setTus(w)
	w.Header().Set("Cache-Control", "no-store")
	if err := checkTus(r); err != nil {
		a.fail(w, r, err)
		return
	}
	id, err := upload.ParseID(r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	st, err := a.uploads.Status(r.Context(), uploadScope(c), id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Upload-Offset", strconv.FormatInt(st.Offset, 10))
	w.Header().Set("Upload-Length", strconv.FormatInt(st.Length, 10))
	setStored(w, st)
	w.WriteHeader(http.StatusOK)
}

func (a *API) uploadPatch(w http.ResponseWriter, r *http.Request, c *call) {
	setTus(w)
	if err := checkTus(r); err != nil {
		a.fail(w, r, err)
		return
	}
	if r.Header.Get("Content-Type") != "application/offset+octet-stream" {
		a.fail(w, r, requestError{http.StatusUnsupportedMediaType, "content_type", "use application/offset+octet-stream"})
		return
	}
	id, err := upload.ParseID(r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if err != nil || offset < 0 {
		a.fail(w, r, requestError{http.StatusBadRequest, "invalid_offset", "Upload-Offset is not a size"})
		return
	}
	stream := &body{r: r, rc: http.NewResponseController(w), add: func(n int64) {
		a.metrics.Transfer(metrics.Up, c.surface, n)
	}}
	st, err := a.uploads.Append(r.Context(), uploadScope(c), id, offset, stream)
	w.Header().Set("Upload-Offset", strconv.FormatInt(st.Offset, 10))
	if errors.Is(err, errClientStopped) {
		w.Header().Set("Connection", "close")
		a.fail(w, r, requestError{http.StatusRequestTimeout, "client_stopped", "the upload stopped, send HEAD and resume"})
		return
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	setStored(w, st)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) uploadDelete(w http.ResponseWriter, r *http.Request, c *call) {
	setTus(w)
	if err := checkTus(r); err != nil {
		a.fail(w, r, err)
		return
	}
	id, err := upload.ParseID(r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := a.uploads.Cancel(r.Context(), uploadScope(c), id); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
