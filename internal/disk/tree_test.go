package disk

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const canary = "CANARY-outside-the-root"

func plant(t *testing.T) (*Disk, string) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "root")
	must(t, os.MkdirAll(filepath.Join(root, "shared"), 0o755))
	must(t, os.MkdirAll(filepath.Join(base, "outside"), 0o755))
	must(t, os.WriteFile(filepath.Join(base, "outside", "outside.txt"), []byte(canary), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "sibling.txt"), []byte(canary), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "shared", "ok.txt"), []byte("hello"), 0o644))
	d, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	must(t, os.WriteFile(filepath.Join(root, ReservedDir, "trash", "t.txt"), []byte(canary), 0o644))
	must(t, os.Symlink("../outside/outside.txt", filepath.Join(root, "rel-out")))
	must(t, os.Symlink(filepath.Join(base, "outside", "outside.txt"), filepath.Join(root, "abs-out")))
	must(t, os.Symlink("../outside", filepath.Join(root, "dir-out")))
	must(t, os.Symlink(ReservedDir+"/trash", filepath.Join(root, "alias-trash")))
	must(t, os.Symlink("../sibling.txt", filepath.Join(root, "shared", "sideways")))
	must(t, syscall.Mkfifo(filepath.Join(root, "fifo"), 0o644))
	return d, root
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestSymlinkEscape(t *testing.T) {
	d, _ := plant(t)
	for raw, want := range map[string]error{
		"rel-out":             ErrSymlink,
		"abs-out":             ErrSymlink,
		"dir-out/outside.txt": ErrSymlink,
		"alias-trash/t.txt":   ErrSymlink,
		"shared/sideways":     ErrSymlink,
		"fifo":                ErrNotRegular,
		"shared":              ErrNotRegular,
		"missing":             ErrNotFound,
		"sibling.txt/x":       ErrNotFound,
	} {
		f, err := d.Files.Open(mustPath(t, raw))
		if err == nil {
			f.Close()
		}
		if !errors.Is(err, want) {
			t.Errorf("Open(%q) = %v, want %v", raw, err, want)
		}
	}
	for _, raw := range []string{"../outside/outside.txt", ".storage-server/trash/t.txt", ".STORAGE-SERVER/trash"} {
		if _, err := ParsePath(raw); err == nil {
			t.Errorf("ParsePath(%q) accepted", raw)
		}
	}
	f, err := d.Files.Open(mustPath(t, "shared/ok.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if body, _ := io.ReadAll(f); string(body) != "hello" || f.Info.Size != 5 || f.Info.Name != "ok.txt" {
		t.Errorf("body = %q, info = %+v", body, f.Info)
	}
}

func TestSubConfinesAShare(t *testing.T) {
	d, root := plant(t)
	sub, err := d.Files.Sub(mustPath(t, "shared"))
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	if _, err := sub.Open(mustPath(t, "sideways")); !errors.Is(err, ErrSymlink) {
		t.Errorf("sideways = %v", err)
	}
	must(t, os.Rename(filepath.Join(root, "shared"), filepath.Join(root, "renamed")))
	f, err := sub.Open(mustPath(t, "ok.txt"))
	if err != nil {
		t.Fatalf("a Sub tree must follow its folder across a rename: %v", err)
	}
	f.Close()
}

func TestFIFOReturnsAtOnce(t *testing.T) {
	d, _ := plant(t)
	done := make(chan error, 1)
	go func() {
		_, err := d.Files.Open(mustPath(t, "fifo"))
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, ErrNotRegular) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("opening a FIFO blocked")
	}
}

func TestListShowsLeavesAndHidesTheReservedDir(t *testing.T) {
	d, _ := plant(t)
	entries, err := d.Files.List(Path{})
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]Kind{}
	for _, e := range entries {
		kinds[e.Name] = e.Kind
	}
	want := map[string]Kind{
		"abs-out": KindSymlink, "alias-trash": KindSymlink, "dir-out": KindSymlink, "fifo": KindOther,
		"rel-out": KindSymlink, "shared": KindDir, "sibling.txt": KindFile,
	}
	if len(kinds) != len(want) {
		t.Fatalf("listed %v", kinds)
	}
	for name, kind := range want {
		if got, ok := kinds[name]; !ok || got != kind {
			t.Errorf("%s = %v, want %v", name, got, kind)
		}
	}
	if _, err := d.Files.List(mustPath(t, "sibling.txt")); !errors.Is(err, ErrNotDirectory) {
		t.Errorf("List(file) = %v", err)
	}
	if _, err := d.Files.List(mustPath(t, "dir-out")); !errors.Is(err, ErrSymlink) {
		t.Errorf("List(symlink) = %v", err)
	}
}

