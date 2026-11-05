package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
)

func urlQueryEscape(s string) string { return url.QueryEscape(s) }

func contextWithoutCancel(r *http.Request) context.Context { return context.WithoutCancel(r.Context()) }

func (s *Server) listShares(w http.ResponseWriter, r *http.Request) {
	shares, err := s.store.ListShares(r.Context(), user(r), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if shares == nil {
		shares = []store.Share{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": shares})
}

func (s *Server) createShare(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Username   string `json:"username"`
		Permission string `json:"permission"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, err)
		return
	}
	sh, err := s.store.ShareWith(r.Context(), user(r), r.PathValue("id"), b.Username, b.Permission)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"share": sh})
}

func (s *Server) deleteShare(w http.ResponseWriter, r *http.Request) {
	if err := s.store.RemoveShare(r.Context(), user(r), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listNodeLinks(w http.ResponseWriter, r *http.Request) {
	links, err := s.store.LinksForNode(r.Context(), user(r), r.PathValue("id"))
	s.links(w, r, links, err)
}

func (s *Server) listMyLinks(w http.ResponseWriter, r *http.Request) {
	links, err := s.store.LinksByOwner(r.Context(), user(r))
	s.links(w, r, links, err)
}

type linkJSON struct {
	*store.Link
	Status string `json:"status"`
}

func (s *Server) links(w http.ResponseWriter, r *http.Request, links []*store.Link, err error) {
	if err != nil {
		s.fail(w, r, err)
		return
	}
	now := time.Now()
	out := make([]linkJSON, 0, len(links))
	for _, l := range links {
		status := "active"
		switch {
		case l.RevokedAt != nil:
			status = "revoked"
		case l.ExpiresAt != nil && !now.Before(*l.ExpiresAt):
			status = "expired"
		case l.MaxDownloads != nil && l.DownloadCount >= *l.MaxDownloads:
			status = "exhausted"
		}
		out = append(out, linkJSON{Link: l, Status: status})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) createLink(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Kind         string     `json:"kind"`
		Password     string     `json:"password"`
		ExpiresAt    *time.Time `json:"expiresAt"`
		MaxDownloads *int       `json:"maxDownloads"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, err)
		return
	}
	if b.Kind == "" {
		b.Kind = string(store.LinkView)
	}
	if len(b.Password) > 256 {
		writeError(w, http.StatusBadRequest, "invalid", "password is too long")
		return
	}
	in := store.NewLinkInput{Kind: store.LinkKind(b.Kind), ExpiresAt: b.ExpiresAt, MaxDownloads: b.MaxDownloads}
	if b.Password != "" {
		in.PasswordHash = hashPassword(b.Password)
	}
	l, token, err := s.store.CreateLink(r.Context(), user(r), r.PathValue("id"), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"link":  linkJSON{Link: l, Status: "active"},
		"token": token,
		"url":   s.cfg.PublicURL + "/s/" + token,
	})
}

func (s *Server) revokeLink(w http.ResponseWriter, r *http.Request) {
	if err := s.store.RevokeLink(r.Context(), user(r), r.PathValue("id"), false); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- admin ----

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !user(r).IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "admins only")
		return false
	}
	return true
}

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	users, err := s.store.ListUsersForAdmin(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	total, avail, _ := s.blobs.Space()
	writeJSON(w, http.StatusOK, map[string]any{"items": users, "volume": map[string]uint64{"totalBytes": total, "freeBytes": avail}})
}

func (s *Server) adminSetQuota(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var b struct {
		QuotaBytes int64 `json:"quotaBytes"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, err)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.fail(w, r, store.ErrNotFound)
		return
	}
	if err := s.store.SetQuota(r.Context(), id, b.QuotaBytes); err != nil {
		s.fail(w, r, err)
		return
	}
	s.users.forget()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) adminLinks(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	links, err := s.store.AllLinks(r.Context())
	s.links(w, r, links, err)
}

func (s *Server) adminRevokeLink(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	if err := s.store.RevokeLink(r.Context(), user(r), r.PathValue("id"), true); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- link passwords (argon2id, PHC string format) ----

const (
	argonTime    = 2
	argonMemory  = 19 * 1024 // KiB
	argonThreads = 1
	argonKeyLen  = 32
)

func hashPassword(pw string) string {
	salt := make([]byte, 16)
	rand.Read(salt) //nolint:errcheck
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}

var errBadHash = errors.New("unsupported password hash")

func checkPassword(encoded, pw string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errBadHash
	}
	var version int
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errBadHash
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil || m > 1<<20 || t > 10 || p == 0 {
		return false, errBadHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, errBadHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, errBadHash
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
