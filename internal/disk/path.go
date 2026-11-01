// Package disk is the security boundary. It is the only package that issues
// syscalls against the storage root, and every path it resolves goes through
// openat2 with RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS, so the kernel refuses a
// symlink at any component, including one swapped in mid-request.
package disk

import "errors"

// ReservedDir holds the trash and the upload spool. It lives inside the storage
// root because both must be on the root's filesystem for rename to be atomic.
const ReservedDir = ".storage-server"

var (
	ErrInvalidPath  = errors.New("invalid path")
	ErrReserved     = errors.New("reserved name")
	ErrNotFound     = errors.New("not found")
	ErrExists       = errors.New("already exists")
	ErrSymlink      = errors.New("symlink refused")
	ErrNotRegular   = errors.New("not a regular file")
	ErrCrossDevice  = errors.New("crosses a filesystem boundary")
	ErrNoSpace      = errors.New("no space left")
	ErrNotDirectory = errors.New("not a directory")
)

// Name is one validated path component: valid UTF-8, 1 to 255 bytes, no slash,
// no control character, not "." or "..".
type Name struct{ s string }

// ParseName is the only way to build a Name from untrusted input.
func ParseName(raw string) (Name, error) { panic("not implemented") }

func (n Name) String() string { return n.s }

// Path is a validated, slash-separated path relative to a Tree. The zero value
// is the tree's root. No Path can contain "..", an absolute prefix, or a first
// segment that case-folds to ReservedDir.
type Path struct{ s string }

// ParsePath is the only way to build a Path from untrusted input. It rejects
// rather than cleans: "a/../b" is an error, not "b".
func ParsePath(raw string) (Path, error) { panic("not implemented") }

func (p Path) String() string { return p.s }
func (p Path) IsRoot() bool   { return p.s == "" }

// Join appends one validated component.
func (p Path) Join(n Name) Path { panic("not implemented") }

// Entry is a Path that has a parent, so it can be renamed, moved or trashed.
// The storage root has no Entry, which makes "trash the root" uncompilable.
type Entry struct {
	Dir  Path
	Name Name
}

// Entry splits p. ok is false only for the root.
func (p Path) Entry() (e Entry, ok bool) { panic("not implemented") }

func (e Entry) Path() Path { return e.Dir.Join(e.Name) }

// Contains reports whether q equals p or lies under it. Moving a folder into
// itself is refused with this before any disk or database work.
func (p Path) Contains(q Path) bool { panic("not implemented") }

// TrashID names one trash item. It is the item's directory name.
type TrashID string

// Location is where a share's target physically is. A trashed share target is
// not a flag: it is a Location inside the trash, so trash and restore are moves
// and "suspended" is derived rather than stored.
type Location struct {
	trash TrashID
	rel   Path
}

func Live(p Path) Location                  { return Location{rel: p} }
func InTrash(id TrashID, rel Path) Location { return Location{trash: id, rel: rel} }

// LivePath returns the path when the location is outside the trash.
func (l Location) LivePath() (Path, bool) { return l.rel, l.trash == "" }

// String is the canonical stored form: "live:a/b" or "trash:<id>/b". The prefix
// rewrite in the store depends on a child's form extending its parent's with "/".
func (l Location) String() string { panic("not implemented") }

// ParseLocation reads the stored form back.
func ParseLocation(s string) (Location, error) { panic("not implemented") }