func TestWalkNeverEntersALink(t *testing.T) {
	d, root := plant(t)
	must(t, os.Symlink("..", filepath.Join(root, "shared", "cycle")))
	var seen []string
	err := d.Files.Walk(context.Background(), Path{}, func(p Path, _ Info) error {
		seen = append(seen, p.String())
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(seen, " ")
	want := "abs-out alias-trash dir-out fifo rel-out shared shared/cycle shared/ok.txt shared/sideways sibling.txt"
	if got != want {
		t.Errorf("walked %q\nwant   %q", got, want)
	}
}

func TestMkdirRefusesSymlinkAndFile(t *testing.T) {
	d, root := plant(t)
	if err := d.Files.Mkdir(mustPath(t, "dir-out/new")); !errors.Is(err, ErrSymlink) {
		t.Errorf("through symlink = %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "outside", "new")); !os.IsNotExist(err) {
		t.Error("Mkdir wrote outside the root")
	}
	if err := d.Files.Mkdir(mustPath(t, "sibling.txt/x")); !errors.Is(err, ErrExists) {
		t.Errorf("through file = %v", err)
	}
	must(t, d.Files.Mkdir(mustPath(t, "new/deep/er")))
	must(t, d.Files.Mkdir(mustPath(t, "new/deep/er")))
	if st, err := os.Stat(filepath.Join(root, "new/deep/er")); err != nil || !st.IsDir() {
		t.Errorf("stat = %v", err)
	}
}

func TestMoveNeverReplaces(t *testing.T) {
	d, root := plant(t)
	from, _ := mustPath(t, "shared/ok.txt").Entry()
	to, _ := mustPath(t, "sibling.txt").Entry()
	renamed, err := Move(d.Files, from, d.Files, to)
	if renamed || !errors.Is(err, ErrExists) {
		t.Fatalf("Move = %v, %v", renamed, err)
	}
	if body, _ := os.ReadFile(filepath.Join(root, "sibling.txt")); string(body) != canary {
		t.Fatal("Move replaced the destination")
	}
	to, _ = mustPath(t, "shared/moved.txt").Entry()
	renamed, err = Move(d.Files, from, d.Files, to)
	if !renamed || err != nil {
		t.Fatalf("Move = %v, %v", renamed, err)
	}
	if body, _ := os.ReadFile(filepath.Join(root, "shared/moved.txt")); string(body) != "hello" {
		t.Fatalf("moved body = %q", body)
	}
	missing, _ := mustPath(t, "gone").Entry()
	if renamed, err := Move(d.Files, missing, d.Files, to); renamed || !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing source = %v, %v", renamed, err)
	}
	via, _ := mustPath(t, "dir-out/x").Entry()
	if renamed, err := Move(d.Files, to, d.Files, via); renamed || !errors.Is(err, ErrSymlink) {
		t.Fatalf("through a symlink = %v, %v", renamed, err)
	}
	link, _ := mustPath(t, "rel-out").Entry()
	dest, _ := mustPath(t, "shared/rel-out").Entry()
	if renamed, err := Move(d.Files, link, d.Files, dest); !renamed || err != nil {
		t.Fatalf("a symlink leaf moves: %v, %v", renamed, err)
	}
	if target, _ := os.Readlink(filepath.Join(root, "shared/rel-out")); target != "../outside/outside.txt" {
		t.Fatalf("moved link = %q", target)
	}
}

func TestRemoveAllDoesNotFollowSymlinks(t *testing.T) {
	d, root := plant(t)
	must(t, os.MkdirAll(filepath.Join(root, "doomed/sub"), 0o755))
	must(t, os.Symlink("../../outside", filepath.Join(root, "doomed/sub/link")))
	must(t, d.Files.RemoveAll(mustPath(t, "doomed")))
	must(t, d.Files.RemoveAll(mustPath(t, "doomed")))
	if body, err := os.ReadFile(filepath.Join(filepath.Dir(root), "outside/outside.txt")); err != nil || string(body) != canary {
		t.Fatalf("RemoveAll reached through a link: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "doomed")); !os.IsNotExist(err) {
		t.Fatal("doomed survived")
	}
}

func TestWriteDurableReplacesAndReadSmallBounds(t *testing.T) {
	d, _ := plant(t)
	p := mustPath(t, "rec.json")
	must(t, d.Spool.WriteDurable(p, []byte("one")))
	must(t, d.Spool.WriteDurable(p, []byte("two")))
	if got, err := d.Spool.ReadSmall(p); err != nil || string(got) != "two" {
		t.Fatalf("ReadSmall = %q, %v", got, err)
	}
	must(t, d.Spool.WriteDurable(p, make([]byte, smallFileLimit+1)))
	if _, err := d.Spool.ReadSmall(p); err == nil {
		t.Fatal("ReadSmall accepted an oversized record")
	}
}

func TestOpenRefusesAReservedDirSymlink(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	must(t, os.MkdirAll(root, 0o755))
	must(t, os.MkdirAll(filepath.Join(base, "elsewhere"), 0o755))
	must(t, os.Symlink("../elsewhere", filepath.Join(root, ReservedDir)))
	if d, err := Open(root); err == nil {
		d.Close()
		t.Fatal("Open accepted a symlink as the reserved directory")
	} else if !errors.Is(err, ErrSymlink) {
		t.Fatalf("got %v", err)
	}
}

func TestOpenLeavesNoProbeBehind(t *testing.T) {
	_, root := plant(t)
	entries, err := os.ReadDir(filepath.Join(root, ReservedDir))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if got := strings.Join(names, " "); got != "spool trash" {
		t.Fatalf("reserved dir holds %q", got)
	}
}

func TestSwapRaceCannotEscape(t *testing.T) {
	d, root := plant(t)
	swap := filepath.Join(root, "swap")
	real := filepath.Join(root, "swap.real")
	link := filepath.Join(root, "swap.link")
	must(t, os.MkdirAll(real, 0o755))
	must(t, os.WriteFile(filepath.Join(real, "f.txt"), []byte("inside"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "..", "outside", "f.txt"), []byte(canary), 0o644))
	must(t, os.Symlink("../outside", link))
	must(t, os.Rename(real, swap))

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		dirSide := true
		for {
			select {
			case <-stop:
				return
			default:
			}
			if dirSide {
				_ = os.Rename(swap, real)
				_ = os.Rename(link, swap)
			} else {
				_ = os.Rename(swap, link)
				_ = os.Rename(real, swap)
			}
			dirSide = !dirSide
		}
	})
	p := mustPath(t, "swap/f.txt")
	var ok, escaped atomic.Int64
	deadline := time.Now().Add(500 * time.Millisecond)
	var readers sync.WaitGroup
	for range 8 {
		readers.Go(func() {
			for time.Now().Before(deadline) {
				f, err := d.Files.Open(p)
				if err != nil {
					continue
				}
				body, _ := io.ReadAll(f)
				f.Close()
				if string(body) == canary {
					escaped.Add(1)
				} else {
					ok.Add(1)
				}
			}
		})
	}
	readers.Wait()
	close(stop)
	wg.Wait()
	if escaped.Load() != 0 {
		t.Fatalf("%d opens read outside the root", escaped.Load())
	}
	t.Logf("ok=%d escaped=0", ok.Load())
}

func TestUploadModesWithPrivateUmask(t *testing.T) {
	d, root := plant(t)
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	dir, _ := ParsePath("host-readable")
	must(t, d.Files.Mkdir(dir))
	p, _ := ParsePath("upload")
	f, err := d.Spool.OpenAppend(p)
	must(t, err)
	_, err = f.Write([]byte("host bytes"))
	must(t, err)
	must(t, f.Close())
	st, err := os.Stat(filepath.Join(root, ReservedDir, "spool", "upload"))
	must(t, err)
	if st.Mode().Perm() != 0o644 {
		t.Fatalf("upload mode = %o, want 644", st.Mode().Perm())
	}
	st, err = os.Stat(filepath.Join(root, "host-readable"))
	must(t, err)
	if st.Mode().Perm() != 0o755 {
		t.Fatalf("folder mode = %o, want 755", st.Mode().Perm())
	}
}
