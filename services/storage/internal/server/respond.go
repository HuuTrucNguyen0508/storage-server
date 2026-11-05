package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/filetype"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
)

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	noStore(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	var e apiError
	e.Error.Code, e.Error.Message = code, msg
	writeJSON(w, status, e)
}

// fail maps store errors to HTTP answers. Unknown errors are logged and
// reported as 500 without detail.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "you do not have permission to do that")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "an item with that name already exists")
	case errors.Is(err, store.ErrQuota):
		writeError(w, http.StatusInsufficientStorage, "quota_exceeded", "this would exceed the storage quota")
	case errors.Is(err, store.ErrVolumeFull):
		writeError(w, http.StatusInsufficientStorage, "volume_full", "the server is nearly out of space")
	case errors.Is(err, store.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "file is too large")
	case errors.Is(err, store.ErrGone):
		writeError(w, http.StatusGone, "gone", "this link has expired or reached its download limit")
	case errors.Is(err, store.ErrUploadBusy):
		writeError(w, http.StatusConflict, "upload_busy", "another request is writing this upload")
	case errors.Is(err, store.ErrInvalid):
		msg := strings.TrimPrefix(err.Error(), store.ErrInvalid.Error()+": ")
		if msg == store.ErrInvalid.Error() {
			msg = "invalid request"
		}
		writeError(w, http.StatusBadRequest, "invalid", msg)
	case errors.Is(err, errBadJSON):
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
	default:
		s.log.ErrorContext(r.Context(), "request failed", slog.String("err", err.Error()))
		writeError(w, http.StatusInternalServerError, "internal", "internal error")
	}
}

var errBadJSON = errors.New("request body must be a JSON object of the documented shape")

// decode reads a JSON body of at most 1 MiB into v.
func decode(r *http.Request, v any) error {
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		return errBadJSON
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errBadJSON
	}
	return nil
}

// nodeJSON is the API shape of a file or folder.
type nodeJSON struct {
	ID         string    `json:"id"`
	ParentID   *string   `json:"parentId"`
	Name       string    `json:"name"`
	IsDir      bool      `json:"isDir"`
	Size       int64     `json:"size"`
	Kind       string    `json:"kind"`
	Mime       string    `json:"mime"`
	Language   string    `json:"language,omitempty"`
	Thumbnail  bool      `json:"thumbnail"`
	Owner      string    `json:"owner"`
	Starred    bool      `json:"starred"`
	CreatedAt  time.Time `json:"createdAt"`
	ModifiedAt time.Time `json:"modifiedAt"`
	Permission string    `json:"permission,omitempty"`
	// Sharing is set on the viewer's own nodes in listings.
	Sharing *store.Sharing `json:"sharing,omitempty"`
}

func toJSON(n *store.Node) nodeJSON {
	j := nodeJSON{
		ID: n.ID, ParentID: n.ParentID, Name: n.Name, IsDir: n.IsDir, Size: n.Size, Owner: n.Owner,
		Starred: n.Starred, CreatedAt: n.CreatedAt, ModifiedAt: n.ModifiedAt, Permission: n.Permission,
	}
	if n.IsDir {
		j.Kind, j.Mime = string(filetype.Folder), "inode/directory"
		return j
	}
	ft := filetype.Detect(n.Name)
	j.Kind, j.Mime, j.Language, j.Thumbnail = string(ft.Kind), ft.Mime, ft.Language, ft.Thumbnail
	return j
}

func toJSONList(nodes []*store.Node) []nodeJSON {
	out := make([]nodeJSON, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, toJSON(n))
	}
	return out
}

// guestNode hides the owner-only fields from public link guests.
func guestNode(n *store.Node) nodeJSON {
	j := toJSON(n)
	j.Starred = false
	j.ParentID = nil
	return j
}

func guestList(nodes []*store.Node) []nodeJSON {
	out := make([]nodeJSON, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, guestNode(n))
	}
	return out
}
