package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"storage-server/internal/disk"
	"storage-server/internal/media"
	"storage-server/internal/vault"
)

const searchLimit = 1000

type entryJSON struct {
	Name    string      `json:"name"`
	Kind    disk.Kind   `json:"kind"`
	Size    int64       `json:"size"`
	ModTime time.Time   `json:"modTime"`
	Preview media.Class `json:"preview"`
}

func entryOf(i disk.Info) entryJSON {
	e := entryJSON{Name: i.Name, Kind: i.Kind, Size: i.Size, ModTime: i.ModTime}
	if i.Kind == disk.KindFile {
		e.Preview = media.ClassOf(i.Name)
	}
	return e
}

// content is one handler for the owner and for every guest. The difference
// between the two surfaces is the scope the gate built. The use is spent only
// after the file opened, so a 404 costs a guest nothing.
func (a *API) content(w http.ResponseWriter, r *http.Request, c *call) {
	f, item, err := c.scope.open(r.URL.Query().Get("path"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer f.Close()
	if err := a.spend(r, c, item); err != nil {
		a.fail(w, r, err)
		return
	}
	media.Serve(a.counted(w, c), r, f, r.URL.Query().Has("download"))
}

func (a *API) list(w http.ResponseWriter, r *http.Request, c *call) {
	tree, err := c.scope.folder()
	if err != nil {
		a.fail(w, r, err)
		return
	}
	p, err := disk.ParsePath(r.URL.Query().Get("path"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	infos, err := tree.List(p)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	entries := make([]entryJSON, 0, len(infos))
	for _, i := range infos {
		entries = append(entries, entryOf(i))
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": p.String(), "entries": entries})
}

func (a *API) mkdir(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{ Path string }
	if err := decode(r, &in, false); err != nil {
		a.fail(w, r, err)
		return
	}
	p, err := disk.ParsePath(in.Path)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := a.vault.Mkdir(p); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": p.String()})
}

func parseEntry(raw string) (disk.Entry, error) {
	p, err := disk.ParsePath(raw)
	if err != nil {
		return disk.Entry{}, err
	}
	e, ok := p.Entry()
	if !ok {
		return disk.Entry{}, disk.ErrInvalidPath
	}
	return e, nil
}

func parseEntries(raw []string) ([]disk.Entry, error) {
	if len(raw) == 0 {
		return nil, invalid("paths is empty")
	}
	entries := make([]disk.Entry, 0, len(raw))
	for _, s := range raw {
		e, err := parseEntry(s)
		if err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, nil
}

func (a *API) rename(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{ Path, Name string }
	if err := decode(r, &in, false); err != nil {
		a.fail(w, r, err)
		return
	}
	e, err := parseEntry(in.Path)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	name, err := disk.ParseName(in.Name)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	p, err := a.vault.Rename(r.Context(), e, name)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": p.String()})
}

type resultJSON struct {
	Path    string `json:"path"`
	NewPath string `json:"newPath,omitempty"`
	TrashID string `json:"trashId,omitempty"`
	Error   string `json:"error,omitempty"`
}

func resultsOf(out []vault.Outcome) map[string][]resultJSON {
	results := make([]resultJSON, 0, len(out))
	for _, o := range out {
		res := resultJSON{Path: o.From.String()}
		if o.Err != nil {
			_, res.Error = classify(o.Err)
		} else {
			res.NewPath, res.TrashID = o.To.String(), string(o.Trash)
		}
		results = append(results, res)
	}
	return map[string][]resultJSON{"results": results}
}

func (a *API) move(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct {
		Paths []string
		To    string
	}
	if err := decode(r, &in, false); err != nil {
		a.fail(w, r, err)
		return
	}
	to, err := disk.ParsePath(in.To)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	entries, err := parseEntries(in.Paths)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, resultsOf(a.vault.Move(r.Context(), entries, to)))
}

func (a *API) trash(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{ Paths []string }
	if err := decode(r, &in, false); err != nil {
		a.fail(w, r, err)
		return
	}
	entries, err := parseEntries(in.Paths)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, resultsOf(a.vault.Trash(r.Context(), entries, time.Now())))
}

func (a *API) thumb(w http.ResponseWriter, r *http.Request, c *call) {
	width, err := strconv.Atoi(r.URL.Query().Get("w"))
	if err != nil || (width != 256 && width != 1024) {
		a.fail(w, r, requestError{http.StatusBadRequest, "invalid_width", "w must be 256 or 1024"})
		return
	}
	f, _, err := c.scope.open(r.URL.Query().Get("path"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer f.Close()
	t, mod, err := a.thumbs.Get(r.Context(), f, width)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer t.Close()
	media.ServeThumb(a.counted(w, c), r, t, mod)
}

// zipItem names a zip for use counting: the same selection on the same grant is
// the same item, whatever order the form listed it in.
func zipItem(paths []disk.Path) string {
	names := make([]string, 0, len(paths))
	for _, p := range paths {
		names = append(names, p.String())
	}
	slices.Sort(names)
	sum := sha256.Sum256([]byte(strings.Join(names, "\x00")))
	return "zip:" + hex.EncodeToString(sum[:])
}

func (a *API) zipName(c *call, paths []disk.Path) string {
	var named disk.Path
	if c.admission != nil {
		named, _ = c.admission.Share.Target.LivePath()
	}
	if len(paths) == 1 && !paths[0].IsRoot() {
		named = paths[0]
	}
	if e, ok := named.Entry(); ok && len(paths) == 1 {
		return e.Name.String() + ".zip"
	}
	return "files.zip"
}

func (a *API) zip(w http.ResponseWriter, r *http.Request, c *call) {
	tree, err := c.scope.folder()
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := r.ParseForm(); err != nil {
		a.fail(w, r, invalid("the form cannot be parsed"))
		return
	}
	raw := r.PostForm["path"]
	if len(raw) == 0 {
		if c.admission == nil {
			a.fail(w, r, disk.ErrInvalidPath)
			return
		}
		raw = []string{""}
	}
	paths := make([]disk.Path, 0, len(raw))
	for _, s := range raw {
		p, err := disk.ParsePath(s)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if _, err := tree.Stat(p); err != nil {
			a.fail(w, r, err)
			return
		}
		paths = append(paths, p)
	}
	if err := a.spend(r, c, zipItem(paths)); err != nil {
		a.fail(w, r, err)
		return
	}
	media.SetArchiveHeaders(w.Header(), a.zipName(c, paths))
	if err := media.WriteZip(r.Context(), a.counted(w, c), tree, paths); err != nil {
		slog.Warn("zip aborted", "err", err)
		panic(http.ErrAbortHandler)
	}
}

type hitJSON struct {
	Preview media.Class `json:"preview"`
	Path    string      `json:"path"`
	Name    string      `json:"name"`
	Kind    disk.Kind   `json:"kind"`
	Size    int64       `json:"size"`
	ModTime time.Time   `json:"modTime"`
}

var errSearchFull = errors.New("search is full")

// search streams NDJSON so the first hits arrive before the walk ends. It stops
// when the client disconnects, at 1000 hits, and it reads nothing but names.
func (a *API) search(w http.ResponseWriter, r *http.Request, c *call) {
	terms := strings.Fields(strings.ToLower(r.URL.Query().Get("q")))
	if len(terms) == 0 {
		a.fail(w, r, requestError{http.StatusBadRequest, "query_required", "q is empty"})
		return
	}
	start, err := disk.ParsePath(r.URL.Query().Get("path"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := checkDir(c.scope.tree, start); err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	rc := http.NewResponseController(w)
	enc := json.NewEncoder(w)
	hits := 0
	err = c.scope.tree.Walk(r.Context(), start, func(p disk.Path, i disk.Info) error {
		if i.Denied || !matches(strings.ToLower(i.Name), terms) {
			return nil
		}
		if hits == searchLimit {
			return errSearchFull
		}
		hits++
		if err := enc.Encode(hitJSON{entryOf(i).Preview, p.String(), i.Name, i.Kind, i.Size, i.ModTime}); err != nil {
			return err
		}
		return rc.Flush()
	})
	truncated := errors.Is(err, errSearchFull)
	if err != nil && !truncated {
		if r.Context().Err() != nil {
			return
		}
		slog.Warn("search stopped early", "err", err)
		truncated = true
	}
	if err := enc.Encode(map[string]bool{"done": true, "truncated": truncated}); err != nil {
		slog.Debug("response not delivered", "err", err)
	}
}

func checkDir(t *disk.Tree, p disk.Path) error {
	info, err := t.Stat(p)
	switch {
	case err != nil:
		return err
	case info.Kind == disk.KindSymlink:
		return disk.ErrSymlink
	case info.Kind != disk.KindDir:
		return disk.ErrNotDirectory
	}
	return nil
}

func matches(name string, terms []string) bool {
	for _, t := range terms {
		if !strings.Contains(name, t) {
			return false
		}
	}
	return true
}

type trashJSON struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	OriginalPath string    `json:"originalPath"`
	Kind         disk.Kind `json:"kind"`
	DeletedAt    time.Time `json:"deletedAt"`
	PurgeAt      time.Time `json:"purgeAt"`
}

func (a *API) listTrash(w http.ResponseWriter, r *http.Request, c *call) {
	items, err := a.vault.ListTrash(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := make([]trashJSON, 0, len(items))
	for _, it := range items {
		out = append(out, trashJSON{string(it.ID), it.Name, it.Original.String(), it.Kind, it.DeletedAt, it.DeletedAt.Add(vault.Retention)})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) restore(w http.ResponseWriter, r *http.Request, c *call) {
	id, err := vault.ParseID(r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	p, err := a.vault.Restore(r.Context(), id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": p.String()})
}

func (a *API) purge(w http.ResponseWriter, r *http.Request, c *call) {
	id, err := vault.ParseID(r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := a.vault.Purge(context.WithoutCancel(r.Context()), id); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) emptyTrash(w http.ResponseWriter, r *http.Request, c *call) {
	if err := a.vault.PurgeAll(context.WithoutCancel(r.Context())); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
