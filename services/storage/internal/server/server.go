// Package server is the HTTP layer: routing, middleware and handlers.
package server

import (
	"context"
	"crypto/rand"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/blobs"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/config"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/preview"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/telemetry"
)

// Server holds the app's dependencies.
type Server struct {
	cfg     config.Config
	log     *slog.Logger
	store   *store.Store
	blobs   *blobs.Dir
	m       *telemetry.Metrics
	thumbs  *preview.Thumbnailer
	office  *preview.Office
	ui      fs.FS
	users   userCache
	limiter *limiter
	// grantKey signs the cookies that remember an unlocked password link.
	grantKey []byte
	// uploadLocks serializes writes to one upload session (one replica).
	uploadLocks sync.Map
}

// New wires a server. ui is the built SPA (index.html, assets/, favicon.svg).
func New(ctx context.Context, cfg config.Config, log *slog.Logger, st *store.Store, dir *blobs.Dir, m *telemetry.Metrics, ui fs.FS) (*Server, error) {
	key, err := st.Setting(ctx, "link_grant_key", func() []byte {
		b := make([]byte, 32)
		rand.Read(b) //nolint:errcheck
		return b
	})
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg: cfg, log: log, store: st, blobs: dir, m: m, ui: ui,
		thumbs:   preview.NewThumbnailer(dir, m, 4),
		office:   preview.NewOffice(cfg.StirlingURL, cfg.OfficeConcurrency, cfg.OfficeTimeout, cfg.OfficeMaxBytes, dir, m),
		limiter:  newLimiter(),
		grantKey: key,
	}
	s.office.Log = log
	st.SpaceCheck = s.spaceCheck
	return s, nil
}

// spaceCheck refuses writes that would leave the volume under the minimum
// free share.
func (s *Server) spaceCheck(extra int64) error {
	total, avail, err := s.blobs.Space()
	if err != nil {
		return err
	}
	reserve := uint64(float64(total) * s.cfg.MinFreePercent / 100)
	if extra < 0 || uint64(extra)+reserve > avail {
		return store.ErrVolumeFull
	}
	return nil
}

