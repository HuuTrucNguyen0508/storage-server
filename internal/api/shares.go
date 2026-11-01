package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"storage-server/internal/access"
	"storage-server/internal/disk"
	"storage-server/internal/media"
	"storage-server/internal/store"
)

const describeBudget = 2 * time.Second

type shareJSON struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	URL         string     `json:"url"`
	Path        string     `json:"path"`
	State       string     `json:"state"`
	Uses        int        `json:"uses"`
	MaxUses     *int       `json:"maxUses"`
	ExpiresAt   *time.Time `json:"expiresAt"`
	HasPassword bool       `json:"hasPassword"`
	CreatedAt   time.Time  `json:"createdAt"`
}

func (a *API) shareOf(sh store.Share, exists bool) shareJSON {
	return shareJSON{
		ID: string(sh.ID), Kind: string(sh.Kind),
		URL:  strings.TrimRight(a.cfg.ShareURL, "/") + "/s/" + string(sh.Token),
		Path: a.vault.Original(sh.Target), State: access.StateOf(sh, time.Now(), exists).String(),
		Uses: sh.Uses, MaxUses: sh.MaxUses, ExpiresAt: sh.ExpiresAt,
		HasPassword: sh.PasswordHash != "", CreatedAt: sh.CreatedAt,
	}
}

func (a *API) listShares(w http.ResponseWriter, r *http.Request, c *call) {
	shares, err := a.vault.Shares(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := make([]shareJSON, 0, len(shares))
	for _, l := range shares {
		out = append(out, a.shareOf(l.Share, l.Exists))
	}
	writeJSON(w, http.StatusOK, out)
}

func newShareID() (store.ShareID, store.Token) {
	var id [16]byte
	var token [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic(err)
	}
	if _, err := rand.Read(token[:]); err != nil {
		panic(err)
	}
	return store.ShareID(hex.EncodeToString(id[:])), store.Token(base64.RawURLEncoding.EncodeToString(token[:]))
}

func (a *API) createShare(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct {
		Path      string
		Kind      store.ShareKind
		Password  string
		ExpiresAt *time.Time
		MaxUses   *int
	}
	if err := decode(r, &in, false); err != nil {
		a.fail(w, r, err)
		return
	}
	p, err := disk.ParsePath(in.Path)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if in.Kind != store.ShareLink && in.Kind != store.ShareDrop {
		a.fail(w, r, invalid(`kind must be "link" or "drop"`))
		return
	}
	if in.MaxUses != nil && *in.MaxUses < 1 {
		a.fail(w, r, invalid("maxUses must be at least 1"))
		return
	}
	id, token := newShareID()
	sh := store.Share{ID: id, Token: token, Kind: in.Kind, ExpiresAt: in.ExpiresAt, MaxUses: in.MaxUses, CreatedAt: time.Now()}
	if in.Password != "" {
		if sh.PasswordHash, err = access.HashPassword(r.Context(), in.Password); err != nil {
			a.fail(w, r, err)
			return
		}
	}
	created, err := a.vault.CreateShare(r.Context(), sh, p)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, a.shareOf(created, true))
}

func (a *API) revokeShare(w http.ResponseWriter, r *http.Request, c *call) {
	if err := a.db.DeleteShare(r.Context(), store.ShareID(r.PathValue("id"))); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type factsJSON struct {
	Preview          media.Class `json:"preview"`
	Kind             string      `json:"kind"`
	Name             string      `json:"name"`
	IsFolder         bool        `json:"isFolder"`
	Size             *int64      `json:"size"`
	PasswordRequired bool        `json:"passwordRequired"`
	ExpiresAt        *time.Time  `json:"expiresAt"`
}

// folderSize is what a guest's Download all button names. It has a budget, since
// a link preview bot can reach it, and reports nil when the walk runs out.
func folderSize(ctx context.Context, t *disk.Tree) *int64 {
	ctx, cancel := context.WithTimeout(ctx, describeBudget)
	defer cancel()
	var total int64
	err := t.Walk(ctx, disk.Path{}, func(_ disk.Path, i disk.Info) error {
		total += i.Size
		return nil
	})
	if err != nil {
		return nil
	}
	return &total
}

func (a *API) describe(w http.ResponseWriter, r *http.Request, c *call) {
	sh, _, err := a.access.Describe(r.Context(), store.Token(r.PathValue("token")), cookieValue(r, grantCookie))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	facts := factsJSON{Kind: string(sh.Kind), PasswordRequired: sh.PasswordHash != "", ExpiresAt: sh.ExpiresAt, IsFolder: sh.Kind == store.ShareDrop}
	if p, live := sh.Target.LivePath(); live {
		if e, ok := p.Entry(); ok {
			facts.Name = e.Name.String()
		}
	}
	if sh.Kind == store.ShareLink {
		opened, err := a.vault.OpenShare(r.Context(), sh.ID)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		defer opened.Close()
		if opened.File != nil {
			facts.Size = &opened.File.Info.Size
			facts.Preview = media.ClassOf(opened.File.Info.Name)
		} else {
			facts.IsFolder = true
			facts.Size = folderSize(r.Context(), opened.Dir)
		}
	}
	writeJSON(w, http.StatusOK, facts)
}

func (a *API) open(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{ Password string }
	if err := decode(r, &in, true); err != nil {
		a.fail(w, r, err)
		return
	}
	token := store.Token(r.PathValue("token"))
	cookie, err := a.access.Open(r.Context(), token, in.Password)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.setCookie(w, grantCookie, "/api/public/"+string(token), cookie, a.secure(a.cfg.ShareURL))
	w.WriteHeader(http.StatusNoContent)
}
