//go:build crashpoints

package vault

import (
	"context"
	"errors"
	"storage-server/internal/crash"
	"storage-server/internal/disk"
	"testing"
	"time"
)

func TestPendingMoveFailsClosed(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "shared/a.txt", "public")
	e.write(t, "private/a.txt", "private")
	e.share(t, "s", "shared")
	t.Setenv("FAIL_AT", string(crash.ParentFsync))
	if _, err := e.v.Rename(ctx, entry(t, "shared"), mustName(t, "moved")); !errors.Is(err, disk.ErrNotDurable) {
		t.Fatal(err)
	}
	t.Setenv("FAIL_AT", "")
	checks := map[string]func() error{
		"rename":    func() error { _, err := e.v.Rename(ctx, entry(t, "private"), mustName(t, "shared")); return err },
		"mkdir":     func() error { return e.v.Mkdir(path(t, "new")) },
		"move":      func() error { return e.v.Move(ctx, []disk.Entry{entry(t, "private/a.txt")}, path(t, "moved"))[0].Err },
		"trash":     func() error { return e.v.Trash(ctx, []disk.Entry{entry(t, "private")}, time.Now())[0].Err },
		"restore":   func() error { _, err := e.v.Restore(ctx, "missing"); return err },
		"purge all": func() error { return e.v.PurgeAll(ctx) },
		"sweep":     func() error { return e.v.Sweep(ctx, time.Now()) },
		"purge":     func() error { return e.v.Purge(ctx, "missing") },
		"publish":   func() error { _, err := e.v.Publish(ctx, Publication{}); return err },
		"token":     func() error { _, _, err := e.v.ShareByToken(ctx, "tok-s"); return err },
		"open":      func() error { o, err := e.v.OpenShare(ctx, "s"); o.Close(); return err },
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			if err := check(); err == nil || err.Error() != "vault is awaiting recovery" {
				t.Fatalf("degraded %s = %v, want vault is awaiting recovery", name, err)
			}
		})
	}
	if e.v.Healthy() {
		t.Fatal("degraded vault reports healthy")
	}
	if got := e.read(t, "moved/a.txt"); got != "public" {
		t.Fatal(got)
	}
	restarted := New(e.d, e.db)
	t.Setenv("FAIL_AT", string(crash.ParentFsync))
	if _, err := restarted.Recover(ctx); err == nil {
		t.Fatal("recovery succeeded without durable parents")
	}
	t.Setenv("FAIL_AT", "")
	restarted = New(e.d, e.db)
	if _, err := restarted.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Rename(ctx, entry(t, "private"), mustName(t, "shared")); err != nil {
		t.Fatal(err)
	}
	if got := e.target(t, "s"); got != "live:moved" {
		t.Fatal(got)
	}
}
