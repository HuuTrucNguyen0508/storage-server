package api

import (
	"io/fs"
	"net/http"

	"storage-server/internal/access"
	"storage-server/internal/disk"
	"storage-server/internal/media"
	"storage-server/internal/metrics"
	"storage-server/internal/store"
	"storage-server/internal/upload"
	"storage-server/internal/vault"
)

type Config struct {
	PublicURL string // base of the owner app, its scheme decides the Secure cookie flag
	ShareURL  string // base printed into share links
	Shell     fs.FS  // built frontend, served at / and /s/{token}
}

type API struct {
	cfg     Config
	disk    *disk.Disk
	db      *store.Store
	vault   *vault.Vault
	uploads *upload.Manager
	access  *access.Service
	thumbs  *media.Thumbnails
	metrics *metrics.Registry
}

func New(cfg Config, d *disk.Disk, db *store.Store, v *vault.Vault, u *upload.Manager, a *access.Service, t *media.Thumbnails, m *metrics.Registry) *API {
	return &API{cfg: cfg, disk: d, db: db, vault: v, uploads: u, access: a, thumbs: t, metrics: m}
}

// Owner is the full surface: every route plus the app shell.
func (a *API) Owner() http.Handler {
	return a.mux(func(route) bool { return true }, metrics.OwnerSurface)
}

// Guest is the Funnel surface: guest routes and the app shell for /s/{token}.
// The login routes are not on it.
func (a *API) Guest() http.Handler {
	return a.mux(func(r route) bool { return r.gate.reachesGuest() && !r.ownerOnlyListener }, metrics.GuestSurface)
}

// Ops serves /metrics on a port compose never publishes.
func (a *API) Ops() http.Handler {
	m := http.NewServeMux()
	m.Handle("GET /metrics", a.metrics)
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { a.healthz(w, r, nil) })
	return m
}

func (a *API) mux(keep func(route) bool, s metrics.Surface) http.Handler { panic("not implemented") }

// scope is the tree a request is confined to. An owner scope is the whole Files
// tree. A folder share is a Sub tree. A file share is the parent's Sub tree with
// the path pinned, so a guest's path parameter cannot name a sibling.
type scope struct {
	tree   *disk.Tree
	pinned *disk.Path
}

// resolve turns the raw path parameter into a Path inside the scope.
func (s scope) resolve(raw string) (disk.Path, error) {
	if s.pinned != nil {
		return *s.pinned, nil
	}
	return disk.ParsePath(raw)
}

// call is what the gate hands a handler. A handler cannot exist without having
// been gated, because the gate builds its only inputs.
type call struct {
	scope     scope
	admission *access.Admission
	session   *store.Session
}

func (a *API) fail(w http.ResponseWriter, r *http.Request, err error) { panic("not implemented") }

// counted wraps the writer to count bytes and implements ReadFrom, so sendfile
// survives the wrapper.
func (a *API) counted(w http.ResponseWriter, c *call) http.ResponseWriter { panic("not implemented") }
