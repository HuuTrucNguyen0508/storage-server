// Package blobs keeps file contents on the storage-data volume. Every path
// is built from a random hex id this package generated; no request value is
// ever part of a path.
package blobs

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var idRE = regexp.MustCompile(`^[0-9a-f]{32}$`)
var sessionRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ErrBadID means an id did not have the shape this package generates.
var ErrBadID = errors.New("bad blob id")

// Dir is the root of the volume layout:
//
//	blobs/<2 hex>/<32 hex>     finished file contents
//	quarantine/<32 hex>        removed blobs, kept until retention ends
//	uploads/<session uuid>     bytes of unfinished uploads
//	thumbs/<blob>-<size>.jpg   cached thumbnails
//	previews/<blob>.pdf        cached Office-to-PDF conversions
//	tmp/                       scratch space for atomic writes
//
// Directories are 0750 and files 0640 whatever the umask: the group is the
// host owner's (the pod's runAsGroup, DATA_GID), so an off-disk backup that
// runs as the owner can read everything.
type Dir struct{ root string }

const (
	dirMode  fs.FileMode = 0o750
	fileMode fs.FileMode = 0o640
)

// Open creates the layout below root if needed.
func Open(root string) (*Dir, error) {
	if err := os.MkdirAll(root, dirMode); err != nil {
		return nil, err
	}
	for _, sub := range []string{"blobs", "quarantine", "uploads", "thumbs", "previews", "tmp"} {
		if err := mkdir(filepath.Join(root, sub)); err != nil {
			return nil, err
		}
	}
	return &Dir{root: root}, nil
}

// mkdir creates directory p with dirMode. An existing p is left as it is;
// FixModes corrects old ones at startup.
func mkdir(p string) error {
	err := os.Mkdir(p, dirMode)
	if errors.Is(err, fs.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return os.Chmod(p, dirMode)
}

// NewID returns a fresh random blob id.
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Path returns where a blob lives.
func (d *Dir) Path(id string) (string, error) {
	if !idRE.MatchString(id) {
		return "", ErrBadID
	}
	return filepath.Join(d.root, "blobs", id[:2], id), nil
}

// Open opens a blob for reading.
func (d *Dir) Open(id string) (*os.File, error) {
	p, err := d.Path(id)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

// UploadPath returns the scratch file of an upload session.
func (d *Dir) UploadPath(session string) (string, error) {
	if !sessionRE.MatchString(session) {
		return "", ErrBadID
	}
	return filepath.Join(d.root, "uploads", session), nil
}

// ThumbPath returns a cached thumbnail's path.
func (d *Dir) ThumbPath(id string, size int) (string, error) {
	if !idRE.MatchString(id) {
		return "", ErrBadID
	}
	return filepath.Join(d.root, "thumbs", fmt.Sprintf("%s-%d.jpg", id, size)), nil
}

// PreviewPath returns a cached Office conversion's path.
func (d *Dir) PreviewPath(id string) (string, error) {
	if !idRE.MatchString(id) {
		return "", ErrBadID
	}
	return filepath.Join(d.root, "previews", id+".pdf"), nil
}

// TempFile creates a scratch file on the same filesystem, for atomic writes.
func (d *Dir) TempFile() (*os.File, error) {
	f, err := os.CreateTemp(filepath.Join(d.root, "tmp"), "w-*")
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(fileMode); err != nil {
		f.Close()
		os.Remove(f.Name())
		return nil, err
	}
	return f, nil
}

// WriteAtomic writes a cache file through a temp file and a rename.
func (d *Dir) WriteAtomic(dst string, write func(w io.Writer) error) error {
	f, err := d.TempFile()
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := write(f); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), dst)
}

