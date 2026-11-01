// Package metrics exposes Prometheus text format from atomic counters. The
// label sets are closed enums, so no user path can reach a metric name or label.
package metrics

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
)

type Direction int

const (
	Up Direction = iota
	Down
)

type Surface int

const (
	OwnerSurface Surface = iota
	GuestSurface
)

// Registry is the process's counters. Gauges are read at scrape time from the
// disk and the store, so they cannot drift from their source.
type Registry struct {
	transfer      [2][2]atomic.Int64
	loginFailures atomic.Int64
	recoveries    atomic.Int64
	gauges        func(ctx context.Context) (Gauges, error)
}

// Gauges is read per scrape: storage_disk_total_bytes, storage_disk_free_bytes,
// storage_spool_bytes, storage_trash_items, storage_shares, storage_uploads_active.
type Gauges struct {
	DiskTotal, DiskFree, SpoolBytes uint64
	TrashItems, Shares, Uploads     int
}

func New(g func(ctx context.Context) (Gauges, error)) *Registry { return &Registry{gauges: g} }

// Transfer adds to storage_transfer_bytes_total{direction,surface}.
func (r *Registry) Transfer(d Direction, s Surface, n int64) { r.transfer[d][s].Add(n) }

func (r *Registry) LoginFailure()   { r.loginFailures.Add(1) }
func (r *Registry) Recovered(n int) { r.recoveries.Add(int64(n)) }

var (
	directions = [...]string{Up: "up", Down: "down"}
	surfaces   = [...]string{OwnerSurface: "owner", GuestSurface: "guest"}
)

func (r *Registry) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	g, err := r.gauges(req.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	gauge := func(name string, v any) {
		fmt.Fprintf(w, "# TYPE %s gauge\n%s %v\n", name, name, v)
	}
	counter := func(name string, v int64) {
		fmt.Fprintf(w, "# TYPE %s counter\n%s %d\n", name, name, v)
	}
	gauge("storage_disk_total_bytes", g.DiskTotal)
	gauge("storage_disk_free_bytes", g.DiskFree)
	gauge("storage_spool_bytes", g.SpoolBytes)
	gauge("storage_uploads_active", g.Uploads)
	gauge("storage_trash_items", g.TrashItems)
	gauge("storage_shares", g.Shares)
	fmt.Fprintln(w, "# TYPE storage_transfer_bytes_total counter")
	for d := range r.transfer {
		for s := range r.transfer[d] {
			fmt.Fprintf(w, "storage_transfer_bytes_total{direction=%q,surface=%q} %d\n", directions[d], surfaces[s], r.transfer[d][s].Load())
		}
	}
	counter("storage_login_failures_total", r.loginFailures.Load())
	counter("storage_recovery_actions_total", r.recoveries.Load())
}