// Handler is everything served on the app port.
func (s *Server) Handler() http.Handler {
	// Public routes: share links and the static files the guest page needs.
	// They never read identity headers and never fall through to private routes.
	pub := http.NewServeMux()
	pub.HandleFunc("GET /s/{token}", s.spaPublic)
	pub.HandleFunc("GET /s/{token}/{rest...}", s.spaPublic)
	pub.HandleFunc("GET /assets/{file...}", s.asset)
	pub.HandleFunc("GET /favicon.svg", s.favicon)
	pub.HandleFunc("GET /healthz", s.healthz)
	pub.HandleFunc("GET /readyz", s.readyz)
	pub.HandleFunc("GET /api/public/{token}", s.pubInfo)
	pub.HandleFunc("POST /api/public/{token}/unlock", s.pubUnlock)
	pub.HandleFunc("GET /api/public/{token}/nodes/{id}", s.pubNode)
	pub.HandleFunc("GET /api/public/{token}/nodes/{id}/children", s.pubChildren)
	pub.HandleFunc("GET /api/public/{token}/nodes/{id}/content", s.pubContent)
	pub.HandleFunc("GET /api/public/{token}/nodes/{id}/raw", s.pubRaw)
	pub.HandleFunc("GET /api/public/{token}/nodes/{id}/thumbnail", s.pubThumbnail)
	pub.HandleFunc("GET /api/public/{token}/nodes/{id}/office-preview", s.pubOffice)
	pub.HandleFunc("GET /api/public/{token}/nodes/{id}/archive", s.pubArchive)
	pub.HandleFunc("GET /api/public/{token}/zip", s.pubZip)
	pub.HandleFunc("POST /api/public/{token}/uploads", s.pubUploadCreate)
	pub.HandleFunc("GET /api/public/{token}/uploads/{uid}", s.pubUploadStatus)
	pub.HandleFunc("PUT /api/public/{token}/uploads/{uid}", s.pubUploadChunk)
	pub.HandleFunc("DELETE /api/public/{token}/uploads/{uid}", s.pubUploadCancel)
	pub.HandleFunc("/api/public/", s.notFound)
	public := routed(pub)

	priv := http.NewServeMux()
	priv.HandleFunc("GET /api/me", s.me)
	priv.HandleFunc("GET /api/users", s.searchUsers)
	priv.HandleFunc("GET /api/nodes/{id}", s.getNode)
	priv.HandleFunc("PATCH /api/nodes/{id}", s.patchNode)
	priv.HandleFunc("DELETE /api/nodes/{id}", s.deleteNode)
	priv.HandleFunc("GET /api/nodes/{id}/children", s.children)
	priv.HandleFunc("GET /api/nodes/{id}/content", s.content)
	priv.HandleFunc("GET /api/nodes/{id}/raw", s.raw)
	priv.HandleFunc("GET /api/nodes/{id}/thumbnail", s.thumbnail)
	priv.HandleFunc("GET /api/nodes/{id}/office-preview", s.officePreview)
	priv.HandleFunc("GET /api/nodes/{id}/archive", s.archive)
	priv.HandleFunc("GET /api/nodes/{id}/activity", s.activity)
	priv.HandleFunc("PUT /api/nodes/{id}/star", s.star)
	priv.HandleFunc("DELETE /api/nodes/{id}/star", s.unstar)
	priv.HandleFunc("GET /api/nodes/{id}/shares", s.listShares)
	priv.HandleFunc("POST /api/nodes/{id}/shares", s.createShare)
	priv.HandleFunc("DELETE /api/shares/{id}", s.deleteShare)
	priv.HandleFunc("GET /api/nodes/{id}/links", s.listNodeLinks)
	priv.HandleFunc("POST /api/nodes/{id}/links", s.createLink)
	priv.HandleFunc("GET /api/links", s.listMyLinks)
	priv.HandleFunc("DELETE /api/links/{id}", s.revokeLink)
	priv.HandleFunc("POST /api/folders", s.createFolder)
	priv.HandleFunc("POST /api/nodes/move", s.move)
	priv.HandleFunc("POST /api/nodes/copy", s.copy)
	priv.HandleFunc("POST /api/nodes/trash", s.trash)
	priv.HandleFunc("GET /api/zip", s.zip)
	priv.HandleFunc("GET /api/search", s.search)
	priv.HandleFunc("GET /api/recent", s.recent)
	priv.HandleFunc("GET /api/starred", s.starred)
	priv.HandleFunc("GET /api/shared", s.shared)
	priv.HandleFunc("GET /api/trash", s.listTrash)
	priv.HandleFunc("DELETE /api/trash", s.emptyTrash)
	priv.HandleFunc("POST /api/trash/{id}/restore", s.restore)
	priv.HandleFunc("DELETE /api/trash/{id}", s.deleteForever)
	priv.HandleFunc("POST /api/uploads", s.uploadCreate)
	priv.HandleFunc("GET /api/uploads/{uid}", s.uploadStatus)
	priv.HandleFunc("PUT /api/uploads/{uid}", s.uploadChunk)
	priv.HandleFunc("DELETE /api/uploads/{uid}", s.uploadCancel)
	priv.HandleFunc("GET /api/admin/users", s.adminUsers)
	priv.HandleFunc("PATCH /api/admin/users/{id}", s.adminSetQuota)
	priv.HandleFunc("GET /api/admin/links", s.adminLinks)
	priv.HandleFunc("DELETE /api/admin/links/{id}", s.adminRevokeLink)
	priv.HandleFunc("/api/", s.notFound)
	priv.HandleFunc("/", s.spa)
	private := s.identify(routed(priv))

	dispatch := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isPublicPath(r.URL.Path) {
			public.ServeHTTP(w, r)
			return
		}
		private.ServeHTTP(w, r)
	})
	return s.observe(baseHeaders(s.forgery(dispatch)))
}

// isPublicPath matches the public IngressRoute: /s/, /api/public/ and
// /assets/ on segment boundaries, the exact /favicon.svg, and the probes.
func isPublicPath(p string) bool {
	switch p {
	case "/favicon.svg", "/healthz", "/readyz", "/s", "/api/public", "/assets":
		return true
	}
	return strings.HasPrefix(p, "/s/") || strings.HasPrefix(p, "/api/public/") || strings.HasPrefix(p, "/assets/")
}

// MetricsHandler serves Prometheus metrics (OpenMetrics, for exemplars) on
// the metrics port.
func (s *Server) MetricsHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.m.Registry, promhttp.HandlerOpts{EnableOpenMetrics: true}))
	return mux
}

func (s *Server) notFound(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotFound, "not_found", "no such endpoint")
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte("ok\n")) //nolint:errcheck
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "not_ready", "database unreachable")
		return
	}
	s.healthz(w, r)
}

// RunBackground runs the periodic jobs until ctx ends: gauges every 30 s,
// cleanup (trash purge, stale uploads, blob quarantine) every 15 min.
func (s *Server) RunBackground(ctx context.Context) {
	gauges := time.NewTicker(30 * time.Second)
	cleanup := time.NewTicker(15 * time.Minute)
	defer gauges.Stop()
	defer cleanup.Stop()
	s.updateGauges(ctx)
	s.Cleanup(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-gauges.C:
			s.updateGauges(ctx)
		case <-cleanup.C:
			s.Cleanup(ctx)
		}
	}
}

