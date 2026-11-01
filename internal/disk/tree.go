package disk

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"storage-server/internal/crash"
)

// Kind classifies a directory entry. Only File and Dir can be opened or walked.
// Symlink and Other (fifo, socket, device, or a name that is not valid UTF-8)
// are listed so the owner can see, move or trash them, and are never followed.
type Kind int

const (
	KindFile Kind = iota
	KindDir
	KindSymlink
	KindOther
)

var kindNames = [...]string{KindFile: "file", KindDir: "dir", KindSymlink: "symlink", KindOther: "other"}

func (k Kind) String() string { return kindNames[k] }

func (k Kind) MarshalText() ([]byte, error) { return []byte(k.String()), nil }

func (k *Kind) UnmarshalText(b []byte) error {
	i := slices.Index(kindNames[:], string(b))
	if i < 0 {
		return fmt.Errorf("unknown kind %q", b)
	}
	*k = Kind(i)
	return nil
}

type Info struct {
	Name    string
	Kind    Kind
	Size    int64
	ModTime time.Time
	Inode   uint64
	Dev     uint64
	// Denied marks a directory Walk could not enter, so a caller can choose
	// between skipping it and failing.
	Denied bool
}

const resolveBeneath = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS

// openat2 retries EAGAIN because RESOLVE_BENEATH may return it when a rename
// races the walk.
func openat2(dir int, path string, flags int, mode uint32) (int, error) {
	how := unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC), Resolve: resolveBeneath}
	if flags&unix.O_CREAT != 0 {
		how.Mode = uint64(mode)
	}
	for tries := 0; ; tries++ {
		fd, err := unix.Openat2(dir, path, &how)
		if err == unix.EINTR || (err == unix.EAGAIN && tries < 64) {
			continue
		}
		return fd, err
	}
}

func translate(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, unix.ENOENT):
		return ErrNotFound
	case errors.Is(err, unix.EEXIST), errors.Is(err, unix.ENOTEMPTY):
		return ErrExists
	case errors.Is(err, unix.ELOOP):
		return ErrSymlink
	case errors.Is(err, unix.ENOTDIR):
		return ErrNotDirectory
	case errors.Is(err, unix.EXDEV):
		return ErrCrossDevice
	case errors.Is(err, unix.ENOSPC), errors.Is(err, unix.EDQUOT):
		return ErrNoSpace
	case errors.Is(err, unix.ENAMETOOLONG):
		return ErrInvalidPath
	}
	return err
}

// Tree is a directory file descriptor. Every method resolves relative to that
// descriptor, so a Tree keeps pointing at its folder across a rename.
type Tree struct {
	fd   int
	root bool
}

func relative(p Path) string {
	if p.IsRoot() {
		return "."
	}
	return p.s
}

func (t *Tree) openDir(p Path) (int, error) {
	fd, err := openat2(t.fd, relative(p), unix.O_RDONLY|unix.O_DIRECTORY, 0)
	return fd, translate(err)
}

func (t *Tree) openParent(dir Path) (int, error) {
	fd, err := t.openDir(dir)
	if errors.Is(err, ErrNotDirectory) {
		return -1, ErrNotFound
	}
	return fd, err
}

// Sub narrows to a folder. A guest's whole view of a shared folder is one Sub
// Tree, so owner and guest handlers are the same code on different Trees.
// The caller closes it.
func (t *Tree) Sub(p Path) (*Tree, error) {
	fd, err := t.openDir(p)
	if err != nil {
		return nil, err
	}
	return &Tree{fd: fd, root: t.root && p.IsRoot()}, nil
}

func (t *Tree) Close() error { return unix.Close(t.fd) }

func infoOf(name string, st *unix.Stat_t) Info {
	info := Info{Name: name, ModTime: time.Unix(st.Mtim.Unix()), Inode: st.Ino, Dev: st.Dev}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFREG:
		info.Kind, info.Size = KindFile, st.Size
	case unix.S_IFDIR:
		info.Kind = KindDir
	case unix.S_IFLNK:
		info.Kind = KindSymlink
	default:
		info.Kind = KindOther
	}
	if _, err := ParseName(name); err != nil && name != "" {
		info.Kind = KindOther
	}
	return info
}

// Stat does not follow a final symlink: it reports KindSymlink.
func (t *Tree) Stat(p Path) (Info, error) {
	e, ok := p.Entry()
	if !ok {
		var st unix.Stat_t
		if err := unix.Fstat(t.fd, &st); err != nil {
			return Info{}, err
		}
		return infoOf("", &st), nil
	}
	dir, err := t.openParent(e.Dir)
	if err != nil {
		return Info{}, err
	}
	defer unix.Close(dir)
	return lstatAt(dir, e.Name.s)
}

