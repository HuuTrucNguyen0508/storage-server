package disk

import (
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
)

func TestIdentityRequiresHandle(t *testing.T) {
	known := Identity{Inode: 42, Handle: "generation-1"}
	for _, other := range []Identity{{Inode: 42}, {Inode: 42, Handle: "generation-2"}, {Inode: 43, Handle: "generation-1"}, {}} {
		if known.Matches(other) || other.Matches(known) || (other.Handle == "" && other.Matches(other)) {
			t.Fatalf("untrusted match: %+v", other)
		}
	}
	if !known.Matches(known) {
		t.Fatal("same identity did not match")
	}
}

func TestIdentityAcrossRenameAndReplacement(t *testing.T) {
	d, root := plant(t)
	p, _ := ParsePath("identity.txt")
	q, _ := ParsePath("renamed.txt")
	must(t, os.WriteFile(filepath.Join(root, p.String()), []byte("source"), 0600))
	original, err := d.Files.StatIdentity(p)
	must(t, err)
	must(t, os.Rename(filepath.Join(root, p.String()), filepath.Join(root, q.String())))
	moved, err := d.Files.StatIdentity(q)
	must(t, err)
	if original.Handle != "" && !original.Identity.Matches(moved.Identity) {
		t.Fatal("rename changed identity")
	}
	previous := moved.Identity
	reused := 0
	for range 256 {
		must(t, os.Remove(filepath.Join(root, q.String())))
		must(t, os.WriteFile(filepath.Join(root, q.String()), []byte("replacement"), 0600))
		next, err := d.Files.StatIdentity(q)
		must(t, err)
		if previous.Matches(next.Identity) {
			t.Fatalf("replacement captured identity: %+v", next.Identity)
		}
		if previous.Inode == next.Inode {
			reused++
		}
		previous = next.Identity
	}
	t.Logf("256 replacements, %d immediate inode reuses", reused)
}

func TestMetadataWithoutPersistentHandle(t *testing.T) {
	fd, err := unix.Open("/proc/self/stat", unix.O_PATH|unix.O_CLOEXEC, 0)
	must(t, err)
	defer unix.Close(fd)
	info, err := readIdentityInfo(fd, "stat")
	must(t, err)
	if info.Inode == 0 || info.Handle != "" || info.Identity.Matches(info.Identity) {
		t.Fatalf("unknown identity trusted: %+v", info)
	}
}

func TestMkdirKeepsInheritedSetgid(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o775|os.ModeSetgid); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(root)
	if err != nil || info.Mode()&os.ModeSetgid == 0 {
		t.Skipf("filesystem does not keep setgid here: %v", err)
	}
	d, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	p, err := ParsePath("shared")
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Files.Mkdir(p); err != nil {
		t.Fatal(err)
	}
	made, err := os.Stat(filepath.Join(root, "shared"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := made.Mode()&(os.ModeSetgid|os.ModePerm), os.ModeSetgid|0o755; got != want {
		t.Fatalf("folder mode = %v, want %v", got, want)
	}
}
