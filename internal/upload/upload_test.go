package upload

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"storage-server/internal/disk"
	"storage-server/internal/store"
	"storage-server/internal/vault"
)

func TestPhaseOf(t *testing.T) {
	for _, c := range []struct {
		name                string
		size, length        int64
		hasData, hasPublish bool
		want                Phase
	}{
		{"created, no data yet", 0, 10, false, false, Receiving},
		{"partial", 4, 10, true, false, Receiving},
		{"all bytes", 10, 10, true, false, Complete},
		{"zero length with data", 0, 0, true, false, Complete},
		{"intent written", 10, 10, true, true, Publishing},
		{"renamed away", 0, 10, false, true, Published},
		{"zero length renamed away", 0, 0, false, true, Published},
		{"stray intent on partial data", 4, 10, true, true, Receiving},
	} {
		if got := phaseOf(c.size, c.length, c.hasData, c.hasPublish); got != c.want {
			t.Errorf("%s: phase %d, want %d", c.name, got, c.want)
		}
	}
}

type env struct {
	m    *Manager
	v    *vault.Vault
	d    *disk.Disk
	db   *store.Store
	root string
}

func setup(t *testing.T) env {
	t.Helper()
	root := filepath.Join(t.TempDir(), "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	d, err := disk.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	v := vault.New(d, db)
	return env{New(d.Spool, v, func(int64) error { return nil }), v, d, db, root}
}

func path(t *testing.T, raw string) disk.Path {
	t.Helper()
	p, err := disk.ParsePath(raw)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// stream is a body that yields its bytes, then either EOF or a stall until
// interrupted, so a takeover can be driven without a socket.
type stream struct {
	r           io.Reader
	stall       bool
	interrupted chan struct{}
}

func body(s string) *stream { return &stream{r: strings.NewReader(s)} }

func (s *stream) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if err == io.EOF && s.stall {
		<-s.interrupted
		return 0, errors.New("interrupted")
	}
	return n, err
}

func (s *stream) Interrupt() { close(s.interrupted) }

func (e env) read(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestResumeFromStoredSize(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, st, err := e.m.Create(ctx, Scope{}, path(t, "dir/f.txt"), 10)
	if err != nil || st.Offset != 0 || st.Length != 10 {
		t.Fatalf("Create = %+v, %v", st, err)
	}
	if st, err = e.m.Append(ctx, Scope{}, id, 0, body("hello")); err != nil || st.Offset != 5 || st.Phase != Receiving {
		t.Fatalf("first Append = %+v, %v", st, err)
	}
	if st, err = e.m.Status(ctx, Scope{}, id); err != nil || st.Offset != 5 {
		t.Fatalf("Status = %+v, %v", st, err)
	}
	if st, err = e.m.Append(ctx, Scope{}, id, 4, body("x")); !errors.Is(err, ErrOffsetMismatch) || st.Offset != 5 {
		t.Fatalf("stale offset = %+v, %v", st, err)
	}
	if _, err := os.Stat(filepath.Join(e.root, "dir")); !os.IsNotExist(err) {
		t.Fatal("a partial upload touched the tree")
	}
	st, err = e.m.Append(ctx, Scope{}, id, 5, body("world"))
	if err != nil || st.Phase != Published || st.Offset != 10 || st.Stored.String() != "dir/f.txt" {
		t.Fatalf("last Append = %+v, %v", st, err)
	}
	if got := e.read(t, "dir/f.txt"); got != "helloworld" {
		t.Fatalf("published %q", got)
	}
	if st, err = e.m.Status(ctx, Scope{}, id); err != nil || st.Offset != 10 || st.Stored.String() != "dir/f.txt" {
		t.Fatalf("Status after publish = %+v, %v", st, err)
	}
	if st, err = e.m.Append(ctx, Scope{}, id, 10, body("")); err != nil || st.Phase != Published {
		t.Fatalf("a retried last PATCH = %+v, %v", st, err)
	}
}

func TestZeroLengthPublishesDuringCreate(t *testing.T) {
	e := setup(t)
	_, st, err := e.m.Create(context.Background(), Scope{}, path(t, "empty.txt"), 0)
	if err != nil || st.Phase != Published || st.Stored.String() != "empty.txt" {
		t.Fatalf("Create = %+v, %v", st, err)
	}
	if got := e.read(t, "empty.txt"); got != "" {
		t.Fatalf("body = %q", got)
	}
}

func TestTooLongKeepsNothingPastTheLength(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _, err := e.m.Create(ctx, Scope{}, path(t, "f"), 4)
	if err != nil {
		t.Fatal(err)
	}
	st, err := e.m.Append(ctx, Scope{}, id, 0, body("too long"))
	if !errors.Is(err, ErrTooLong) || st.Offset != 0 {
		t.Fatalf("Append = %+v, %v", st, err)
	}
}

func TestPublishCollisionTakesTheNextName(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(e.root, "f.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	id, _, err := e.m.Create(ctx, Scope{}, path(t, "f.txt"), 3)
	if err != nil {
		t.Fatal(err)
	}
	st, err := e.m.Append(ctx, Scope{}, id, 0, body("new"))
	if err != nil || st.Stored.String() != "f (1).txt" {
		t.Fatalf("Append = %+v, %v", st, err)
	}
	if e.read(t, "f.txt") != "old" || e.read(t, "f (1).txt") != "new" {
		t.Fatal("an upload replaced a file")
	}
}

func TestNewerRequestTakesOverAStalledWriter(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _, err := e.m.Create(ctx, Scope{}, path(t, "f"), 6)
	if err != nil {
		t.Fatal(err)
	}
	stalled := &stream{r: strings.NewReader("abc"), stall: true, interrupted: make(chan struct{})}
	first := make(chan error, 1)
	go func() {
		_, err := e.m.Append(ctx, Scope{}, id, 0, stalled)
		first <- err
	}()
	for !e.m.live(id) {
		time.Sleep(time.Millisecond)
	}
	for {
		if info, err := e.d.Spool.Stat(id.file(dataFile)); err == nil && info.Size == 3 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	st, err := e.m.Status(ctx, Scope{}, id)
	if err != nil || st.Offset != 3 {
		t.Fatalf("Status = %+v, %v", st, err)
	}
	if err := <-first; err == nil || err.Error() != "interrupted" {
		t.Fatalf("stalled writer = %v", err)
	}
	if e.m.live(id) {
		t.Fatal("Status left a writer registered")
	}
	if st, err = e.m.Append(ctx, Scope{}, id, 3, body("def")); err != nil || st.Phase != Published {
		t.Fatalf("takeover Append = %+v, %v", st, err)
	}
	if got := e.read(t, "f"); got != "abcdef" {
		t.Fatalf("published %q", got)
	}
}

func TestScopeHidesAnotherOwnersUpload(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _, err := e.m.Create(ctx, Scope{}, path(t, "f"), 3)
	if err != nil {
		t.Fatal(err)
	}
	guest := Scope{Drop: "some-share"}
	if _, err := e.m.Status(ctx, guest, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Status = %v", err)
	}
	if err := e.m.Cancel(ctx, guest, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Cancel = %v", err)
	}
	if err := e.m.Cancel(ctx, Scope{}, id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Status(ctx, Scope{}, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after Cancel = %v", err)
	}
}

func TestMinFreeRefusesAtCreate(t *testing.T) {
	e := setup(t)
	e.m.minFree = func(need int64) error {
		if need > 10 {
			return ErrNoSpace
		}
		return nil
	}
	if _, _, err := e.m.Create(context.Background(), Scope{}, path(t, "f"), 11); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("Create = %v", err)
	}
}

func TestCreateRefusesABlockedParent(t *testing.T) {
	e := setup(t)
	if err := os.WriteFile(filepath.Join(e.root, "file"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc", filepath.Join(e.root, "link")); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, _, err := e.m.Create(ctx, Scope{}, path(t, "file/x"), 1); !errors.Is(err, disk.ErrExists) {
		t.Fatalf("under a file = %v", err)
	}
	if _, _, err := e.m.Create(ctx, Scope{}, path(t, "link/x"), 1); !errors.Is(err, disk.ErrSymlink) {
		t.Fatalf("under a symlink = %v", err)
	}
}

func (e env) spool(t *testing.T, rel, body string) {
	t.Helper()
	full := filepath.Join(e.root, disk.ReservedDir, "spool", rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (e env) spoolNames(t *testing.T) string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(e.root, disk.ReservedDir, "spool"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, n := range entries {
		names = append(names, n.Name())
	}
	return strings.Join(names, " ")
}

const (
	idPartial  = "00000000000000000000000000000001"
	idComplete = "00000000000000000000000000000002"
	idIntent   = "00000000000000000000000000000003"
	idDone     = "00000000000000000000000000000004"
	idNoMeta   = "00000000000000000000000000000005"
)

func TestRecoverConvergesEveryCrashState(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.spool(t, idPartial+"/meta.json", `{"path":"partial.txt","length":10}`)
	e.spool(t, idPartial+"/data", "abc")
	e.spool(t, idComplete+"/meta.json", `{"path":"complete.txt","length":3}`)
	e.spool(t, idComplete+"/data", "abc")
	e.spool(t, idIntent+"/meta.json", `{"path":"intent.txt","length":3}`)
	e.spool(t, idIntent+"/data", "abc")
	e.spool(t, idIntent+"/publish.json", `{"path":"intent.txt"}`)
	if err := os.WriteFile(filepath.Join(e.root, "intent.txt"), []byte("taken since"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.spool(t, idDone+"/meta.json", `{"path":"done.txt","length":3}`)
	e.spool(t, idDone+"/publish.json", `{"path":"done.txt"}`)
	e.spool(t, idNoMeta+"/data", "doomed")
	e.spool(t, "abcd.new/meta.json", "{}")

	for range 2 {
		if err := e.m.Recover(ctx); err != nil {
			t.Fatal(err)
		}
	}
	want := idPartial + " " + idComplete + " " + idIntent + " " + idDone
	if got := e.spoolNames(t); got != want {
		t.Fatalf("spool = %q, want %q", got, want)
	}
	if e.read(t, "complete.txt") != "abc" {
		t.Fatal("a complete upload did not publish")
	}
	if e.read(t, "intent.txt") != "taken since" || e.read(t, "intent (1).txt") != "abc" {
		t.Fatal("a redone publish did not take the next name")
	}
	st, err := e.m.Status(ctx, Scope{}, ID(idIntent))
	if err != nil || st.Stored.String() != "intent (1).txt" {
		t.Fatalf("Status = %+v, %v", st, err)
	}
	st, err = e.m.Status(ctx, Scope{}, ID(idPartial))
	if err != nil || st.Offset != 3 || st.Phase != Receiving {
		t.Fatalf("Status = %+v, %v", st, err)
	}
}

func TestSuspendedDropWaitsAndAGoneDropIsRemoved(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	if err := os.MkdirAll(filepath.Join(e.root, "inbox"), 0o755); err != nil {
		t.Fatal(err)
	}
	sh := store.Share{ID: "drop", Token: "t", Kind: store.ShareDrop, CreatedAt: time.Now()}
	if _, err := e.v.CreateShare(ctx, sh, path(t, "inbox")); err != nil {
		t.Fatal(err)
	}
	guest := Scope{Drop: "drop"}
	id, _, err := e.m.Create(ctx, guest, path(t, "d.txt"), 3)
	if err != nil {
		t.Fatal(err)
	}
	e2, _ := path(t, "inbox").Entry()
	out := e.v.Trash(ctx, []disk.Entry{e2}, time.Now())
	if out[0].Err != nil {
		t.Fatal(out[0].Err)
	}
	st, err := e.m.Append(ctx, guest, id, 0, body("abc"))
	if err != nil || st.Phase != Complete || st.Stored.String() != "" {
		t.Fatalf("Append into a suspended drop = %+v, %v", st, err)
	}
	if _, err := e.v.Restore(ctx, out[0].Trash); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Sweep(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := e.read(t, "inbox/d.txt"); got != "abc" {
		t.Fatalf("published %q", got)
	}

	id, _, err = e.m.Create(ctx, guest, path(t, "e.txt"), 1)
	if err != nil {
		t.Fatal(err)
	}
	if st, err := e.m.Append(ctx, guest, id, 0, body("x")); err != nil || st.Phase != Published {
		t.Fatalf("Append = %+v, %v", st, err)
	}
	second, _, err := e.m.Create(ctx, guest, path(t, "f.txt"), 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.db.DeleteShare(ctx, "drop"); err != nil {
		t.Fatal(err)
	}
	if st, err := e.m.Append(ctx, guest, second, 0, body("y")); err != nil || st.Phase != Complete {
		t.Fatalf("Append after revoke = %+v, %v", st, err)
	}
	if err := e.m.Sweep(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(e.spoolNames(t), string(second)) {
		t.Fatal("a complete upload for a deleted share stayed in the spool")
	}
}

func TestSweepExpiresIdleAndTombstones(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	idle, _, err := e.m.Create(ctx, Scope{}, path(t, "idle"), 5)
	if err != nil {
		t.Fatal(err)
	}
	done, _, err := e.m.Create(ctx, Scope{}, path(t, "done"), 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Append(ctx, Scope{}, done, 0, body("x")); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Sweep(ctx, time.Now().Add(TombstoneTTL-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := e.spoolNames(t); !strings.Contains(got, string(done)) || !strings.Contains(got, string(idle)) {
		t.Fatalf("swept early: %q", got)
	}
	if err := e.m.Sweep(ctx, time.Now().Add(TombstoneTTL+time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := e.spoolNames(t); strings.Contains(got, string(done)) || !strings.Contains(got, string(idle)) {
		t.Fatalf("after tombstone TTL: %q", got)
	}
	if err := e.m.Sweep(ctx, time.Now().Add(IdleTTL+time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := e.spoolNames(t); got != "" {
		t.Fatalf("after idle TTL: %q", got)
	}
}

func TestLargeChunkStaysInOrder(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	payload := bytes.Repeat([]byte("0123456789abcdef"), 1<<18)
	id, _, err := e.m.Create(ctx, Scope{}, path(t, "big"), int64(len(payload)))
	if err != nil {
		t.Fatal(err)
	}
	st, err := e.m.Append(ctx, Scope{}, id, 0, &stream{r: bytes.NewReader(payload)})
	if err != nil || st.Phase != Published {
		t.Fatalf("Append = %+v, %v", st, err)
	}
	if got := e.read(t, "big"); got != string(payload) {
		t.Fatalf("published %d bytes, want %d", len(got), len(payload))
	}
}
