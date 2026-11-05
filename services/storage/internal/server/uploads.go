package server

import (
	"errors"
	"net/http"
	"strconv"
	"sync"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/blobs"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
)

// The upload protocol (see API.md):
//
//	POST   /api/uploads            {parentId, name, size, relativePath?} -> session
//	PUT    /api/uploads/{uid}      Upload-Offset: n, octet-stream body   -> new offset (or the node when done)
//	GET    /api/uploads/{uid}                                            -> current offset, to resume
//	DELETE /api/uploads/{uid}                                            -> cancel
//
// Drop links use the same calls under /api/public/{token}/uploads.

type uploadJSON struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Offset   int64  `json:"offset"`
	ChunkMax int64  `json:"chunkMax"`
}

func (s *Server) uploadJSON(u *store.Upload) uploadJSON {
	return uploadJSON{ID: u.ID, Name: u.Name, Size: u.Size, Offset: u.Received, ChunkMax: s.cfg.MaxChunkSize}
}

func (s *Server) uploadCreate(w http.ResponseWriter, r *http.Request) {
	s.createUpload(w, r, userSubject(r), "")
}

func (s *Server) createUpload(w http.ResponseWriter, r *http.Request, subj store.Subject, forcedParent string) {
	var b struct {
		ParentID     string `json:"parentId"`
		Name         string `json:"name"`
		Size         int64  `json:"size"`
		RelativePath string `json:"relativePath"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, err)
		return
	}
	if forcedParent != "" {
		b.ParentID = forcedParent
	} else if b.ParentID == "root" || b.ParentID == "" {
		b.ParentID = subj.User.RootID
	}
	up, err := s.store.CreateUpload(r.Context(), subj, store.NewUploadInput{
		ParentID: b.ParentID, RelativePath: b.RelativePath, Name: b.Name, Size: b.Size, MaxSize: s.cfg.MaxFileSize,
	})
	if err != nil {
		switch {
		case errors.Is(err, store.ErrQuota), errors.Is(err, store.ErrVolumeFull):
			s.m.Uploads.WithLabelValues("quota").Inc()
		case errors.Is(err, store.ErrTooLarge):
			s.m.Uploads.WithLabelValues("too_large").Inc()
		}
		s.fail(w, r, err)
		return
	}
	if up.Size == 0 {
		s.finishUpload(w, r, subj, up)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"upload": s.uploadJSON(up)})
}

func (s *Server) uploadStatus(w http.ResponseWriter, r *http.Request) {
	s.statusUpload(w, r, userSubject(r))
}

func (s *Server) statusUpload(w http.ResponseWriter, r *http.Request, subj store.Subject) {
	up, err := s.store.GetUpload(r.Context(), subj, r.PathValue("uid"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upload": s.uploadJSON(up)})
}

func (s *Server) uploadChunk(w http.ResponseWriter, r *http.Request) {
	s.chunkUpload(w, r, userSubject(r))
}

func (s *Server) lockUpload(id string) (func(), bool) {
	v, _ := s.uploadLocks.LoadOrStore(id, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	if !mu.TryLock() {
		return nil, false
	}
	return func() { mu.Unlock() }, true
}

func (s *Server) chunkUpload(w http.ResponseWriter, r *http.Request, subj store.Subject) {
	id := r.PathValue("uid")
	unlock, ok := s.lockUpload(id)
	if !ok {
		s.fail(w, r, store.ErrUploadBusy)
		return
	}
	defer unlock()
	up, err := s.store.GetUpload(r.Context(), subj, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if err != nil || offset != up.Received {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":  map[string]string{"code": "offset_mismatch", "message": "resume from the server's offset"},
			"upload": s.uploadJSON(up),
		})
		return
	}
	left := up.Size - up.Received
	limit := min(left, s.cfg.MaxChunkSize)
	if r.ContentLength > limit {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "chunk is larger than allowed or than the bytes left")
		return
	}
	newOffset, state, err := s.blobs.AppendChunk(up.ID, up.Received, up.HashState, r.Body, limit)
	if errors.Is(err, blobs.ErrTooMuch) {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "chunk is larger than allowed or than the bytes left")
		return
	}
	if newOffset > up.Received {
		s.m.UploadBytes.Add(float64(newOffset - up.Received))
		if dbErr := s.store.AdvanceUpload(contextWithoutCancel(r), up.ID, newOffset, state); dbErr != nil {
			s.fail(w, r, dbErr)
			return
		}
		up.Received, up.HashState = newOffset, state
	}
	if err != nil {
		// The client stopped sending mid-chunk; what arrived is kept.
		s.log.InfoContext(r.Context(), "upload chunk interrupted", "upload", up.ID, "offset", newOffset, "err", err)
		return
	}
	if up.Received < up.Size {
		writeJSON(w, http.StatusOK, map[string]any{"upload": s.uploadJSON(up)})
		return
	}
	s.finishUpload(w, r, subj, up)
}

func (s *Server) finishUpload(w http.ResponseWriter, r *http.Request, subj store.Subject, up *store.Upload) {
	sha, err := blobs.Sum(up.HashState)
	if err == nil && up.Size == 0 {
		sha, err = blobs.Sum(nil)
	}
	if err != nil {
		s.m.Uploads.WithLabelValues("error").Inc()
		s.fail(w, r, err)
		return
	}
	blobID := blobs.NewID()
	if err := s.blobs.Commit(up.ID, blobID); err != nil {
		s.m.Uploads.WithLabelValues("error").Inc()
		s.fail(w, r, err)
		return
	}
	n, err := s.store.FinishUpload(contextWithoutCancel(r), subj, up, blobID, sha)
	if err != nil {
		s.m.Uploads.WithLabelValues("error").Inc()
		s.blobs.Remove(blobID)                               //nolint:errcheck
		s.store.DeleteUpload(contextWithoutCancel(r), up.ID) //nolint:errcheck
		s.fail(w, r, err)
		return
	}
	s.m.Uploads.WithLabelValues("ok").Inc()
	s.uploadLocks.Delete(up.ID)
	j := s.uploadJSON(up)
	j.Offset = up.Size
	writeJSON(w, http.StatusCreated, map[string]any{"upload": j, "node": toJSON(n), "sha256": sha})
}

func (s *Server) uploadCancel(w http.ResponseWriter, r *http.Request) {
	s.cancelUpload(w, r, userSubject(r))
}

func (s *Server) cancelUpload(w http.ResponseWriter, r *http.Request, subj store.Subject) {
	id := r.PathValue("uid")
	unlock, ok := s.lockUpload(id)
	if !ok {
		s.fail(w, r, store.ErrUploadBusy)
		return
	}
	defer unlock()
	up, err := s.store.GetUpload(r.Context(), subj, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.blobs.RemoveUpload(up.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.store.DeleteUpload(r.Context(), up.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	s.uploadLocks.Delete(up.ID)
	w.WriteHeader(http.StatusNoContent)
}
