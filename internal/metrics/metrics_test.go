package metrics

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
)

func TestTextFormat(t *testing.T) {
	r := New(func(context.Context) (Gauges, error) {
		return Gauges{DiskTotal: 100, DiskFree: 40, SpoolBytes: 7, TrashItems: 2, Shares: 3, Uploads: 1}, nil
	})
	r.Transfer(Up, GuestSurface, 5)
	r.Transfer(Down, OwnerSurface, 9)
	r.LoginFailure()
	r.Recovered(2)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	want := `# TYPE storage_disk_total_bytes gauge
storage_disk_total_bytes 100
# TYPE storage_disk_free_bytes gauge
storage_disk_free_bytes 40
# TYPE storage_spool_bytes gauge
storage_spool_bytes 7
# TYPE storage_uploads_active gauge
storage_uploads_active 1
# TYPE storage_trash_items gauge
storage_trash_items 2
# TYPE storage_shares gauge
storage_shares 3
# TYPE storage_transfer_bytes_total counter
storage_transfer_bytes_total{direction="up",surface="owner"} 0
storage_transfer_bytes_total{direction="up",surface="guest"} 5
storage_transfer_bytes_total{direction="down",surface="owner"} 9
storage_transfer_bytes_total{direction="down",surface="guest"} 0
# TYPE storage_login_failures_total counter
storage_login_failures_total 1
# TYPE storage_recovery_actions_total counter
storage_recovery_actions_total 2
`
	if got := rec.Body.String(); got != want {
		t.Fatalf("got:\n%s", got)
	}
}

func TestScrapeFailureIsAnError(t *testing.T) {
	r := New(func(context.Context) (Gauges, error) { return Gauges{}, errors.New("db gone") })
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != 503 {
		t.Fatalf("status = %d", rec.Code)
	}
}
