package api

import (
	"net/http"

	"storage-server/internal/upload"
)

// uploadScope binds an upload to the session or to the admitted share. A drop
// guest holding another share's upload ID gets 404.
func uploadScope(c *call) upload.Scope {
	if c.admission != nil {
		return upload.Scope{Drop: c.admission.Share.ID}
	}
	return upload.Scope{}
}

// body adapts a request to upload.Stream, renewing a 60 second read deadline on
// each read so a stalled client cannot hold the upload forever.
type body struct {
	r  *http.Request
	rc *http.ResponseController
}

func (b *body) Read(p []byte) (int, error) { panic("not implemented") }
func (b *body) Interrupt()                 { panic("not implemented") }

// The tus core protocol with the creation and termination extensions. Header
// parsing lives here and stops here.
func (a *API) uploadCreate(w http.ResponseWriter, r *http.Request, c *call) {
	panic("not implemented")
}
func (a *API) uploadHead(w http.ResponseWriter, r *http.Request, c *call) {
	panic("not implemented")
}
func (a *API) uploadPatch(w http.ResponseWriter, r *http.Request, c *call) {
	panic("not implemented")
}
func (a *API) uploadDelete(w http.ResponseWriter, r *http.Request, c *call) {
	panic("not implemented")
}
