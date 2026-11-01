package media

import (
	"archive/zip"
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"storage-server/internal/disk"
)

// WriteZip streams the selection with archive/zip, method Store, through the
// tree's Walk, so symlinks and other kinds are skipped by construction. A
// backslash in an entry name becomes "_" so a Windows extractor cannot read it
// as a separator. An error after the first byte is returned for the caller to
// abort the connection, so a truncated body cannot look like a complete archive.
// The root selects the tree's contents with no leading folder.
func WriteZip(ctx context.Context, w io.Writer, tree *disk.Tree, paths []disk.Path) error {
	buf := bufio.NewWriterSize(w, 64<<10)
	z := zipper{w: zip.NewWriter(buf), tree: tree, taken: map[string]bool{}}
	for _, p := range paths {
		if err := z.add(ctx, p); err != nil {
			return err
		}
	}
	if err := z.w.Close(); err != nil {
		return err
	}
	return buf.Flush()
}

type zipper struct {
	w     *zip.Writer
	tree  *disk.Tree
	taken map[string]bool
}

func (z *zipper) topName(p disk.Path) string {
	e, _ := p.Entry()
	base := entryName(e.Name.String())
	name := base
	for i := 1; z.taken[name]; i++ {
		name = fmt.Sprintf("%s (%d)", base, i)
	}
	z.taken[name] = true
	return name
}

func entryName(s string) string { return strings.ReplaceAll(s, `\`, "_") }

func (z *zipper) add(ctx context.Context, p disk.Path) error {
	info, err := z.tree.Stat(p)
	if err != nil {
		return err
	}
	if p.IsRoot() {
		return z.walk(ctx, p, "")
	}
	switch info.Kind {
	case disk.KindFile:
		return z.file(p, z.topName(p), info)
	case disk.KindDir:
		top := z.topName(p)
		if err := z.dir(top+"/", info); err != nil {
			return err
		}
		return z.walk(ctx, p, top+"/")
	}
	return nil
}

func (z *zipper) walk(ctx context.Context, start disk.Path, prefix string) error {
	skip := len(start.String())
	if skip > 0 {
		skip++
	}
	return z.tree.Walk(ctx, start, func(p disk.Path, info disk.Info) error {
		name := prefix + entryName(p.String()[skip:])
		switch {
		case info.Denied:
			return fmt.Errorf("cannot read %s", p)
		case info.Kind == disk.KindDir:
			return z.dir(name+"/", info)
		case info.Kind == disk.KindFile:
			return z.file(p, name, info)
		}
		return nil
	})
}

func (z *zipper) dir(name string, info disk.Info) error {
	_, err := z.w.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store, Modified: info.ModTime})
	return err
}

func (z *zipper) file(p disk.Path, name string, info disk.Info) error {
	f, err := z.tree.Open(p)
	if errors.Is(err, disk.ErrNotFound) || errors.Is(err, disk.ErrSymlink) || errors.Is(err, disk.ErrNotRegular) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	w, err := z.w.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store, Modified: info.ModTime})
	if err != nil {
		return err
	}
	_, err = io.Copy(w, f)
	return err
}
