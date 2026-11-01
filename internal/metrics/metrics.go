// Package metrics exposes Prometheus text format from atomic counters. The
// label sets are closed enums, so no user path can reach a metric name or label.
package metrics

import (
	"context"
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

func (r *Registry) LoginFailure() { r.loginFailures.Add(1) }
func (r *Registry) Recovered()    { r.recoveries.Add(1) }

func (r *Registry) ServeHTTP(w http.ResponseWriter, req *http.Request) { panic("not implemented") }
