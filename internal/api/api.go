package api

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"storage-server/internal/access"
	"storage-server/internal/disk"
	"storage-server/internal/media"
	"storage-server/internal/metrics"
	"storage-server/internal/store"
	"storage-server/internal/upload"
	"storage-server/internal/vault"
)

const (
	sessionCookie = "storage_session"
	grantCookie   = "storage_grant"
	jsonLimit     = 1 << 20
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

func (a *API) mux(keep func(route) bool, s metrics.Surface) http.Handler {
	m := http.NewServeMux()
	for _, rt := range routes {
		if keep(rt) {
			m.Handle(rt.method+" "+rt.path, a.gated(rt, s))
		}
	}
	m.Handle("/{path...}", a.shell(s == metrics.OwnerSurface))
	cop := http.NewCrossOriginProtection()
	cop.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.fail(w, r, requestError{http.StatusForbidden, "cross_origin", "cross-origin request refused"})
	}))
	return cop.Handler(m)
}

// gated is the only way to reach a handler. It builds the call, so a handler has
// no way to run without the check its route declares.
func (a *API) gated(rt route, s metrics.Surface) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !rt.stream {
			r.Body = http.MaxBytesReader(w, r.Body, jsonLimit)
		}
		c := &call{surface: s}
		switch rt.gate {
		case Public, GuestOpen:
		case Owner:
			sess, err := a.access.Authenticate(r.Context(), cookieValue(r, sessionCookie))
			if err != nil {
				a.fail(w, r, err)
				return
			}
			c.session = &sess
			c.scope = scope{tree: a.disk.Files}
		default:
			release, err := a.admit(r, rt.gate, c)
			if err != nil {
				a.fail(w, r, err)
				return
			}
			defer release()
		}
		rt.serve(a, w, r, c)
	})
}

func (a *API) admit(r *http.Request, g Gate, c *call) (release func(), err error) {
	adm, err := a.access.Admit(r.Context(), store.Token(r.PathValue("token")), cookieValue(r, grantCookie), g.act())
	if err != nil {
		return nil, err
	}
	c.admission = &adm
	if g == GuestDrop {
		return func() {}, nil
	}
	opened, err := a.vault.OpenShare(r.Context(), adm.Share.ID)
	if err != nil {
		return nil, err
	}
	c.scope = scope{tree: opened.Dir, file: opened.File}
	return opened.Close, nil
}

func cookieValue(r *http.Request, name string) string {
	if c, err := r.Cookie(name); err == nil {
		return c.Value
	}
	return ""
}

// scope is what a request is confined to. An owner scope is the whole Files
// tree. A folder share is a Sub tree. A file share holds the one file the vault
// opened, so a guest's path parameter has nothing else it could name.
type scope struct {
	tree *disk.Tree
	file *disk.File
}

// open turns the raw path parameter into a file inside the scope, and names the
// item it is for use counting. The gate also closes a file share's descriptor,
// which is harmless because a second Close only returns an error.
func (s scope) open(raw string) (*disk.File, string, error) {
	if s.file != nil {
		return s.file, "file", nil
	}
	p, err := disk.ParsePath(raw)
	if err != nil {
		return nil, "", err
	}
	f, err := s.tree.Open(p)
	return f, p.String(), err
}

// folder is the tree of a scope that has one. A file link has none, so listing
// and zipping one is the same 404 as any route the link kind does not allow.
func (s scope) folder() (*disk.Tree, error) {
	if s.tree == nil {
		return nil, access.ErrWrongKind
	}
	return s.tree, nil
}

// call is what the gate hands a handler. A handler cannot exist without having
// been gated, because the gate builds its only inputs.
type call struct {
	scope     scope
	admission *access.Admission
	session   *store.Session
	surface   metrics.Surface
}

// spend takes a use for a guest's first fetch of an item. HEAD reads no bytes.
func (a *API) spend(r *http.Request, c *call, item string) error {
	if c.admission == nil || r.Method == http.MethodHead {
		return nil
	}
	return a.access.Consume(r.Context(), *c.admission, item)
}

type requestError struct {
	status  int
	code    string
	message string
}

func (e requestError) Error() string { return e.message }

