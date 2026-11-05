package server

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
)

type appLink struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	u := user(r)
	usage, err := s.store.Usage(r.Context(), s.store.Pool, u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	apps := []appLink{}
	if d := s.cfg.Domain; d != "" {
		apps = append(apps,
			appLink{"Home", "https://home." + d + "/"}, appLink{"Storage", "https://storage." + d + "/"},
			appLink{"Todo", "https://todo." + d + "/"}, appLink{"PDF", "https://pdf." + d + "/"})
		if u.IsAdmin {
			apps = append(apps, appLink{"Grafana", "https://grafana." + d + "/"})
		}
	}
	logout := ""
	if s.cfg.AuthPublicURL != "" {
		logout = s.cfg.AuthPublicURL + "/logout?rd=" + urlQueryEscape(s.cfg.HomeURL)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":           u,
		"usage":          usage,
		"apps":           apps,
		"logoutUrl":      logout,
		"maxFileBytes":   s.cfg.MaxFileSize,
		"chunkBytes":     min(s.cfg.MaxChunkSize, 16<<20),
		"textPreviewCap": s.cfg.TextPreviewCap,
		"publicUrl":      s.cfg.PublicURL,
	})
}

func (s *Server) searchUsers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if len(q) > 64 {
		q = q[:64]
	}
	names, err := s.store.SearchUsers(r.Context(), q, user(r).ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if names == nil {
		names = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": names})
}

func (s *Server) getNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "root" {
		id = user(r).RootID
	}
	n, acc, err := s.store.Authorize(r.Context(), s.store.Pool, userSubject(r), id, store.NeedRead)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"node": toJSON(n), "permission": acc.Perm.String(), "crumbs": acc.Crumbs, "viaShare": acc.ViaShare,
	})
}

func (s *Server) children(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "root" {
		id = user(r).RootID
	}
	folder, acc, kids, err := s.store.Children(r.Context(), userSubject(r), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sortNodes(kids, r.URL.Query().Get("sort"), r.URL.Query().Get("order"))
	items, err := s.withSharing(r, kids)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"node": toJSON(folder), "permission": acc.Perm.String(), "crumbs": acc.Crumbs, "viaShare": acc.ViaShare,
		"items": items,
	})
}

// sortNodes orders folders first, then by the requested key.
func sortNodes(nodes []*store.Node, key, order string) {
	less := func(a, b *store.Node) int { return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)) }
	switch key {
	case "size":
		less = func(a, b *store.Node) int { return cmpInt(a.Size, b.Size) }
	case "modified":
		less = func(a, b *store.Node) int { return a.ModifiedAt.Compare(b.ModifiedAt) }
	case "type":
		less = func(a, b *store.Node) int {
			ka, kb := toJSON(a).Kind, toJSON(b).Kind
			if c := strings.Compare(ka, kb); c != 0 {
				return c
			}
			return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
		}
	}
	desc := order == "desc"
	sort.SliceStable(nodes, func(i, j int) bool {
		a, b := nodes[i], nodes[j]
		if a.IsDir != b.IsDir {
			return a.IsDir
		}
		c := less(a, b)
		if desc {
			return c > 0
		}
		return c < 0
	})
}

func cmpInt(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

type patchBody struct {
	Name     *string `json:"name"`
	ParentID *string `json:"parentId"`
}

func (s *Server) patchNode(w http.ResponseWriter, r *http.Request) {
	var b patchBody
	if err := decode(r, &b); err != nil {
		s.fail(w, r, err)
		return
	}
	id := r.PathValue("id")
	subj := userSubject(r)
	var n *store.Node
	var err error
	if b.ParentID != nil {
		var moved []*store.Node
		moved, err = s.store.Move(r.Context(), subj, []string{id}, *b.ParentID)
		if err == nil && len(moved) == 1 {
			n = moved[0]
		}
	}
	if err == nil && b.Name != nil {
		n, err = s.store.Rename(r.Context(), subj, id, *b.Name)
	}
	if err == nil && n == nil {
		err = store.ErrInvalid
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"node": toJSON(n)})
}

func (s *Server) deleteNode(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Trash(r.Context(), userSubject(r), []string{r.PathValue("id")}); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type idsBody struct {
	IDs      []string `json:"ids"`
	ParentID string   `json:"parentId"`
}

func (s *Server) readIDs(w http.ResponseWriter, r *http.Request, needParent bool) (idsBody, bool) {
	var b idsBody
	if err := decode(r, &b); err != nil {
		s.fail(w, r, err)
		return b, false
	}
	if len(b.IDs) == 0 || len(b.IDs) > 1000 || (needParent && b.ParentID == "") {
		writeError(w, http.StatusBadRequest, "invalid", "ids (1 to 1000) and parentId are required")
		return b, false
	}
	return b, true
}

func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	b, ok := s.readIDs(w, r, true)
	if !ok {
		return
	}
	nodes, err := s.store.Move(r.Context(), userSubject(r), b.IDs, b.ParentID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": toJSONList(nodes)})
}

func (s *Server) copy(w http.ResponseWriter, r *http.Request) {
	b, ok := s.readIDs(w, r, true)
	if !ok {
		return
	}
	nodes, err := s.store.Copy(r.Context(), userSubject(r), b.IDs, b.ParentID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"items": toJSONList(nodes)})
}

