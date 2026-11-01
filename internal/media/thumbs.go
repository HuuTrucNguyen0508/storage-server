package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	_ "golang.org/x/image/webp"

	"storage-server/internal/disk"
)

const (
	maxPixels  = 64_000_000
	cacheBound = 1 << 30
)

// ErrNoThumbnail means this file has no preview image: not an image, a format
// the decoder lacks, SVG, or a picture too large to decode safely.
var ErrNoThumbnail = errors.New("no thumbnail for this file")

type Thumbnails struct {
	dir   string
	limit chan struct{}
}

func NewThumbnails(dir string) *Thumbnails {
	return &Thumbnails{dir: dir, limit: make(chan struct{}, 2)}
}

func (t *Thumbnails) cachePath(f *disk.File, width int) string {
	i := f.Info
	sum := sha256.Sum256(fmt.Appendf(nil, "%d/%d/%d/%d/%d", i.Dev, i.Inode, i.Size, i.ModTime.UnixNano(), width))
	return filepath.Join(t.dir, hex.EncodeToString(sum[:16])+".jpg")
}

func renderable(name string) bool {
	return ClassOf(name) == ClassImage && !strings.EqualFold(filepath.Ext(name), ".svg") && !strings.EqualFold(filepath.Ext(name), ".avif")
}

// Get returns a cached or fresh JPEG. It takes the open file, so a guest's file
// link stays on the descriptor the vault opened. The key is device, inode, size,
// mtime and width, so a replaced file misses. It checks dimensions with
// DecodeConfig before decoding, so a decompression bomb is refused. SVG is never
// rasterised.
func (t *Thumbnails) Get(ctx context.Context, f *disk.File, width int) (io.ReadSeekCloser, time.Time, error) {
	if !renderable(f.Info.Name) {
		return nil, time.Time{}, ErrNoThumbnail
	}
	path := t.cachePath(f, width)
	if c, mod, err := openCached(path); err == nil {
		return c, mod, nil
	}
	select {
	case t.limit <- struct{}{}:
		defer func() { <-t.limit }()
	case <-ctx.Done():
		return nil, time.Time{}, ctx.Err()
	}
	if c, mod, err := openCached(path); err == nil {
		return c, mod, nil
	}
	if err := render(f, width, path); err != nil {
		return nil, time.Time{}, err
	}
	return openCached(path)
}

func openCached(path string) (io.ReadSeekCloser, time.Time, error) {
	c, err := os.Open(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	st, err := c.Stat()
	if err != nil {
		c.Close()
		return nil, time.Time{}, err
	}
	return c, st.ModTime(), nil
}

func render(f *disk.File, width int, path string) error {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	cfg, _, err := image.DecodeConfig(f)
	if err != nil || int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return ErrNoThumbnail
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	img, err := imaging.Decode(f, imaging.AutoOrientation(true))
	if err != nil {
		return ErrNoThumbnail
	}
	fit := imaging.Fit(img, width, width, imaging.Box)
	flat := imaging.Overlay(imaging.New(fit.Bounds().Dx(), fit.Bounds().Dy(), color.White), fit, image.Point{}, 1)

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	err = imaging.Encode(tmp, flat, imaging.JPEG, imaging.JPEGQuality(80))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Prune deletes the oldest cache files past the size bound.
func (t *Thumbnails) Prune(ctx context.Context) error {
	entries, err := os.ReadDir(t.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	type file struct {
		path string
		size int64
		mod  time.Time
	}
	var files []file
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, file{filepath.Join(t.dir, e.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	slices.SortFunc(files, func(a, b file) int { return a.mod.Compare(b.mod) })
	for _, f := range files {
		if total <= cacheBound || ctx.Err() != nil {
			break
		}
		if err := os.Remove(f.path); err != nil {
			return err
		}
		total -= f.size
	}
	return nil
}