var errorTable = []struct {
	err    error
	status int
	code   string
}{
	{disk.ErrInvalidPath, 400, "invalid_path"},
	{disk.ErrReserved, 400, "reserved_name"},
	{disk.ErrNotFound, 404, "not_found"},
	{store.ErrNotFound, 404, "not_found"},
	{upload.ErrNotFound, 404, "not_found"},
	{access.ErrWrongKind, 404, "not_found"},
	{disk.ErrExists, 409, "exists"},
	{disk.ErrCrossDevice, 409, "cross_device"},
	{upload.ErrOffsetMismatch, 409, "offset_mismatch"},
	{access.ErrAlreadySetUp, 409, "already_set_up"},
	{access.ErrNoSession, 401, "unauthenticated"},
	{access.ErrNeedsGrant, 401, "open_required"},
	{access.ErrBadCredentials, 401, "bad_credentials"},
	{access.ErrBadCode, 401, "bad_code"},
	{access.ErrExpired, 410, "expired"},
	{access.ErrExhausted, 410, "exhausted"},
	{access.ErrUnavailable, 410, "unavailable"},
	{vault.ErrUnavailable, 410, "unavailable"},
	{upload.ErrTooLong, 413, "too_long"},
	{media.ErrNoThumbnail, 415, "no_thumbnail"},
	{disk.ErrSymlink, 422, "symlink_refused"},
	{disk.ErrNotRegular, 422, "not_regular"},
	{disk.ErrNotDirectory, 422, "not_a_directory"},
	{vault.ErrMoveIntoSelf, 422, "move_into_self"},
	{vault.ErrNotShareable, 422, "not_shareable"},
	{vault.ErrDropNeedsFolder, 422, "drop_needs_folder"},
	{access.ErrWeakPassword, 422, "weak_password"},
	{access.ErrRateLimited, 429, "rate_limited"},
	{disk.ErrNoSpace, 507, "insufficient_space"},
	{upload.ErrNoSpace, 507, "insufficient_space"},
	{disk.ErrNotDurable, 500, "not_durable"},
}

func classify(err error) (int, string) {
	var re requestError
	if errors.As(err, &re) {
		return re.status, re.code
	}
	for _, e := range errorTable {
		if errors.Is(err, e.err) {
			return e.status, e.code
		}
	}
	return http.StatusInternalServerError, "internal"
}

func (a *API) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code := classify(err)
	if status >= 500 {
		slog.Error("request failed", "route", r.Pattern, "code", code, "err", err)
	}
	var locked *access.LockedError
	if errors.As(err, &locked) {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(time.Until(locked.Until).Seconds()+1))))
	}
	message := err.Error()
	if status == http.StatusInternalServerError {
		message = "internal error"
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v != nil {
		if err := json.NewEncoder(w).Encode(v); err != nil {
			slog.Debug("response not delivered", "err", err)
		}
	}
}

// decode parses a JSON body. allowEmpty lets a route's every field be optional.
func decode(r *http.Request, v any, allowEmpty bool) error {
	err := json.NewDecoder(r.Body).Decode(v)
	if errors.Is(err, io.EOF) && allowEmpty {
		return nil
	}
	if err != nil {
		return requestError{http.StatusBadRequest, "invalid_json", "the body is not valid JSON"}
	}
	return nil
}

func invalid(message string) error {
	return requestError{http.StatusBadRequest, "invalid_request", message}
}

// counted wraps the writer to count bytes and implements ReadFrom, so sendfile
// survives the wrapper.
func (a *API) counted(w http.ResponseWriter, c *call) http.ResponseWriter {
	return &countedWriter{ResponseWriter: w, add: func(n int64) { a.metrics.Transfer(metrics.Down, c.surface, n) }}
}

type countedWriter struct {
	http.ResponseWriter
	add func(int64)
}

func (w *countedWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.add(int64(n))
	return n, err
}

func (w *countedWriter) ReadFrom(src io.Reader) (int64, error) {
	n, err := w.ResponseWriter.(io.ReaderFrom).ReadFrom(src)
	w.add(n)
	return n, err
}

func (w *countedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

const shellCSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
	"style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

const unbuilt = `<!doctype html><title>storage-server</title><p>The frontend was not built into this binary.`

func setShellHeaders(h http.Header) {
	h.Set("Content-Security-Policy", shellCSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
}

// shell serves the built frontend. A guest listener serves the page only at
// /s/{token}, and the static assets that page loads, which are public anyway.
func (a *API) shell(owner bool) http.Handler {
	notFound := func(w http.ResponseWriter, r *http.Request) {
		a.fail(w, r, requestError{http.StatusNotFound, "not_found", "not found"})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if strings.HasPrefix(name, "api/") || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
			notFound(w, r)
			return
		}
		setShellHeaders(w.Header())
		if name != "" && name != "index.html" && fs.ValidPath(name) {
			if info, err := fs.Stat(a.cfg.Shell, name); err == nil && !info.IsDir() {
				http.ServeFileFS(w, r, a.cfg.Shell, name)
				return
			}
		}
		token, isShare := strings.CutPrefix(name, "s/")
		if !owner && (!isShare || token == "" || strings.Contains(token, "/")) {
			notFound(w, r)
			return
		}
		index, err := fs.ReadFile(a.cfg.Shell, "index.html")
		if err != nil {
			index = []byte(unbuilt)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		if _, err := w.Write(index); err != nil {
			slog.Debug("response not delivered", "err", err)
		}
	})
}

func (a *API) secure(base string) bool { return strings.HasPrefix(base, "https://") }

func (a *API) setCookie(w http.ResponseWriter, name, path string, c access.Cookie, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: c.Value, Path: path, Expires: c.Expires,
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: secure,
	})
}