func lstatAt(dir int, name string) (Info, error) {
	var st unix.Stat_t
	if err := unix.Fstatat(dir, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return Info{}, translate(err)
	}
	return infoOf(name, &st), nil
}

func readNames(fd int) ([]string, error) {
	var names []string
	buf := make([]byte, 64<<10)
	for {
		n, err := unix.Getdents(fd, buf)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return nil, translate(err)
		}
		if n == 0 {
			slices.Sort(names)
			return names, nil
		}
		_, _, names = unix.ParseDirent(buf[:n], -1, names)
	}
}

// List returns one directory, hiding ReservedDir at the storage root.
func (t *Tree) List(p Path) ([]Info, error) {
	fd, err := t.openDir(p)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	names, err := readNames(fd)
	if err != nil {
		return nil, err
	}
	entries := make([]Info, 0, len(names))
	for _, name := range names {
		if t.root && p.IsRoot() && isReserved(name) {
			continue
		}
		info, err := lstatAt(fd, name)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		entries = append(entries, info)
	}
	return entries, nil
}

// Walk visits entries below start depth first using openat(parent, name,
// O_NOFOLLOW), so a symlink cycle cannot exist. It stops when ctx ends or visit
// returns an error. A name no Path can hold is skipped.
func (t *Tree) Walk(ctx context.Context, start Path, visit func(Path, Info) error) error {
	fd, err := t.openDir(start)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	return walk(ctx, fd, start, t.root && start.IsRoot(), visit)
}

func walk(ctx context.Context, fd int, dir Path, hideReserved bool, visit func(Path, Info) error) error {
	names, err := readNames(fd)
	if err != nil {
		return err
	}
	for _, raw := range names {
		if err := ctx.Err(); err != nil {
			return err
		}
		if hideReserved && isReserved(raw) {
			continue
		}
		name, err := ParseName(raw)
		if err != nil {
			continue
		}
		info, err := lstatAt(fd, raw)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		p := dir.Join(name)
		if err := visit(p, info); err != nil {
			return err
		}
		if info.Kind != KindDir {
			continue
		}
		child, err := openat2(fd, raw, unix.O_RDONLY|unix.O_DIRECTORY, 0)
		switch {
		case err == nil:
		case errors.Is(err, unix.EACCES):
			info.Denied = true
			if err := visit(p, info); err != nil {
				return err
			}
			continue
		case errors.Is(err, unix.ENOENT), errors.Is(err, unix.ELOOP), errors.Is(err, unix.ENOTDIR):
			continue
		default:
			return err
		}
		err = walk(ctx, child, p, false, visit)
		unix.Close(child)
		if err != nil {
			return err
		}
	}
	return nil
}

// File is an opened regular file. Open uses O_NONBLOCK and fstat so a planted
// FIFO returns ErrNotRegular at once instead of pinning the request.
type File struct {
	*os.File
	Info Info
}

func (t *Tree) Open(p Path) (*File, error) {
	e, ok := p.Entry()
	if !ok {
		return nil, ErrNotRegular
	}
	fd, err := openat2(t.fd, p.s, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOCTTY, 0)
	if err != nil {
		if errors.Is(err, unix.ENOTDIR) {
			return nil, ErrNotFound
		}
		return nil, translate(err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, err
	}
	info := infoOf(e.Name.s, &st)
	if info.Kind != KindFile {
		unix.Close(fd)
		return nil, ErrNotRegular
	}
	return &File{File: os.NewFile(uintptr(fd), e.Name.s), Info: info}, nil
}

// Mkdir creates p and missing parents. It is idempotent and refuses a symlink
// at any component. A file holding a component's name is ErrExists.
func (t *Tree) Mkdir(p Path) error {
	fd, err := t.openDir(Path{})
	if err != nil {
		return err
	}
	if p.IsRoot() {
		return unix.Close(fd)
	}
	for _, seg := range strings.Split(p.s, "/") {
		created := true
		if err := unix.Mkdirat(fd, seg, 0o755); err != nil {
			if !errors.Is(err, unix.EEXIST) {
				unix.Close(fd)
				return translate(err)
			}
			created = false
		}
		next, err := openat2(fd, seg, unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if err == nil && created {
			err = unix.Fsync(fd)
		}
		unix.Close(fd)
		if err != nil {
			if errors.Is(err, unix.ENOTDIR) {
				return ErrExists
			}
			return translate(err)
		}
		fd = next
	}
	return unix.Close(fd)
}

// Appender writes to the end of a spool file. Sync must return before an
// acknowledged offset is reported to the client.
type Appender interface {
	io.Writer
	Sync() error
	Close() error
}

func (t *Tree) OpenAppend(p Path) (Appender, error) {
	e, ok := p.Entry()
	if !ok {
		return nil, ErrNotRegular
	}
	dir, err := t.openParent(e.Dir)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	fd, err := openat2(dir, e.Name.s, unix.O_WRONLY|unix.O_CREAT|unix.O_APPEND, 0o644)
	if err != nil {
		return nil, translate(err)
	}
	if err := unix.Fsync(dir); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), e.Name.s), nil
}

