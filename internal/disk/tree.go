package disk

import (
	"context"
	"io"
	"os"
	"time"
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

type Info struct {
	Name    string
	Kind    Kind
	Size    int64
	ModTime time.Time
}

// Disk owns the storage root. Files is what the API can name. Trash and Spool
// are private areas with one owner each: vault owns Trash, upload owns Spool.
type Disk struct {
	Files *Tree
	Trash *Tree
	Spool *Tree
}

// Open creates the reserved layout and fails closed if openat2 is unavailable.
func Open(dir string) (*Disk, error) { panic("not implemented") }

// Usage reports the root filesystem's capacity from fstatfs.
func (d *Disk) Usage() (total, free uint64, err error) { panic("not implemented") }

func (d *Disk) Close() error { panic("not implemented") }

// Tree is a directory file descriptor. Every method resolves relative to that
// descriptor, so a Tree keeps pointing at its folder across a rename.
type Tree struct{ fd int }

// Sub narrows to a folder. A guest's whole view of a shared folder is one Sub
// Tree, so owner and guest handlers are the same code on different Trees.
// The caller closes it.
func (t *Tree) Sub(p Path) (*Tree, error) { panic("not implemented") }

func (t *Tree) Close() error { panic("not implemented") }

// Stat does not follow a final symlink: it reports KindSymlink.
func (t *Tree) Stat(p Path) (Info, error) { panic("not implemented") }

// List returns one directory, hiding ReservedDir at the storage root.
func (t *Tree) List(p Path) ([]Info, error) { panic("not implemented") }

// Walk visits entries depth first using openat(parent, name, O_NOFOLLOW), so a
// symlink cycle cannot exist. It stops when ctx ends or visit returns an error.
func (t *Tree) Walk(ctx context.Context, start Path, visit func(Path, Info) error) error {
	panic("not implemented")
}

// File is an opened regular file. Open uses O_NONBLOCK and fstat so a planted
// FIFO returns ErrNotRegular at once instead of pinning the request.
type File struct {
	*os.File
	Info Info
}

func (t *Tree) Open(p Path) (*File, error) { panic("not implemented") }

// Mkdir creates p and missing parents. It is idempotent and refuses a symlink
// at any component.
func (t *Tree) Mkdir(p Path) error { panic("not implemented") }

// Appender writes to the end of a spool file. Sync must return before an
// acknowledged offset is reported to the client.
type Appender interface {
	io.Writer
	Sync() error
	Close() error
}

func (t *Tree) OpenAppend(p Path) (Appender, error) { panic("not implemented") }

// WriteDurable writes a small file through a temp name, fsyncs it and its
// directory, then renames over p.
func (t *Tree) WriteDurable(p Path, data []byte) error { panic("not implemented") }

// ReadSmall reads a file of at most 64 KiB, the size bound of every record the
// server writes for itself.
func (t *Tree) ReadSmall(p Path) ([]byte, error) { panic("not implemented") }

// Remove deletes one name and fsyncs its directory.
func (t *Tree) Remove(p Path) error { panic("not implemented") }

// RemoveAll deletes a subtree without following symlinks.
func (t *Tree) RemoveAll(p Path) error { panic("not implemented") }

// Move is the commit primitive: renameat2(RENAME_NOREPLACE), then fsync of both
// parents. It returns ErrExists instead of replacing, and ErrCrossDevice when a
// nested mount or btrfs subvolume separates the two names.
func Move(src *Tree, from Entry, dst *Tree, to Entry) error { panic("not implemented") }

// Candidates yields name, then "name (1).ext", "name (2).ext". Upload publish
// and restore both try these against Move until one is free.
func Candidates(n Name) func(yield func(Name) bool) { panic("not implemented") }
