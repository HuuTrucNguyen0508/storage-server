package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
)

// Public handlers serve /api/public/{token}/...: a guest's only capability is
// the token in the path. They never read Remote-* headers (identify does not
// run on these routes) and never fall through to private handlers.

const (
	grantTTL        = 12 * time.Hour
	unlockPerLink   = 10 // failed passwords per link per window
	unlockPerClient = 30 // failed passwords per client address per window
	unlockWindow    = 15 * time.Minute
)

func grantCookieName(l *store.Link) string {
	return "storage_link_" + strings.ReplaceAll(l.ID, "-", "")
}

// grantMAC binds a grant to the link, its password hash and an expiry, so
// revocation or a changed password ends it.
func (s *Server) grantMAC(l *store.Link, exp int64) string {
	m := hmac.New(sha256.New, s.grantKey)
	fmt.Fprintf(m, "%s|%d|%s", l.ID, exp, l.PasswordHash)
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *Server) unlocked(r *http.Request, l *store.Link) bool {
	if !l.HasPassword {
		return true
	}
	c, err := r.Cookie(grantCookieName(l))
	if err != nil {
		return false
	}
	expStr, mac, ok := strings.Cut(c.Value, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	return hmac.Equal([]byte(mac), []byte(s.grantMAC(l, exp)))
}

// linkFor resolves the token in the path. It answers the request itself
// (404, 410, or 401 when a password is needed) and returns ok=false when the
// guest may not proceed.
func (s *Server) linkFor(w http.ResponseWriter, r *http.Request, needUnlock bool) (*store.Link, bool) {
	noStore(w)
	l, err := s.store.LinkByToken(r.Context(), r.PathValue("token"))
	if err != nil {
		s.fail(w, r, err)
		return nil, false
	}
	if err := l.State(time.Now()); err != nil {
		s.fail(w, r, err)
		return nil, false
	}
	if needUnlock && !s.unlocked(r, l) {
		writeError(w, http.StatusUnauthorized, "password_required", "this link needs a password")
		return nil, false
	}
	return l, true
}

func linkSubject(l *store.Link) store.Subject { return store.Subject{Link: l} }

type publicLinkJSON struct {
	Kind             store.LinkKind `json:"kind"`
	Owner            string         `json:"owner"`
	ExpiresAt        *time.Time     `json:"expiresAt"`
	RequiresPassword bool           `json:"requiresPassword"`
	Unlocked         bool           `json:"unlocked"`
	DownloadsLeft    *int           `json:"downloadsLeft"`
}

func (s *Server) pubInfo(w http.ResponseWriter, r *http.Request) {
	l, ok := s.linkFor(w, r, false)
	if !ok {
		return
	}
	info := publicLinkJSON{Kind: l.Kind, Owner: l.Owner, ExpiresAt: l.ExpiresAt, RequiresPassword: l.HasPassword, Unlocked: s.unlocked(r, l)}
	if l.MaxDownloads != nil {
		left := *l.MaxDownloads - l.DownloadCount
		info.DownloadsLeft = &left
	}
	out := map[string]any{"link": info}
	if info.Unlocked {
		need := store.NeedRead
		if l.Kind == store.LinkDrop {
			need = store.NeedUpload
		}
		n, _, err := s.store.Authorize(r.Context(), s.store.Pool, linkSubject(l), l.NodeID, need)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if l.Kind == store.LinkDrop {
			// A drop link shows the folder's name only.
			out["node"] = map[string]any{"id": n.ID, "name": n.Name, "isDir": true, "kind": "folder"}
		} else {
			out["node"] = guestNode(n)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) pubUnlock(w http.ResponseWriter, r *http.Request) {
	l, ok := s.linkFor(w, r, false)
	if !ok {
		return
	}
	if !l.HasPassword {
		writeJSON(w, http.StatusOK, map[string]any{"unlocked": true})
		return
	}
	linkKey, clientKey := "link:"+l.ID, "client:"+clientIP(r)
	for _, k := range []struct {
		key string
		max int
	}{{linkKey, unlockPerLink}, {clientKey, unlockPerClient}} {
		if blocked, wait := s.limiter.blocked(k.key, k.max, unlockWindow); blocked {
			s.m.LinkUnlocks.WithLabelValues("limited").Inc()
			w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many wrong passwords; wait and try again")
			return
		}
	}
	var b struct {
		Password string `json:"password"`
	}
	if err := decode(r, &b); err != nil || len(b.Password) > 256 {
		writeError(w, http.StatusBadRequest, "invalid", "password required")
		return
	}
	ok, err := checkPassword(l.PasswordHash, b.Password)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !ok {
		s.limiter.fail(linkKey, unlockWindow)
		s.limiter.fail(clientKey, unlockWindow)
		s.m.LinkUnlocks.WithLabelValues("wrong").Inc()
		writeError(w, http.StatusUnauthorized, "wrong_password", "wrong password")
		return
	}
	s.m.LinkUnlocks.WithLabelValues("ok").Inc()
	exp := time.Now().Add(grantTTL).Unix()
	http.SetCookie(w, &http.Cookie{
		Name: grantCookieName(l), Value: fmt.Sprintf("%d.%s", exp, s.grantMAC(l, exp)),
		Path: "/api/public/", MaxAge: int(grantTTL.Seconds()), HttpOnly: true,
		Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"unlocked": true})
}

// pubView resolves a node below a view link.
func (s *Server) pubView(w http.ResponseWriter, r *http.Request) (*store.Link, *store.Node, *store.Access, bool) {
	l, ok := s.linkFor(w, r, true)
	if !ok {
		return nil, nil, nil, false
	}
	n, acc, err := s.store.Authorize(r.Context(), s.store.Pool, linkSubject(l), r.PathValue("id"), store.NeedRead)
	if err != nil {
		s.fail(w, r, err)
		return nil, nil, nil, false
	}
	return l, n, acc, true
}

func (s *Server) pubNode(w http.ResponseWriter, r *http.Request) {
	if _, n, acc, ok := s.pubView(w, r); ok {
		writeJSON(w, http.StatusOK, map[string]any{"node": guestNode(n), "crumbs": acc.Crumbs})
	}
}

func (s *Server) pubChildren(w http.ResponseWriter, r *http.Request) {
	l, ok := s.linkFor(w, r, true)
	if !ok {
		return
	}
	folder, acc, kids, err := s.store.Children(r.Context(), linkSubject(l), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sortNodes(kids, r.URL.Query().Get("sort"), r.URL.Query().Get("order"))
	writeJSON(w, http.StatusOK, map[string]any{"node": guestNode(folder), "crumbs": acc.Crumbs, "items": guestList(kids)})
}

// pubContent is a download through a link: it counts toward the link's limit.
func (s *Server) pubContent(w http.ResponseWriter, r *http.Request) {
	l, n, _, ok := s.pubView(w, r)
	if !ok {
		return
	}
	if n.IsDir {
		writeError(w, http.StatusBadRequest, "invalid", "this is a folder; download it as a ZIP")
		return
	}
	if r.Method != http.MethodHead && !isRangeContinuation(r, n) {
		if err := s.store.CountLinkDownload(r.Context(), l, n.ID); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	s.sendFile(w, r, n, false, "public")
}

// isRangeContinuation exempts only a single range beginning after byte zero.
// Suffix ranges can return the whole file, and a stale If-Range causes
// ServeContent to ignore Range entirely, so both must count as downloads.
func isRangeContinuation(r *http.Request, n *store.Node) bool {
	if ir := r.Header.Get("If-Range"); ir != "" && ir != `"`+n.BlobID+`"` {
		return false
	}
	rg, ok := strings.CutPrefix(r.Header.Get("Range"), "bytes=")
	if !ok || strings.Contains(rg, ",") {
		return false
	}
	start, end, ok := strings.Cut(rg, "-")
	if !ok || start == "" {
		return false
	}
	for _, c := range start {
		if c < '0' || c > '9' {
			return false
		}
	}
	offset, err := strconv.ParseInt(start, 10, 64)
	if err != nil || offset <= 0 || offset >= n.Size {
		return false
	}
	if end != "" {
		for _, c := range end {
			if c < '0' || c > '9' {
				return false
			}
		}
		last, err := strconv.ParseInt(end, 10, 64)
		if err != nil || last < offset {
			return false
		}
	}
	return true
}

// pubRaw serves what the guest viewer shows, without counting a download.
// Files it has no viewer for are refused, so /raw can't bypass the limit.
func (s *Server) pubRaw(w http.ResponseWriter, r *http.Request) {
	_, n, _, ok := s.pubView(w, r)
	if !ok {
		return
	}
	if _, _, viewable := rawType(n.Name); !n.IsDir && !viewable {
		writeError(w, http.StatusNotFound, "no_preview", "no preview for this file; download it instead")
		return
	}
	s.countPreview(n)
	s.sendFile(w, r, n, true, "public")
}

func (s *Server) pubThumbnail(w http.ResponseWriter, r *http.Request) {
	if _, n, _, ok := s.pubView(w, r); ok {
		s.sendThumbnail(w, r, n, "public")
	}
}

func (s *Server) pubOffice(w http.ResponseWriter, r *http.Request) {
	if _, n, _, ok := s.pubView(w, r); ok {
		s.sendOffice(w, r, n, "public")
	}
}

func (s *Server) pubArchive(w http.ResponseWriter, r *http.Request) {
	if _, n, _, ok := s.pubView(w, r); ok {
		s.sendArchive(w, r, n)
	}
}

func (s *Server) pubZip(w http.ResponseWriter, r *http.Request) {
	l, ok := s.linkFor(w, r, true)
	if !ok {
		return
	}
	if l.Kind != store.LinkView {
		s.fail(w, r, store.ErrNotFound)
		return
	}
	ids := r.URL.Query()["id"]
	if len(ids) == 0 {
		ids = []string{l.NodeID}
	}
	// Authorize before counting, so a bad id does not use up a download.
	for _, id := range ids {
		if _, _, err := s.store.Authorize(r.Context(), s.store.Pool, linkSubject(l), id, store.NeedRead); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	if r.Method != http.MethodHead {
		if err := s.store.CountLinkDownload(r.Context(), l, l.NodeID); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	s.sendZip(w, r, linkSubject(l), ids, "public")
}

func (s *Server) pubDrop(w http.ResponseWriter, r *http.Request) (*store.Link, bool) {
	l, ok := s.linkFor(w, r, true)
	if !ok {
		return nil, false
	}
	if l.Kind != store.LinkDrop {
		s.fail(w, r, store.ErrNotFound)
		return nil, false
	}
	return l, true
}

func (s *Server) pubUploadCreate(w http.ResponseWriter, r *http.Request) {
	if l, ok := s.pubDrop(w, r); ok {
		s.createUpload(w, r, linkSubject(l), l.NodeID)
	}
}

func (s *Server) pubUploadStatus(w http.ResponseWriter, r *http.Request) {
	if l, ok := s.pubDrop(w, r); ok {
		s.statusUpload(w, r, linkSubject(l))
	}
}

func (s *Server) pubUploadChunk(w http.ResponseWriter, r *http.Request) {
	if l, ok := s.pubDrop(w, r); ok {
		s.chunkUpload(w, r, linkSubject(l))
	}
}

func (s *Server) pubUploadCancel(w http.ResponseWriter, r *http.Request) {
	if l, ok := s.pubDrop(w, r); ok {
		s.cancelUpload(w, r, linkSubject(l))
	}
}