// AppendChunk writes the bytes of r at offset into an upload's scratch file.
// Anything past offset (left by an interrupted earlier request) is discarded
// first. At most limit bytes are read; reading more fails with errTooMuch.
// Bytes that did arrive before an error are kept and counted, so the client
// resumes from the returned offset. The returned hash state covers exactly
// the bytes up to the returned offset.
func (d *Dir) AppendChunk(session string, offset int64, state []byte, r io.Reader, limit int64) (int64, []byte, error) {
	p, err := d.UploadPath(session)
	if err != nil {
		return offset, state, err
	}
	h := sha256.New()
	if offset > 0 || len(state) > 0 {
		if err := h.(encoding.BinaryUnmarshaler).UnmarshalBinary(state); err != nil {
			return offset, state, fmt.Errorf("restore upload hash: %w", err)
		}
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE, fileMode)
	if err != nil {
		return offset, state, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return offset, state, err
	}
	if st.Mode().Perm() != fileMode {
		if err := f.Chmod(fileMode); err != nil {
			return offset, state, err
		}
	}
	if st.Size() < offset {
		return offset, state, fmt.Errorf("upload scratch file is shorter (%d) than the recorded offset (%d)", st.Size(), offset)
	}
	if err := f.Truncate(offset); err != nil {
		return offset, state, err
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset, state, err
	}
	n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, limit+1))
	if n > limit {
		// Throw away everything this request wrote.
		f.Truncate(offset) //nolint:errcheck
		return offset, state, ErrTooMuch
	}
	if err := f.Sync(); err != nil {
		return offset, state, err
	}
	newState, err := h.(encoding.BinaryMarshaler).MarshalBinary()
	if err != nil {
		return offset, state, err
	}
	return offset + n, newState, copyErr
}

// ErrTooMuch means a chunk carried more bytes than the upload has left.
var ErrTooMuch = errors.New("chunk is larger than the bytes left in the upload")

