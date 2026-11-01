package api

import "net/http"

func (a *API) session(w http.ResponseWriter, r *http.Request, c *call) { panic("not implemented") }
func (a *API) setup(w http.ResponseWriter, r *http.Request, c *call)   { panic("not implemented") }
func (a *API) login(w http.ResponseWriter, r *http.Request, c *call)   { panic("not implemented") }
func (a *API) logout(w http.ResponseWriter, r *http.Request, c *call)  { panic("not implemented") }
func (a *API) sessions(w http.ResponseWriter, r *http.Request, c *call) {
	panic("not implemented")
}
func (a *API) revokeSession(w http.ResponseWriter, r *http.Request, c *call) {
	panic("not implemented")
}
func (a *API) healthz(w http.ResponseWriter, r *http.Request, c *call) { panic("not implemented") }
