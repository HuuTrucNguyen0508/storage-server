package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaCSP is the policy for the app's own pages: no inline or third-party
// script. 'wasm-unsafe-eval' lets pdf.js run its WebAssembly image decoders
// and does not allow JavaScript eval.
const spaCSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; " +
	"frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

func (s *Server) index(w http.ResponseWriter, r *http.Request) {
	b, err := fs.ReadFile(s.ui, "index.html")
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte("The web interface is not built. Run `pnpm build` in services/storage/web.\n")) //nolint:errcheck
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", spaCSP)
	h.Set("Cache-Control", "no-cache")
	w.Write(b) //nolint:errcheck
}

// spa serves index.html for every client-side route of the signed-in app.
func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	s.index(w, r)
}

// spaPublic serves the same page for /s/{token}; the SPA reads the token
// from the URL and talks only to /api/public. baseHeaders already set
// Referrer-Policy: no-referrer, so the token never leaks in a Referer.
func (s *Server) spaPublic(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	s.index(w, r)
}

func (s *Server) asset(w http.ResponseWriter, r *http.Request) {
	name := path.Clean("assets/" + r.PathValue("file"))
	if !strings.HasPrefix(name, "assets/") {
		s.notFound(w, r)
		return
	}
	s.static(w, r, name, "public, max-age=31536000, immutable")
}

func (s *Server) favicon(w http.ResponseWriter, r *http.Request) {
	s.static(w, r, "favicon.svg", "public, max-age=86400")
}

func (s *Server) static(w http.ResponseWriter, r *http.Request, name, cache string) {
	if st, err := fs.Stat(s.ui, name); err != nil || st.IsDir() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", cache)
	if strings.HasSuffix(name, ".svg") {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	}
	http.ServeFileFS(w, r, s.ui, name)
}
