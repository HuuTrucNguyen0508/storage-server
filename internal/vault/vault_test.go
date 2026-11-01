package vault

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"storage-server/internal/disk"
	"storage-server/internal/store"
)

type env struct {
	v    *Vault
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
	return env{New(d, db), d, db, root}
}

func (e env) write(t *testing.T, rel, body string) {
	t.Helper()
	full := filepath.Join(e.root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (e env) read(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func path(t *testing.T, raw string) disk.Path {
	t.Helper()
	p, err := disk.ParsePath(raw)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func entry(t *testing.T, raw string) disk.Entry {
	t.Helper()
	e, ok := path(t, raw).Entry()
	if !ok {
		t.Fatal("root has no entry")
	}
	return e
}

func (e env) share(t *testing.T, id, target string) {
	t.Helper()
	sh := store.Share{ID: store.ShareID(id), Token: store.Token("tok-" + id), Kind: store.ShareLink, CreatedAt: time.Now()}
	if _, err := e.v.CreateShare(context.Background(), sh, path(t, target)); err != nil {
		t.Fatal(err)
	}
}

func (e env) target(t *testing.T, id string) string {
	t.Helper()
	sh, err := e.db.ShareByID(context.Background(), store.ShareID(id))
	if err != nil {
		t.Fatal(err)
	}
	return sh.Target.String()
}

func TestRenameMoveAndShareFollow(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "a/x.txt", "x")
	e.write(t, "b/keep.txt", "k")
	e.share(t, "s", "a/x.txt")

	p, err := e.v.Rename(ctx, entry(t, "a"), mustName(t, "c"))
	if err != nil || p.String() != "c" {
		t.Fatalf("Rename = %v, %v", p, err)
	}
	if got := e.target(t, "s"); got != "live:c/x.txt" {
		t.Fatalf("share = %q", got)
	}
	out := e.v.Move(ctx, []disk.Entry{entry(t, "c/x.txt"), entry(t, "missing")}, path(t, "b"))
	if out[0].Err != nil || out[0].To.String() != "b/x.txt" || !errors.Is(out[1].Err, disk.ErrNotFound) {
		t.Fatalf("Move = %+v", out)
	}
	if got := e.target(t, "s"); got != "live:b/x.txt" {
		t.Fatalf("share = %q", got)
	}
	if out := e.v.Move(ctx, []disk.Entry{entry(t, "b")}, path(t, "b/deep")); !errors.Is(out[0].Err, ErrMoveIntoSelf) {
		t.Fatalf("into self = %+v", out)
	}
	if _, err := e.v.Rename(ctx, entry(t, "b/x.txt"), mustName(t, "keep.txt")); !errors.Is(err, disk.ErrExists) {
		t.Fatalf("taken name = %v", err)
	}
	if _, err := e.v.Rename(ctx, entry(t, "c"), mustName(t, ".Storage-Server")); !errors.Is(err, disk.ErrReserved) {
		t.Fatalf("reserved name = %v", err)
	}
}

func mustName(t *testing.T, raw string) disk.Name {
	t.Helper()
	n, err := disk.ParseName(raw)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestTrashSuspendsAndRestoreResumes(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "dir/sub/x.txt", "x")
	e.share(t, "folder", "dir")
	e.share(t, "file", "dir/sub/x.txt")

	out := e.v.Trash(ctx, []disk.Entry{entry(t, "dir")}, time.Unix(1000, 0))
	if out[0].Err != nil {
		t.Fatal(out[0].Err)
	}
	id := out[0].Trash
	if got, want := e.target(t, "file"), "trash:"+string(id)+"/sub/x.txt"; got != want {
		t.Fatalf("file share = %q, want %q", got, want)
	}
	items, err := e.v.ListTrash(ctx)
	if err != nil || len(items) != 1 || items[0].Original.String() != "dir" || items[0].Kind != disk.KindDir {
		t.Fatalf("items = %+v, %v", items, err)
	}
	sh, _ := e.db.ShareByID(ctx, "file")
	if got := e.v.Original(sh.Target); got != "dir/sub/x.txt" {
		t.Fatalf("Original = %q", got)
	}
	if _, err := e.v.OpenShare(ctx, "file"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("trashed share opened: %v", err)
	}

	e.write(t, "dir/new.txt", "taken")
	p, err := e.v.Restore(ctx, id)
	if err != nil || p.String() != "dir (1)" {
		t.Fatalf("Restore = %v, %v", p, err)
	}
	if got := e.target(t, "file"); got != "live:dir (1)/sub/x.txt" {
		t.Fatalf("restored share = %q", got)
	}
	if got := e.read(t, "dir (1)/sub/x.txt"); got != "x" {
		t.Fatalf("restored body = %q", got)
	}
	if items, _ := e.v.ListTrash(ctx); len(items) != 0 {
		t.Fatalf("trash still lists %+v", items)
	}
}

func TestPurgeDeletesItemAndShares(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "a/x.txt", "x")
	e.write(t, "b.txt", "b")
	e.share(t, "s", "a/x.txt")
	e.share(t, "other", "b.txt")
	now := time.Unix(1_000_000, 0)
	e.v.Trash(ctx, []disk.Entry{entry(t, "a")}, now)

	if err := e.v.Sweep(ctx, now.Add(Retention-time.Second)); err != nil {
		t.Fatal(err)
	}
	if items, _ := e.v.ListTrash(ctx); len(items) != 1 {
		t.Fatalf("swept early: %+v", items)
	}
	if err := e.v.Sweep(ctx, now.Add(Retention)); err != nil {
		t.Fatal(err)
	}
	if items, _ := e.v.ListTrash(ctx); len(items) != 0 {
		t.Fatalf("still listed: %+v", items)
	}
	if _, err := e.db.ShareByID(ctx, "s"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("share survived: %v", err)
	}
	if _, err := e.db.ShareByID(ctx, "other"); err != nil {
		t.Fatalf("unrelated share gone: %v", err)
	}
	left, _ := os.ReadDir(filepath.Join(e.root, disk.ReservedDir, "trash"))
	if len(left) != 0 {
		t.Fatalf("trash dir holds %v", left)
	}
}

func (e env) journal(t *testing.T, from, to string, inode uint64) {
	t.Helper()
	f, err := disk.ParseLocation(from)
	if err != nil {
		t.Fatal(err)
	}
	g, err := disk.ParseLocation(to)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.BeginMove(context.Background(), f, g, inode); err != nil {
		t.Fatal(err)
	}
}

func (e env) inode(t *testing.T, raw string) uint64 {
	t.Helper()
	info, err := e.d.Files.Stat(path(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	return info.Inode
}

func (e env) recoverTwice(t *testing.T) {
	t.Helper()
	for range 2 {
		if _, err := e.v.Recover(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := e.db.PendingMoves(context.Background())
	if err != nil || len(rows) != 0 {
		t.Fatalf("journal = %+v, %v", rows, err)
	}
}

func TestRecoverCommitsWhenTheDestinationHoldsTheInode(t *testing.T) {
	e := setup(t)
	e.write(t, "a.txt", "a")
	e.share(t, "s", "a.txt")
	inode := e.inode(t, "a.txt")
	e.journal(t, "live:a.txt", "live:b.txt", inode)
	if err := os.Rename(filepath.Join(e.root, "a.txt"), filepath.Join(e.root, "b.txt")); err != nil {
		t.Fatal(err)
	}
	e.recoverTwice(t)
	if got := e.target(t, "s"); got != "live:b.txt" {
		t.Fatalf("share = %q", got)
	}
}

func TestRecoverDropsWhenAStrangerHoldsTheDestination(t *testing.T) {
	e := setup(t)
	e.write(t, "a.txt", "a")
	e.share(t, "s", "a.txt")
	e.journal(t, "live:a.txt", "live:b.txt", e.inode(t, "a.txt"))
	e.write(t, "b.txt", "an unrelated upload")
	e.recoverTwice(t)
	if got := e.target(t, "s"); got != "live:a.txt" {
		t.Fatalf("share = %q, a guest link must stay on its own file", got)
	}
}

func TestRecoverDeletesSharesWhenNeitherPathHoldsTheInode(t *testing.T) {
	e := setup(t)
	e.write(t, "a.txt", "a")
	e.share(t, "s", "a.txt")
	inode := e.inode(t, "a.txt")
	e.journal(t, "live:a.txt", "live:b.txt", inode)
	if err := os.Remove(filepath.Join(e.root, "a.txt")); err != nil {
		t.Fatal(err)
	}
	e.write(t, "b.txt", "stranger")
	e.write(t, "a.txt", "another stranger")
	if e.inode(t, "a.txt") == inode || e.inode(t, "b.txt") == inode {
		t.Skip("this filesystem reused the inode at once")
	}
	e.recoverTwice(t)
	if _, err := e.db.ShareByID(context.Background(), "s"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("share survived: %v", err)
	}
}

func TestRecoverTrashStates(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	trash := filepath.Join(disk.ReservedDir, "trash")
	id := func(i int) string { return fmt.Sprintf("%032x", i) }
	e.write(t, filepath.Join(trash, id(1), "meta.json"), `{"originalPath":"p","name":"p","kind":"file"}`)
	e.write(t, filepath.Join(trash, id(2), "item"), "orphan")
	e.write(t, filepath.Join(trash, id(3), "meta.json"), `{"originalPath":"q","name":"q","kind":"file"}`)
	e.write(t, filepath.Join(trash, id(3), "item"), "keep")
	if err := os.MkdirAll(filepath.Join(e.root, trash, id(4)), 0o755); err != nil {
		t.Fatal(err)
	}
	loc := disk.InTrash(disk.TrashID(id(2)), path(t, "inner"))
	if err := e.db.CreateShare(ctx, store.Share{ID: "doomed", Token: "t", Kind: store.ShareLink, Target: loc, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	e.recoverTwice(t)
	left, _ := os.ReadDir(filepath.Join(e.root, trash))
	if len(left) != 1 || left[0].Name() != id(3) {
		t.Fatalf("trash holds %v", left)
	}
	if _, err := e.db.ShareByID(ctx, "doomed"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("share into a purged item survived: %v", err)
	}
}

func spoolFile(t *testing.T, e env, name, body string) disk.Entry {
	t.Helper()
	if err := e.d.Spool.WriteDurable(path(t, name), []byte(body)); err != nil {
		t.Fatal(err)
	}
	return entry(t, name)
}

func TestPublishNeverReplacesAndCreatesParents(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "up/f.txt", "first")
	var intents []string
	got, err := e.v.Publish(ctx, Publication{
		From: spoolFile(t, e, "data", "second"), Path: path(t, "up/f.txt"),
		Intent: func(p disk.Path) error { intents = append(intents, p.String()); return nil },
	})
	if err != nil || got.String() != "up/f (1).txt" {
		t.Fatalf("Publish = %v, %v", got, err)
	}
	if strings.Join(intents, ",") != "up/f (1).txt" {
		t.Fatalf("intents = %v", intents)
	}
	if e.read(t, "up/f.txt") != "first" || e.read(t, "up/f (1).txt") != "second" {
		t.Fatal("a publish overwrote a file")
	}
	got, err = e.v.Publish(ctx, Publication{
		From: spoolFile(t, e, "data2", "deep"), Path: path(t, "new/parents/g.txt"),
		Intent: func(disk.Path) error { return nil },
	})
	if err != nil || got.String() != "new/parents/g.txt" {
		t.Fatalf("Publish = %v, %v", got, err)
	}
}

func TestPublishIntoADropFollowsTheFolder(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "inbox/old.txt", "o")
	sh := store.Share{ID: "drop", Token: "t", Kind: store.ShareDrop, CreatedAt: time.Now()}
	if _, err := e.v.CreateShare(ctx, sh, path(t, "inbox")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.v.Rename(ctx, entry(t, "inbox"), mustName(t, "moved")); err != nil {
		t.Fatal(err)
	}
	pub := Publication{From: spoolFile(t, e, "data", "dropped"), Drop: "drop", Path: path(t, "d.txt"), Intent: func(disk.Path) error { return nil }}
	got, err := e.v.Publish(ctx, pub)
	if err != nil || got.String() != "moved/d.txt" {
		t.Fatalf("Publish = %v, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(e.root, "inbox")); !os.IsNotExist(err) {
		t.Fatal("publish recreated the old folder")
	}

	out := e.v.Trash(ctx, []disk.Entry{entry(t, "moved")}, time.Now())
	pub.From = spoolFile(t, e, "data2", "later")
	pub.Path = path(t, "e.txt")
	if _, err := e.v.Publish(ctx, pub); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("suspended share = %v", err)
	}
	if err := e.v.Purge(ctx, out[0].Trash); err != nil {
		t.Fatal(err)
	}
	if _, err := e.v.Publish(ctx, pub); !errors.Is(err, ErrShareGone) {
		t.Fatalf("purged share = %v", err)
	}
}

func TestCreateShareRefusesWhatCannotBeShared(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "f.txt", "f")
	if err := os.Symlink("f.txt", filepath.Join(e.root, "link")); err != nil {
		t.Fatal(err)
	}
	drop := store.Share{ID: "d", Token: "d", Kind: store.ShareDrop, CreatedAt: time.Now()}
	if _, err := e.v.CreateShare(ctx, drop, path(t, "f.txt")); !errors.Is(err, ErrDropNeedsFolder) {
		t.Fatalf("drop on file = %v", err)
	}
	link := store.Share{ID: "l", Token: "l", Kind: store.ShareLink, CreatedAt: time.Now()}
	if _, err := e.v.CreateShare(ctx, link, path(t, "link")); !errors.Is(err, ErrNotShareable) {
		t.Fatalf("share of a symlink = %v", err)
	}
	if _, err := e.v.CreateShare(ctx, link, path(t, "nope")); !errors.Is(err, disk.ErrNotFound) {
		t.Fatalf("share of nothing = %v", err)
	}
}

func TestOpenShareFollowsTheCurrentTarget(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "a.txt", "mine")
	e.share(t, "s", "a.txt")
	if _, err := e.v.Rename(ctx, entry(t, "a.txt"), mustName(t, "b.txt")); err != nil {
		t.Fatal(err)
	}
	e.write(t, "a.txt", "private")
	o, err := e.v.OpenShare(ctx, "s")
	if err != nil {
		t.Fatal(err)
	}
	defer o.Close()
	buf := make([]byte, 16)
	n, _ := o.File.Read(buf)
	if string(buf[:n]) != "mine" {
		t.Fatalf("guest read %q", buf[:n])
	}
}

func TestCheckParents(t *testing.T) {
	e := setup(t)
	e.write(t, "f.txt", "f")
	if err := os.Symlink("/etc", filepath.Join(e.root, "link")); err != nil {
		t.Fatal(err)
	}
	for raw, want := range map[string]error{
		"": nil, "missing/deep": nil, "f.txt": disk.ErrExists, "f.txt/x": disk.ErrExists,
		"link": disk.ErrSymlink, "link/x": disk.ErrSymlink,
	} {
		if err := e.v.CheckParents(path(t, raw)); !errors.Is(err, want) {
			t.Errorf("CheckParents(%q) = %v, want %v", raw, err, want)
		}
	}
}

func TestPurgeRemovesAChildNoPathCanName(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.write(t, "a/\x01bad", "x")
	out := e.v.Trash(ctx, []disk.Entry{entry(t, "a")}, time.Now())
	if err := e.v.Purge(ctx, out[0].Trash); err != nil {
		t.Fatal(err)
	}
	left, _ := os.ReadDir(filepath.Join(e.root, disk.ReservedDir, "trash"))
	if len(left) != 0 {
		t.Fatalf("trash holds %v", left)
	}
}
