// Command storage is the lab's file server: a JSON API, the embedded web
// app, and public share links, with metrics on a separate port.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/blobs"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/config"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/server"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/telemetry"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/web"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	log := telemetry.NewLogger(os.Stdout, level)
	if err := run(log); err != nil {
		log.Error("exiting", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	shutdownTracing, err := telemetry.InitTracing(ctx)
	if err != nil {
		return fmt.Errorf("tracing: %w", err)
	}
	defer shutdownTracing(context.Background()) //nolint:errcheck

	dir, err := blobs.Open(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("data dir: %w", err)
	}
	st, err := store.Open(ctx, cfg.DatabaseURL, cfg.DefaultQuota, log)
	if err != nil {
		return err
	}
	defer st.Close()

	metrics := telemetry.NewMetrics()
	srv, err := server.New(ctx, cfg, log, st, dir, metrics, web.FS())
	if err != nil {
		return err
	}
	app := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       2 * time.Minute,
		// No read/write timeouts: multi-GiB uploads and downloads stream for as long as they need.
	}
	metricsSrv := &http.Server{Addr: cfg.MetricsAddr, Handler: srv.MetricsHandler(), ReadHeaderTimeout: 10 * time.Second}

	bgCtx, bgCancel := context.WithCancel(ctx)
	defer bgCancel()
	// Data from older versions is 0700/0600 in group 65532; make it readable to
	// the host owner's group (DATA_GID) without holding up readiness. It runs
	// before the background cleanup, which moves files between directories the
	// walk may already have passed.
	go func() {
		start := time.Now()
		r := dir.FixModes(func(p string, err error) { log.Warn("cannot fix data dir permissions", "path", p, "err", err) })
		log.Info("data dir permissions checked", "checked", r.Checked, "changed", r.Changed, "failed", r.Failed,
			"gid", os.Getgid(), "took", time.Since(start).Round(time.Millisecond))
		srv.RunBackground(bgCtx)
	}()

	errc := make(chan error, 2)
	go func() { errc <- app.ListenAndServe() }()
	go func() { errc <- metricsSrv.ListenAndServe() }()
	log.Info("listening", "addr", cfg.ListenAddr, "metrics", cfg.MetricsAddr, "auth_mode", cfg.AuthMode, "public_url", cfg.PublicURL)

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	log.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	bgCancel()
	err = app.Shutdown(sctx)
	metricsSrv.Shutdown(sctx) //nolint:errcheck
	return err
}

// healthcheck lets a distroless image probe itself: storage healthcheck.
func healthcheck() int {
	port := "8080"
	if addr := os.Getenv("LISTEN_ADDR"); strings.Contains(addr, ":") {
		port = addr[strings.LastIndexByte(addr, ':')+1:]
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
