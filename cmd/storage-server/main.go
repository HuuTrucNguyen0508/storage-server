// Command storage-server is the one process in the container.
//
//	storage-server              serve
//	storage-server healthcheck  probe /healthz, for a scratch image with no shell
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"storage-server/internal/access"
	"storage-server/internal/api"
	"storage-server/internal/disk"
	"storage-server/internal/media"
	"storage-server/internal/metrics"
	"storage-server/internal/store"
	"storage-server/internal/upload"
	"storage-server/internal/vault"
	"storage-server/web"
)

type config struct {
	Root, State                   string
	OwnerAddr, GuestAddr, OpsAddr string
	PublicURL, ShareURL           string
	MinFreeBytes                  int64
}

func loadConfig() (config, error) { panic("not implemented") }

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		return healthcheck()
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	d, err := disk.Open(cfg.Root)
	if err != nil {
		return err
	}
	defer d.Close()
	db, err := store.Open(ctx, cfg.State+"/state.db")
	if err != nil {
		return err
	}
	defer db.Close()

	v := vault.New(d, db)
	uploads := upload.New(d.Spool, dropDestination(d, db), freeSpaceCheck(d, cfg.MinFreeBytes), nil)
	if err := v.Recover(ctx); err != nil {
		return err
	}
	if err := uploads.Recover(ctx); err != nil {
		return err
	}
	acc, err := access.New(ctx, db, d.Files)
	if err != nil {
		return err
	}
	thumbs := media.NewThumbnails(cfg.State + "/thumbs")
	m := metrics.New(gauges(d, db))
	a := api.New(api.Config{PublicURL: cfg.PublicURL, ShareURL: cfg.ShareURL, Shell: web.Dist}, d, db, v, uploads, acc, thumbs, m)

	go sweep(ctx, time.Hour, v, uploads, db, thumbs)
	return serve(ctx, map[string]http.Handler{
		cfg.OwnerAddr: a.Owner(),
		cfg.GuestAddr: a.Guest(),
		cfg.OpsAddr:   a.Ops(),
	})
}

func healthcheck() error { panic("not implemented") }

func dropDestination(d *disk.Disk, db *store.Store) upload.Destination { panic("not implemented") }

func freeSpaceCheck(d *disk.Disk, min int64) func(int64) error { panic("not implemented") }

func gauges(d *disk.Disk, db *store.Store) func(context.Context) (metrics.Gauges, error) {
	panic("not implemented")
}

// sweep runs at start and hourly. Each sweep is idempotent.
func sweep(ctx context.Context, every time.Duration, v *vault.Vault, u *upload.Manager, db *store.Store, t *media.Thumbnails) {
	panic("not implemented")
}

// serve runs one http.Server per listener. ReadHeaderTimeout is set and
// ReadTimeout is not, because uploads use rolling per-read deadlines.
func serve(ctx context.Context, listeners map[string]http.Handler) error { panic("not implemented") }