// WriteDurable writes a small file through a temp name, fsyncs it and its
// directory, then renames over p.
func (t *Tree) WriteDurable(p Path, data []byte) error {
	e, ok := p.Entry()
	if !ok {
		return ErrNotRegular
	}
	dir, err := t.openParent(e.Dir)
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	tmp := "." + e.Name.s + ".tmp"
	fd, err := openat2(dir, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_TRUNC, 0o644)
	if err != nil {
		return translate(err)
	}
	f := os.NewFile(uintptr(fd), tmp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		unix.Unlinkat(dir, tmp, 0)
		return translate(err)
	}
	if err := unix.Renameat(dir, tmp, dir, e.Name.s); err != nil {
		return translate(err)
	}
	return unix.Fsync(dir)
}

const smallFileLimit = 64 << 10

// ReadSmall reads a file of at most 64 KiB, the size bound of every record the
// server writes for itself.
func (t *Tree) ReadSmall(p Path) ([]byte, error) {
	f, err := t.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, smallFileLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > smallFileLimit {
		return nil, fmt.Errorf("%s is over %d bytes", p, smallFileLimit)
	}
	return data, nil
}

// Remove deletes one name and fsyncs its directory.
func (t *Tree) Remove(p Path) error {
	e, ok := p.Entry()
	if !ok {
		return ErrInvalidPath
	}
	dir, err := t.openParent(e.Dir)
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	err = unix.Unlinkat(dir, e.Name.s, 0)
	if errors.Is(err, unix.EISDIR) || errors.Is(err, unix.EPERM) {
		err = unix.Unlinkat(dir, e.Name.s, unix.AT_REMOVEDIR)
	}
	if err != nil {
		return translate(err)
	}
	return unix.Fsync(dir)
}

// RemoveAll deletes a subtree without following symlinks. A missing name is success.
func (t *Tree) RemoveAll(p Path) error {
	e, ok := p.Entry()
	if !ok {
		return ErrInvalidPath
	}
	dir, err := t.openParent(e.Dir)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	if err := removeAt(dir, e.Name.s); err != nil {
		return err
	}
	return unix.Fsync(dir)
}

func removeAt(parent int, name string) error {
	err := unix.Unlinkat(parent, name, 0)
	if err == nil || errors.Is(err, unix.ENOENT) {
		return nil
	}
	if !errors.Is(err, unix.EISDIR) && !errors.Is(err, unix.EPERM) {
		return translate(err)
	}
	fd, err := openat2(parent, name, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return translate(err)
	}
	defer unix.Close(fd)
	names, err := readNames(fd)
	if err != nil {
		return err
	}
	for _, child := range names {
		if err := removeAt(fd, child); err != nil {
			return err
		}
	}
	if err := unix.Unlinkat(parent, name, unix.AT_REMOVEDIR); err != nil && !errors.Is(err, unix.ENOENT) {
		return translate(err)
	}
	return nil
}

// Sync fsyncs a directory, so a crash recovery can retry a move's durability.
func (t *Tree) Sync(dir Path) error {
	fd, err := t.openParent(dir)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	return unix.Fsync(fd)
}

// Move is the commit primitive: renameat2(RENAME_NOREPLACE), then fsync of both
// parents. It returns ErrExists instead of replacing, and ErrCrossDevice when a
// nested mount or btrfs subvolume separates the two names. renamed is true when
// the namespace changed, including when a parent fsync then failed, which comes
// back as ErrNotDurable.
func Move(src *Tree, from Entry, dst *Tree, to Entry) (renamed bool, err error) {
	sp, err := src.openParent(from.Dir)
	if err != nil {
		return false, err
	}
	defer unix.Close(sp)
	dp, err := dst.openParent(to.Dir)
	if err != nil {
		return false, err
	}
	defer unix.Close(dp)
	if err := unix.Renameat2(sp, from.Name.s, dp, to.Name.s, unix.RENAME_NOREPLACE); err != nil {
		return false, translate(err)
	}
	err = crash.Fail(crash.ParentFsync)
	if err == nil {
		err = unix.Fsync(sp)
	}
	if err == nil {
		err = unix.Fsync(dp)
	}
	if err != nil {
		return true, fmt.Errorf("%w: %w", ErrNotDurable, err)
	}
	return true, nil
}
