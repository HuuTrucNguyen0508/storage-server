package api

import (
	"net/http"

	"storage-server/internal/media"
)

// content is one handler for the owner and for every guest. The difference
// between the two surfaces is the scope the gate built.
func (a *API) content(w http.ResponseWriter, r *http.Request, c *call) {
	p, err := c.scope.resolve(r.URL.Query().Get("path"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	f, err := c.scope.tree.Open(p)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer f.Close()
	media.Serve(a.counted(w, c), r, f, r.URL.Query().Has("download"))
}

func (a *API) trash(w http.ResponseWriter, r *http.Request, c *call) { panic("not implemented") }
func (a *API) list(w http.ResponseWriter, r *http.Request, c *call)  { panic("not implemented") }
func (a *API) mkdir(w http.ResponseWriter, r *http.Request, c *call) { panic("not implemented") }
func (a *API) rename(w http.ResponseWriter, r *http.Request, c *call) {
	panic("not implemented")
}
func (a *API) move(w http.ResponseWriter, r *http.Request, c *call)  { panic("not implemented") }
func (a *API) thumb(w http.ResponseWriter, r *http.Request, c *call) { panic("not implemented") }
func (a *API) zip(w http.ResponseWriter, r *http.Request, c *call)   { panic("not implemented") }

// search streams NDJSON so the first hits arrive before the walk ends. It stops
// when the client disconnects, at 1000 hits, and it reads nothing but names.
func (a *API) search(w http.ResponseWriter, r *http.Request, c *call) { panic("not implemented") }

func (a *API) listTrash(w http.ResponseWriter, r *http.Request, c *call) {
	panic("not implemented")
}
func (a *API) restore(w http.ResponseWriter, r *http.Request, c *call) { panic("not implemented") }
