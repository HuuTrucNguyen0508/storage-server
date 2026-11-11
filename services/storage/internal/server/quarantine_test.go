package server_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/blobs"
)

func (e *env) blobPath(id string) string { return filepath.Join(e.dir, "blobs", id[:2], id) }

func (e *env) quarantinePath(id string) string { return filepath.Join(e.dir, "quarantine", id) }

func (e *env) blobOf(nodeID string) string {
	e.t.Helper()
	var id string
	if err := e.st.Pool.QueryRow(context.Background(), "SELECT blob_id FROM nodes WHERE id = $1", nodeID).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func age(t *testing.T, p string, d time.Duration) {
	t.Helper()
	old := time.Now().Add(-d)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
}

func fileHas(t *testing.T, p string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("%s: %v", p, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s: content %q, want %q", p, got, want)
	}
}

func gone(t *testing.T, p string) {
	t.Helper()
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("%s still exists (err %v)", p, err)
	}
}

// A file on disk without a row (for example an upload newer than a restored
// dump) is quarantined, not deleted, once it is past the in-flight guard.
func TestOrphanBlobIsQuarantined(t *testing.T) {
	e := newEnv(t)
	old, fresh := blobs.NewID(), blobs.NewID()
	for _, id := range []string{old, fresh} {
		os.MkdirAll(filepath.Dir(e.blobPath(id)), 0o700)
		if err := os.WriteFile(e.blobPath(id), []byte("orphan "+id), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	age(t, e.blobPath(old), 7*time.Hour)
	age(t, e.blobPath(fresh), time.Hour)
	e.s.Cleanup(context.Background())
	gone(t, e.blobPath(old))
	fileHas(t, e.quarantinePath(old), []byte("orphan "+old))
	// Retention counts from the move, not from the upload.
	if st, err := os.Stat(e.quarantinePath(old)); err != nil || time.Since(st.ModTime()) > time.Minute {
		t.Fatalf("quarantined mtime not refreshed: %v %v", st, err)
	}
	fileHas(t, e.blobPath(fresh), []byte("orphan "+fresh))
	if e.metric(`storage_purged_total{kind="blob"}`) > 0 {
		t.Fatal("a quarantined blob counted as purged")
	}
}

// A blob the collector removed goes to quarantine. When a database restore
// brings its rows back, the next cleanup moves it back and it downloads.
func TestCollectedBlobIsQuarantinedAndRestoreRescuesIt(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	alice := e.as("alice")
	root := alice.root()
	data := []byte("bytes the nightly dump still references")
	f := alice.upload(root, "keep.txt", data)
	blob := e.blobOf(f.ID)
	// The "dump": the rows as they were before the file was deleted.
	var blobRow, nodeRow string
	e.st.Pool.QueryRow(ctx, "SELECT row_to_json(b)::text FROM blobs b WHERE id = $1", blob).Scan(&blobRow)
	e.st.Pool.QueryRow(ctx, "SELECT row_to_json(n)::text FROM nodes n WHERE id = $1", f.ID).Scan(&nodeRow)

	alice.must(alice.req("DELETE", "/api/nodes/"+f.ID, nil), 204)
	e.st.Pool.Exec(ctx, "UPDATE nodes SET trashed_at = now() - interval '31 days' WHERE trash_root IS NOT NULL")
	e.s.Cleanup(ctx)
	gone(t, e.blobPath(blob))
	fileHas(t, e.quarantinePath(blob), data)
	var rows int
	e.st.Pool.QueryRow(ctx, "SELECT count(*) FROM blobs WHERE id = $1", blob).Scan(&rows)
	if rows != 0 {
		t.Fatal("collected blob kept its row")
	}

	// The restore.
	if _, err := e.st.Pool.Exec(ctx, "INSERT INTO blobs SELECT * FROM json_populate_record(NULL::blobs, $1::json)", blobRow); err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.Pool.Exec(ctx, "INSERT INTO nodes SELECT * FROM json_populate_record(NULL::nodes, $1::json)", nodeRow); err != nil {
		t.Fatal(err)
	}
	e.s.Cleanup(ctx)
	gone(t, e.quarantinePath(blob))
	fileHas(t, e.blobPath(blob), data)
	if body := alice.must(alice.get("/api/nodes/"+f.ID+"/content"), 200).Body; !bytes.Equal(body, data) {
		t.Fatalf("rescued content %q", body)
	}
	if !strings.Contains(e.logs.String(), "rescued quarantined blob") {
		t.Fatal("rescue not logged")
	}
}

// Quarantined files are deleted for good once retention has passed.
func TestQuarantineRetention(t *testing.T) {
	e := newEnv(t)
	expired, kept := blobs.NewID(), blobs.NewID()
	for _, id := range []string{expired, kept} {
		os.MkdirAll(filepath.Join(e.dir, "quarantine"), 0o700)
		if err := os.WriteFile(e.quarantinePath(id), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	age(t, e.quarantinePath(expired), 9*24*time.Hour)
	age(t, e.quarantinePath(kept), 7*24*time.Hour)
	e.s.Cleanup(context.Background())
	gone(t, e.quarantinePath(expired))
	fileHas(t, e.quarantinePath(kept), []byte("x"))
	if got := e.metric(`storage_purged_total{kind="blob"}`); got != 1 {
		t.Fatalf("purged blobs %v, want 1", got)
	}
}
