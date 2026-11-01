// Command storage-server is the one process in the container.
//
//	storage-server              serve
//	storage-server healthcheck  probe /healthz, for a scratch image with no shell
//	storage-server reset-owner  remove the owner, so the setup-code flow runs again
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
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

const defaultMinFree = 5 << 30

type config struct {
	Root, State                   string
	OwnerAddr, GuestAddr, OpsAddr string
	PublicURL, ShareURL           string
	MinFreeBytes                  int64
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func loadConfig() (config, error) {
	cfg := config{
		Root:      os.Getenv("ROOT_DIR"),
		State:     os.Getenv("STATE_DIR"),
		OwnerAddr: env("OWNER_ADDR", ":8080"),
		GuestAddr: env("GUEST_ADDR", ":8081"),
		OpsAddr:   env("OPS_ADDR", ":9090"),
		PublicURL: env("PUBLIC_URL", "http://localhost:8080"),
	}
	cfg.ShareURL = env("SHARE_URL", cfg.PublicURL)
	if cfg.Root == "" || cfg.State == "" {
		return config{}, errors.New("ROOT_DIR and STATE_DIR are required")
	}
	for name, raw := range map[string]string{"PUBLIC_URL": cfg.PublicURL, "SHARE_URL": cfg.ShareURL} {
		if u, err := url.Parse(raw); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return config{}, fmt.Errorf("%s must be an http or https URL, got %q", name, raw)
		}
	}
	minFree, err := strconv.ParseInt(env("MIN_FREE_BYTES", strconv.FormatInt(defaultMinFree, 10)), 10, 64)
	if err != nil || minFree < 0 {
		return config{}, fmt.Errorf("MIN_FREE_BYTES must be a byte count, got %q", os.Getenv("MIN_FREE_BYTES"))
	}
	cfg.MinFreeBytes = minFree
	return cfg, nil
}

func main() {
	syscall.Umask(0o077)
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthcheck":
			return healthcheck()
		case "reset-owner":
			return resetOwner()
		}
		return fmt.Errorf("unknown command %q", os.Args[1])
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
	uploads := upload.New(d.Spool, v, freeSpaceCheck(d, cfg.MinFreeBytes))
	recovered, err := v.Recover(ctx)
	if err != nil {
		return err
	}
	if err := uploads.Recover(ctx); err != nil {
		return err
	}
	acc, err := access.New(ctx, db, v)
	if err != nil {
		return err
	}
	thumbs := media.NewThumbnails(cfg.State + "/thumbs")
	m := metrics.New(gauges(d, db, v, uploads))
	m.Recovered(recovered)
	shell, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		return err
	}
	a := api.New(api.Config{PublicURL: cfg.PublicURL, ShareURL: cfg.ShareURL, Shell: shell}, d, db, v, uploads, acc, thumbs, m)

	go sweep(ctx, time.Hour, v, uploads, db, thumbs)
	return serve(ctx, map[string]http.Handler{
		cfg.OwnerAddr: a.Owner(),
		cfg.GuestAddr: a.Guest(),
		cfg.OpsAddr:   a.Ops(),
	})
}

func healthcheck() error {
	_, port, err := net.SplitHostPort(env("OWNER_ADDR", ":8080"))
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz answered %s", resp.Status)
	}
	return nil
}

func resetOwner() error {
	state := os.Getenv("STATE_DIR")
	if state == "" {
		return errors.New("STATE_DIR is required")
	}
	ctx := context.Background()
	db, err := store.Open(ctx, state+"/state.db")
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.ResetOwner(ctx); err != nil {
		return err
	}
	slog.Info("owner removed, restart the server to get a new setup code")
	return nil
}

func freeSpaceCheck(d *disk.Disk, minFree int64) func(int64) error {
	return func(need int64) error {
		_, free, err := d.Usage()
		if err != nil {
			return err
		}
		if int64(free)-need < minFree {
			return upload.ErrNoSpace
		}
		return nil
	}
}

func gauges(d *disk.Disk, db *store.Store, v *vault.Vault, u *upload.Manager) func(context.Context) (metrics.Gauges, error) {
	return func(ctx context.Context) (metrics.Gauges, error) {
		total, free, err := d.Usage()
		if err != nil {
			return metrics.Gauges{}, err
		}
		spool, active, err := u.Stats(ctx)
		if err != nil {
			return metrics.Gauges{}, err
		}
		items, err := v.ListTrash(ctx)
		if err != nil {
			return metrics.Gauges{}, err
		}
		shares, err := db.CountShares(ctx)
		if err != nil {
			return metrics.Gauges{}, err
		}
		return metrics.Gauges{DiskTotal: total, DiskFree: free, SpoolBytes: spool, TrashItems: len(items), Shares: shares, Uploads: active}, nil
	}
}

func sweep(ctx context.Context, every time.Duration, v *vault.Vault, u *upload.Manager, db *store.Store, t *media.Thumbnails) {
	once := func(now time.Time) {
		for name, err := range map[string]error{
			"trash":   v.Sweep(ctx, now),
			"uploads": u.Sweep(ctx, now),
			"store":   db.Prune(ctx, now),
			"thumbs":  t.Prune(ctx),
		} {
			if err != nil && ctx.Err() == nil {
				slog.Error("sweep", "area", name, "err", err)
			}
		}
	}
	once(time.Now())
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			once(now)
		}
	}
}

func serve(ctx context.Context, listeners map[string]http.Handler) error {
	failed := make(chan error, len(listeners))
	var servers []*http.Server
	for addr, h := range listeners {
		srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
		servers = append(servers, srv)
		go func() {
			slog.Info("listening", "addr", addr)
			if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
				failed <- err
			}
		}()
	}
	var err error
	select {
	case <-ctx.Done():
	case err = <-failed:
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, srv := range servers {
		if serr := srv.Shutdown(shutdown); serr != nil {
			srv.Close()
		}
	}
	return err
}
