package disk

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ReservedDir holds the trash and the upload spool. It lives inside the storage
// root because both must be on the root's filesystem for rename to be atomic.
const ReservedDir = ".storage-server"

const maxNameBytes = 255

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
	// ErrNotDurable means the rename happened and a parent fsync failed. The
	// caller must treat the move as neither failed nor committed.
	ErrNotDurable = errors.New("rename not durable")
)

// Name is one validated path component: valid UTF-8, 1 to 255 bytes, no slash,
// no control character, not "." or "..".
type Name struct{ s string }

func ParseName(raw string) (Name, error) {
	if raw == "" || raw == "." || raw == ".." || len(raw) > maxNameBytes || !utf8.ValidString(raw) {
		return Name{}, ErrInvalidPath
	}
	for _, r := range raw {
		if r == '/' || unicode.IsControl(r) {
			return Name{}, ErrInvalidPath
		}
	}
	return Name{raw}, nil
}

func (n Name) String() string { return n.s }

// Path is a validated, slash-separated path relative to a Tree. The zero value
// is the tree's root. No Path can contain "..", an absolute prefix, or a first
// segment that case-folds to ReservedDir.
type Path struct{ s string }

// ParsePath is the only way to build a Path from untrusted input. It rejects
// rather than cleans: "a/../b" is an error, not "b".
func ParsePath(raw string) (Path, error) {
	if raw == "" {
		return Path{}, nil
	}
	segments := strings.Split(raw, "/")
	for _, s := range segments {
		if _, err := ParseName(s); err != nil {
			return Path{}, err
		}
	}
	if isReserved(segments[0]) {
		return Path{}, ErrReserved
	}
	return Path{raw}, nil
}

func isReserved(name string) bool { return strings.EqualFold(name, ReservedDir) }

func (p Path) String() string { return p.s }
func (p Path) IsRoot() bool   { return p.s == "" }

func (p Path) Join(n Name) Path {
	if p.IsRoot() {
		return Path{n.s}
	}
	return Path{p.s + "/" + n.s}
}

func (p Path) Under(q Path) Path {
	switch {
	case q.IsRoot():
		return p
	case p.IsRoot():
		return q
	}
	return Path{p.s + "/" + q.s}
}

// Child is Join for a name that came from outside the tree: a rename, a move to
// the root, or an upload. It refuses a name the reserved rule forbids at the root.
func (p Path) Child(n Name) (Entry, error) {
	if p.IsRoot() && isReserved(n.s) {
		return Entry{}, ErrReserved
	}
	return Entry{Dir: p, Name: n}, nil
}

// Entry is a Path that has a parent, so it can be renamed, moved or trashed.
// The storage root has no Entry, which makes "trash the root" uncompilable.
type Entry struct {
	Dir  Path
	Name Name
}

// Entry splits p. ok is false only for the root.
func (p Path) Entry() (e Entry, ok bool) {
	if p.IsRoot() {
		return Entry{}, false
	}
	i := strings.LastIndexByte(p.s, '/')
	if i < 0 {
		return Entry{Name: Name{p.s}}, true
	}
	return Entry{Dir: Path{p.s[:i]}, Name: Name{p.s[i+1:]}}, true
}

func (e Entry) Path() Path { return e.Dir.Join(e.Name) }

// Contains reports whether q equals p or lies under it. Moving a folder into
// itself is refused with this before any disk or database work.
func (p Path) Contains(q Path) bool {
	return p.IsRoot() || q.s == p.s || strings.HasPrefix(q.s, p.s+"/")
}

type TrashID string

type Location struct {
	trash TrashID
	rel   Path
}

func Live(p Path) Location                  { return Location{rel: p} }
func InTrash(id TrashID, rel Path) Location { return Location{trash: id, rel: rel} }

// LivePath returns the path when the location is outside the trash.
func (l Location) LivePath() (Path, bool) { return l.rel, l.trash == "" }

// Trashed returns the item and the path inside it when the location is in the trash.
func (l Location) Trashed() (TrashID, Path, bool) { return l.trash, l.rel, l.trash != "" }

// String is the canonical stored form: "live:a/b" or "trash:<id>/b". The prefix
// rewrite in the store depends on a child's form extending its parent's with "/".
func (l Location) String() string {
	if l.trash == "" {
		return "live:" + l.rel.s
	}
	if l.rel.IsRoot() {
		return "trash:" + string(l.trash)
	}
	return "trash:" + string(l.trash) + "/" + l.rel.s
}

// ParseLocation reads the stored form back.
func ParseLocation(s string) (Location, error) {
	if rest, ok := strings.CutPrefix(s, "live:"); ok {
		p, err := ParsePath(rest)
		if err != nil {
			return Location{}, fmt.Errorf("location %q: %w", s, err)
		}
		return Live(p), nil
	}
	if rest, ok := strings.CutPrefix(s, "trash:"); ok {
		id, rel, _ := strings.Cut(rest, "/")
		p, err := ParsePath(rel)
		if id == "" || err != nil {
			return Location{}, fmt.Errorf("location %q: %w", s, ErrInvalidPath)
		}
		return InTrash(TrashID(id), p), nil
	}
	return Location{}, fmt.Errorf("location %q: %w", s, ErrInvalidPath)
}

func Candidates(n Name) func(yield func(Name) bool) {
	return func(yield func(Name) bool) {
		if !yield(n) {
			return
		}
		stem, ext := splitExt(n.s)
		for i := 1; ; i++ {
			suffix := " (" + strconv.Itoa(i) + ")"
			keep := min(len(stem), maxNameBytes-len(suffix)-len(ext))
			for keep > 0 && keep < len(stem) && !utf8.RuneStart(stem[keep]) {
				keep--
			}
			c, err := ParseName(stem[:keep] + suffix + ext)
			if err != nil || !yield(c) {
				return
			}
		}
	}
}

func splitExt(name string) (stem, ext string) {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 {
		return name, ""
	}
	return name[:i], name[i:]
}