// Sum finishes a hash state into a hex SHA-256.
func Sum(state []byte) (string, error) {
	h := sha256.New()
	if len(state) > 0 {
		if err := h.(encoding.BinaryUnmarshaler).UnmarshalBinary(state); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// EmptyHashState is the hash state of zero bytes.
func EmptyHashState() []byte {
	var h hash.Hash = sha256.New()
	b, _ := h.(encoding.BinaryMarshaler).MarshalBinary()
	return b
}

// Commit moves a finished upload into place as a blob.
func (d *Dir) Commit(session, blobID string) error {
	src, err := d.UploadPath(session)
	if err != nil {
		return err
	}
	dst, err := d.Path(blobID)
	if err != nil {
		return err
	}
	if _, err := os.Stat(src); errors.Is(err, fs.ErrNotExist) {
		// A zero-byte upload never wrote a scratch file.
		if err := os.WriteFile(src, nil, fileMode); err != nil {
			return err
		}
		if err := os.Chmod(src, fileMode); err != nil {
			return err
		}
	}
	if err := mkdir(filepath.Dir(dst)); err != nil {
		return err
	}
	return os.Rename(src, dst)
}

// RemoveUpload deletes an upload's scratch file.
func (d *Dir) RemoveUpload(session string) error {
	p, err := d.UploadPath(session)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Remove deletes a blob and its cached thumbnails and preview.
func (d *Dir) Remove(id string) error {
	p, err := d.Path(id)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	d.dropCaches(id)
	return nil
}

// Quarantine moves a blob into quarantine/ instead of deleting it, so a
// database restore that references it again can bring it back. Its mtime is
// set to now: retention counts from the move. Cached thumbnails and the
// preview are dropped.
func (d *Dir) Quarantine(id string) error {
	src, err := d.Path(id)
	if err != nil {
		return err
	}
	dst := filepath.Join(d.root, "quarantine", id)
	// Refresh before moving: an interrupted rename must not expose an old mtime
	// in quarantine. A failed move only delays orphan collection of the source.
	now := time.Now()
	if err := os.Chtimes(src, now, now); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	} else if err := os.Rename(src, dst); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	d.dropCaches(id)
	return nil
}

// Unquarantine moves a quarantined blob back to its place in blobs/.
func (d *Dir) Unquarantine(id string) error {
	dst, err := d.Path(id)
	if err != nil {
		return err
	}
	if err := mkdir(filepath.Dir(dst)); err != nil {
		return err
	}
	return os.Rename(filepath.Join(d.root, "quarantine", id), dst)
}

// Quarantined calls fn for every quarantined blob with the time it was
// quarantined.
func (d *Dir) Quarantined(fn func(id string, since time.Time)) error {
	entries, err := os.ReadDir(filepath.Join(d.root, "quarantine"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.Mode().IsRegular() && idRE.MatchString(e.Name()) {
			fn(e.Name(), info.ModTime())
		}
	}
	return nil
}

// Purge deletes a quarantined blob for good.
func (d *Dir) Purge(id string) error {
	if !idRE.MatchString(id) {
		return ErrBadID
	}
	if err := os.Remove(filepath.Join(d.root, "quarantine", id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (d *Dir) dropCaches(id string) {
	thumbs, _ := filepath.Glob(filepath.Join(d.root, "thumbs", id+"-*"))
	for _, t := range thumbs {
		os.Remove(t)
	}
	os.Remove(filepath.Join(d.root, "previews", id+".pdf"))
	os.Remove(filepath.Join(d.root, "previews", id+".failed"))
}

// Space reports the volume's total and available bytes.
func (d *Dir) Space() (total, avail uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(d.root, &st); err != nil {
		return 0, 0, err
	}
	return st.Blocks * uint64(st.Bsize), st.Bavail * uint64(st.Bsize), nil
}

// Orphans calls fn for blob files and upload scratch files older than
// minAge, so the caller can quarantine or delete the ones the database does
// not know.
func (d *Dir) Orphans(minAge time.Duration, blob func(id string), upload func(session string)) error {
	cutoff := time.Now().Add(-minAge)
	err := filepath.WalkDir(filepath.Join(d.root, "blobs"), func(p string, e fs.DirEntry, err error) error {
		if err != nil || e.IsDir() {
			return nil
		}
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) && idRE.MatchString(e.Name()) {
			blob(e.Name())
		}
		return nil
	})
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(filepath.Join(d.root, "uploads"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) && sessionRE.MatchString(e.Name()) {
			upload(e.Name())
		}
	}
	tmp, _ := os.ReadDir(filepath.Join(d.root, "tmp"))
	for _, e := range tmp {
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) && strings.HasPrefix(e.Name(), "w-") {
			os.Remove(filepath.Join(d.root, "tmp", e.Name()))
		}
	}
	return nil
}

// FixResult counts what FixModes looked at: entries this process owns,
// entries it changed, and entries it failed to read or change.
type FixResult struct{ Checked, Changed, Failed int }

// FixModes walks the data dir once and gives every directory and regular
// file this process owns its primary group and dirMode or fileMode, so data
// written by older versions (0700, 0600, group 65532) becomes readable to the
// host owner's group. Entries that are already right cost one lstat.
// Symlinks, other file types and entries owned by someone else are left
// alone; each failure goes to warn and the walk goes on.
func (d *Dir) FixModes(warn func(path string, err error)) FixResult {
	var r FixResult
	uid, gid := os.Getuid(), os.Getgid()
	fail := func(p string, err error) {
		if !errors.Is(err, fs.ErrNotExist) { // removed while walking
			r.Failed++
			warn(p, err)
		}
	}
	filepath.WalkDir(d.root, func(p string, e fs.DirEntry, err error) error { //nolint:errcheck // the callback never returns an error
		if err != nil {
			fail(p, err)
			return nil
		}
		var want fs.FileMode
		switch {
		case p == d.root:
			return nil
		case e.IsDir():
			want = dirMode
		case e.Type().IsRegular():
			want = fileMode
		default:
			return nil
		}
		info, err := e.Info()
		if err != nil {
			fail(p, err)
			return nil
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(st.Uid) != uid {
			return nil
		}
		r.Checked++
		changed := false
		if int(st.Gid) != gid {
			if err := os.Lchown(p, -1, gid); err != nil {
				fail(p, err)
				return nil
			}
			changed = true
		}
		if info.Mode().Perm() != want {
			if err := os.Chmod(p, want); err != nil {
				fail(p, err)
				return nil
			}
			changed = true
		}
		if changed {
			r.Changed++
		}
		return nil
	})
	return r
}