func (s *Server) trash(w http.ResponseWriter, r *http.Request) {
	b, ok := s.readIDs(w, r, false)
	if !ok {
		return
	}
	if err := s.store.Trash(r.Context(), userSubject(r), b.IDs); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ParentID string `json:"parentId"`
		Name     string `json:"name"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, err)
		return
	}
	if b.ParentID == "root" || b.ParentID == "" {
		b.ParentID = user(r).RootID
	}
	n, err := s.store.CreateFolder(r.Context(), userSubject(r), b.ParentID, b.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"node": toJSON(n)})
}

func (s *Server) activity(w http.ResponseWriter, r *http.Request) {
	entries, err := s.store.Activity(r.Context(), user(r), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if entries == nil {
		entries = []store.ActivityEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": entries})
}

func (s *Server) setStar(w http.ResponseWriter, r *http.Request, on bool) {
	if err := s.store.SetStar(r.Context(), user(r), r.PathValue("id"), on); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) star(w http.ResponseWriter, r *http.Request)   { s.setStar(w, r, true) }
func (s *Server) unstar(w http.ResponseWriter, r *http.Request) { s.setStar(w, r, false) }

func (s *Server) list(w http.ResponseWriter, r *http.Request, nodes []*store.Node, err error) {
	var items []nodeJSON
	if err == nil {
		items, err = s.withSharing(r, nodes)
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// withSharing adds the sharing summary to the signed-in user's own nodes.
func (s *Server) withSharing(r *http.Request, nodes []*store.Node) ([]nodeJSON, error) {
	u := user(r)
	var own []string
	for _, n := range nodes {
		if n.OwnerID == u.ID {
			own = append(own, n.ID)
		}
	}
	sharing, err := s.store.SharingFor(r.Context(), u, own)
	if err != nil {
		return nil, err
	}
	out := toJSONList(nodes)
	for i := range out {
		out[i].Sharing = sharing[out[i].ID]
	}
	return out, nil
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if len(q) > 200 {
		writeError(w, http.StatusBadRequest, "invalid", "query too long")
		return
	}
	nodes, err := s.store.Search(r.Context(), user(r), q)
	s.list(w, r, nodes, err)
}

func (s *Server) recent(w http.ResponseWriter, r *http.Request) {
	nodes, err := s.store.Recent(r.Context(), user(r))
	s.list(w, r, nodes, err)
}

func (s *Server) starred(w http.ResponseWriter, r *http.Request) {
	nodes, err := s.store.Starred(r.Context(), user(r))
	s.list(w, r, nodes, err)
}

func (s *Server) shared(w http.ResponseWriter, r *http.Request) {
	nodes, err := s.store.SharedWithMe(r.Context(), user(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Report the permission each share grants.
	out := make([]nodeJSON, 0, len(nodes))
	for _, n := range nodes {
		_, acc, err := s.store.Authorize(r.Context(), s.store.Pool, userSubject(r), n.ID, store.NeedRead)
		if err != nil {
			continue
		}
		j := toJSON(n)
		j.Permission = acc.Perm.String()
		out = append(out, j)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

type trashJSON struct {
	nodeJSON
	TrashedAt  time.Time `json:"trashedAt"`
	FromFolder string    `json:"fromFolder"`
	PurgeAt    time.Time `json:"purgeAt"`
}

func (s *Server) listTrash(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListTrash(r.Context(), user(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := make([]trashJSON, 0, len(items))
	for _, it := range items {
		out = append(out, trashJSON{nodeJSON: toJSON(it.Node), TrashedAt: it.TrashedAt, FromFolder: it.FromFolder, PurgeAt: it.TrashedAt.Add(s.cfg.TrashRetention)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "retentionDays": int(s.cfg.TrashRetention.Hours() / 24)})
}

func (s *Server) emptyTrash(w http.ResponseWriter, r *http.Request) {
	n, err := s.store.EmptyTrash(r.Context(), user(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	go s.collectBlobs(contextWithoutCancel(r))
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n})
}

func (s *Server) restore(w http.ResponseWriter, r *http.Request) {
	n, err := s.store.Restore(r.Context(), user(r), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"node": toJSON(n)})
}

func (s *Server) deleteForever(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteForever(r.Context(), user(r), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	go s.collectBlobs(contextWithoutCancel(r))
	w.WriteHeader(http.StatusNoContent)
}