func (s *Server) updateGauges(ctx context.Context) {
	if t, err := s.store.Totals(ctx); err == nil {
		s.m.Files.Set(float64(t.Files))
		s.m.UsedBytes.Set(float64(t.UsedBytes))
		s.m.SharesActive.WithLabelValues("user").Set(float64(t.UserShares))
		s.m.SharesActive.WithLabelValues("link").Set(float64(t.LinkShares))
	} else if !errors.Is(err, context.Canceled) {
		s.log.WarnContext(ctx, "gauge update failed", "err", err)
	}
	if total, avail, err := s.blobs.Space(); err == nil {
		s.m.VolumeFree.Set(float64(avail))
		s.m.VolumeTotal.Set(float64(total))
	}
}

// Cleanup purges old trash and abandoned uploads, and quarantines
// unreferenced blobs. Quarantined blobs are deleted only after
// QuarantineRetention, so a database restore can still find them.
func (s *Server) Cleanup(ctx context.Context) {
	if n, err := s.store.PurgeTrash(ctx, time.Now().Add(-s.cfg.TrashRetention)); err != nil {
		s.log.WarnContext(ctx, "trash purge failed", "err", err)
	} else if n > 0 {
		s.m.Purged.WithLabelValues("trash").Add(float64(n))
		s.log.InfoContext(ctx, "purged old trash", "items", n)
	}
	if ids, err := s.store.StaleUploads(ctx, time.Now().Add(-s.cfg.UploadTTL)); err == nil {
		for _, id := range ids {
			if err := s.blobs.RemoveUpload(id); err == nil {
				if s.store.DeleteUpload(ctx, id) == nil {
					s.m.Purged.WithLabelValues("upload").Inc()
				}
			}
		}
		if len(ids) > 0 {
			s.log.InfoContext(ctx, "purged abandoned uploads", "sessions", len(ids))
		}
	}
	s.sweepQuarantine(ctx)
	s.collectBlobs(ctx)
	// Files on disk the database does not know (a crash between writing and
	// recording, or uploads newer than a restored dump) are quarantined once
	// they are old enough not to be in flight.
	s.blobs.Orphans(6*time.Hour, func(id string) { //nolint:errcheck
		if ok, err := s.store.BlobExists(ctx, id); err == nil && !ok {
			if err := s.blobs.Quarantine(id); err != nil {
				s.log.WarnContext(ctx, "orphan blob quarantine failed", "blob", id, "err", err)
			}
		}
	}, func(session string) {
		if ok, err := s.store.UploadExists(ctx, session); err == nil && !ok {
			s.blobs.RemoveUpload(session) //nolint:errcheck
		}
	})
}

// sweepQuarantine moves quarantined blobs the database references again (a
// restore) back into place, and deletes the rest once retention has passed
// and they predate the oldest kept dump.
func (s *Server) sweepQuarantine(ctx context.Context) {
	cutoff := time.Now().Add(-s.cfg.QuarantineRetention)
	if s.cfg.BackupDir != "" {
		oldest, err := oldestDump(s.cfg.BackupDir)
		if err != nil {
			s.log.WarnContext(ctx, "backup directory unreadable; using quarantine retention only", "err", err)
		} else if !oldest.IsZero() && oldest.Before(cutoff) {
			cutoff = oldest
		}
	}
	err := s.blobs.Quarantined(func(id string, since time.Time) {
		ok, err := s.store.BlobExists(ctx, id)
		switch {
		case err != nil:
			return
		case ok:
			if err := s.blobs.Unquarantine(id); err != nil {
				s.log.WarnContext(ctx, "blob rescue failed", "blob", id, "err", err)
				return
			}
			s.log.WarnContext(ctx, "rescued quarantined blob the database references again", "blob", id)
		case since.Before(cutoff):
			if err := s.blobs.Purge(id); err != nil {
				s.log.WarnContext(ctx, "quarantined blob removal failed", "blob", id, "err", err)
				return
			}
			s.m.Purged.WithLabelValues("blob").Inc()
		}
	})
	if err != nil {
		s.log.WarnContext(ctx, "quarantine sweep failed", "err", err)
	}
}

// collectBlobs quarantines blobs no node references any more.
func (s *Server) collectBlobs(ctx context.Context) {
	ids, err := s.store.UnreferencedBlobs(ctx)
	if err != nil {
		s.log.WarnContext(ctx, "blob collection failed", "err", err)
		return
	}
	for _, id := range ids {
		ok, err := s.store.DeleteBlobRow(ctx, id)
		if err != nil || !ok {
			continue
		}
		if err := s.blobs.Quarantine(id); err != nil {
			s.log.WarnContext(ctx, "blob quarantine failed", "blob", id, "err", err)
		}
	}
}

// oldestDump needs directory read/execute permissions, not access to dump contents.
func oldestDump(dir string) (time.Time, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return time.Time{}, err
	}
	var oldest time.Time
	for _, entry := range entries {
		match, _ := filepath.Match("storage-*.dump", entry.Name())
		if !match {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return time.Time{}, err
		}
		if info.Mode().IsRegular() && (oldest.IsZero() || info.ModTime().Before(oldest)) {
			oldest = info.ModTime()
		}
	}
	return oldest, nil
}
