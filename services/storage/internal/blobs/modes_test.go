package blobs

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// setUmask sets the process umask for one test and restores it afterwards.
// The umask is process-wide, so tests that call it must not run in parallel.
func setUmask(t *testing.T, mask int) {
	old := syscall.Umask(mask)
	t.Cleanup(func() { syscall.Umask(old) })
}

func wantMode(t *testing.T, p string, want fs.FileMode) {
	t.Helper()
	info, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Errorf("%s: mode %#o, want %#o", p, got, want)
	}
}

// Everything the app writes under the data dir is readable by its group (the
// host owner's group), whatever umask the process inherited.
func TestNewDataIsGroupReadable(t *testing.T) {
	for _, mask := range []int{0o022, 0o077} {
		t.Run(fmt.Sprintf("umask %03o", mask), func(t *testing.T) {
			setUmask(t, mask)
			root := filepath.Join(t.TempDir(), "data")
			d, err := Open(root)
			if err != nil {
				t.Fatal(err)
			}
			for _, sub := range []string{"blobs", "quarantine", "uploads", "thumbs", "previews", "tmp"} {
				wantMode(t, filepath.Join(root, sub), 0o750)
			}

			session := "00000000-0000-0000-0000-000000000001"
			if _, _, err := d.AppendChunk(session, 0, nil, bytes.NewReader([]byte("hello")), 5); err != nil {
				t.Fatal(err)
			}
			wantMode(t, must(d.UploadPath(session)), 0o640)

			id := "ab" + strings.Repeat("0", 30)
			if err := d.Commit(session, id); err != nil {
				t.Fatal(err)
			}
			blob := must(d.Path(id))
			wantMode(t, filepath.Dir(blob), 0o750)
			wantMode(t, blob, 0o640)

			// A zero-byte upload has no scratch file until Commit makes one.
			empty := "cd" + strings.Repeat("0", 30)
			if err := d.Commit("00000000-0000-0000-0000-000000000002", empty); err != nil {
				t.Fatal(err)
			}
			wantMode(t, filepath.Dir(must(d.Path(empty))), 0o750)
			wantMode(t, must(d.Path(empty)), 0o640)

			if err := d.Quarantine(id); err != nil {
				t.Fatal(err)
			}
			wantMode(t, filepath.Join(root, "quarantine", id), 0o640)
			// Unquarantine recreates the prefix directory.
			if err := os.Remove(filepath.Dir(blob)); err != nil {
				t.Fatal(err)
			}
			if err := d.Unquarantine(id); err != nil {
				t.Fatal(err)
			}
			wantMode(t, filepath.Dir(blob), 0o750)
			wantMode(t, blob, 0o640)

			thumb := must(d.ThumbPath(id, 256))
			if err := d.WriteAtomic(thumb, func(w io.Writer) error { _, err := w.Write([]byte("jpeg")); return err }); err != nil {
				t.Fatal(err)
			}
			wantMode(t, thumb, 0o640)

			f, err := d.TempFile()
			if err != nil {
				t.Fatal(err)
			}
			f.Close()
			wantMode(t, f.Name(), 0o640)
		})
	}
}

// Data written by older versions (0700 directories, 0600 files, maybe another
// group) is fixed once at startup; a second run changes nothing.
func TestFixModes(t *testing.T) {
	setUmask(t, 0o077)
	root := t.TempDir()
	d, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	id := "ab" + strings.Repeat("1", 30)
	blob := must(d.Path(id))
	if err := os.Mkdir(filepath.Dir(blob), 0o700); err != nil {
		t.Fatal(err)
	}
	quarantined := filepath.Join(root, "quarantine", "cd"+strings.Repeat("2", 30))
	for _, p := range []string{blob, quarantined} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(filepath.Join(root, "uploads"), 0o700); err != nil {
		t.Fatal(err)
	}
	// A file in another of our groups moves to the primary group.
	gid := os.Getgid()
	other := -1
	if groups, err := os.Getgroups(); err == nil {
		for _, g := range groups {
			if g != gid {
				other = g
				break
			}
		}
	}
	if other >= 0 {
		if err := os.Chown(blob, -1, other); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Log("no supplementary group: the group change is not exercised")
	}
	// Symlinks are skipped: the file it points to keeps its mode.
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "tmp", "link")); err != nil {
		t.Fatal(err)
	}

	var warnings []string
	warn := func(p string, err error) { warnings = append(warnings, p+": "+err.Error()) }
	r := d.FixModes(warn)
	// 6 layout dirs + blobs/ab + 2 files; changed: blobs/ab, the blob, the quarantined file, uploads.
	if r.Checked != 9 || r.Changed != 4 || r.Failed != 0 || len(warnings) != 0 {
		t.Fatalf("first run: %+v, warnings %v", r, warnings)
	}
	wantMode(t, filepath.Dir(blob), 0o750)
	wantMode(t, blob, 0o640)
	wantMode(t, quarantined, 0o640)
	wantMode(t, filepath.Join(root, "uploads"), 0o750)
	wantMode(t, outside, 0o600)
	var st syscall.Stat_t
	if err := syscall.Stat(blob, &st); err != nil {
		t.Fatal(err)
	}
	if int(st.Gid) != gid {
		t.Errorf("blob group %d, want %d", st.Gid, gid)
	}

	if r := d.FixModes(warn); r.Checked != 9 || r.Changed != 0 || r.Failed != 0 || len(warnings) != 0 {
		t.Fatalf("second run: %+v, warnings %v", r, warnings)
	}
}
