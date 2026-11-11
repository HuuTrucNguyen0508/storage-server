// Package preview builds cached derivatives of stored files: image
// thumbnails, Office-to-PDF conversions (through Stirling PDF) and ZIP
// listings. Caches are keyed by blob id, and blobs never change, so a cached
// file is never stale.
package preview

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // decoders for thumbnails
	"image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/disintegration/imaging"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/blobs"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/telemetry"
)

// ErrUnavailable means no preview can be made; the viewer offers a download.
var ErrUnavailable = errors.New("preview unavailable")

// ErrBusy means the converter is saturated; the client may retry.
var ErrBusy = errors.New("preview converter busy")

// group runs one computation per key at a time (a tiny singleflight).
type group struct {
	mu sync.Mutex
	m  map[string]*call
}

type call struct {
	done chan struct{}
	val  string
	err  error
}

func (g *group) do(key string, fn func() (string, error)) (string, error) {
	g.mu.Lock()
	if g.m == nil {
		g.m = map[string]*call{}
	}
	if c, ok := g.m[key]; ok {
		g.mu.Unlock()
		<-c.done
		return c.val, c.err
	}
	c := &call{done: make(chan struct{})}
	g.m[key] = c
	g.mu.Unlock()
	c.val, c.err = fn()
	close(c.done)
	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()
	return c.val, c.err
}

// ---- thumbnails ----

// MaxPixels refuses to decode images larger than this (decompression bombs).
const MaxPixels = 80_000_000

// Thumbnailer makes JPEG thumbnails.
type Thumbnailer struct {
	dir     *blobs.Dir
	metrics *telemetry.Metrics
	sem     chan struct{}
	g       group
}

// NewThumbnailer limits concurrent decodes to n.
func NewThumbnailer(dir *blobs.Dir, m *telemetry.Metrics, n int) *Thumbnailer {
	return &Thumbnailer{dir: dir, metrics: m, sem: make(chan struct{}, n)}
}

// Sizes are the only thumbnail edge lengths served.
var Sizes = map[int]bool{128: true, 256: true, 512: true}

// Thumbnail returns the path of a cached thumbnail, generating it if needed.
func (t *Thumbnailer) Thumbnail(ctx context.Context, blobID string, size int) (string, error) {
	dst, err := t.dir.ThumbPath(blobID, size)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(dst); err == nil {
		return dst, nil
	}
	return t.g.do(dst, func() (string, error) {
		select {
		case t.sem <- struct{}{}:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		defer func() { <-t.sem }()
		start := time.Now()
		defer func() { t.metrics.ThumbDuration.Observe(time.Since(start).Seconds()) }()
		f, err := t.dir.Open(blobID)
		if err != nil {
			return "", err
		}
		defer f.Close()
		cfg, _, err := image.DecodeConfig(f)
		if err != nil || cfg.Width*cfg.Height > MaxPixels || cfg.Width <= 0 || cfg.Height <= 0 {
			return "", ErrUnavailable
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return "", err
		}
		img, err := imaging.Decode(f, imaging.AutoOrientation(true))
		if err != nil {
			return "", ErrUnavailable
		}
		thumb := imaging.Fit(img, size, size, imaging.Lanczos)
		// Flatten transparency onto white so JPEG output looks right.
		bg := imaging.New(thumb.Bounds().Dx(), thumb.Bounds().Dy(), image.White)
		flat := imaging.Overlay(bg, thumb, image.Pt(0, 0), 1)
		err = t.dir.WriteAtomic(dst, func(w io.Writer) error { return jpeg.Encode(w, flat, &jpeg.Options{Quality: 82}) })
		return dst, err
	})
}

// ---- Office documents ----

// ErrPending means a conversion is running; ask again shortly.
var ErrPending = errors.New("preview being prepared")

// Office converts Office documents to PDF through Stirling PDF. Conversions
// run in the background (at most `concurrency` at once, a bounded queue
// behind them), so no HTTP request waits on LibreOffice: callers get
// ErrPending and poll.
type Office struct {
	URL      string
	Timeout  time.Duration
	MaxBytes int64
	dir      *blobs.Dir
	metrics  *telemetry.Metrics
	client   *http.Client
	sem      chan struct{}
	mu       sync.Mutex
	inflight map[string]bool
	maxQueue int
	// Log receives one warning per failed conversion.
	Log *slog.Logger
}

// NewOffice allows at most concurrency conversions at once.
func NewOffice(url string, concurrency int, timeout time.Duration, maxBytes int64, dir *blobs.Dir, m *telemetry.Metrics) *Office {
	return &Office{
		URL: url, Timeout: timeout, MaxBytes: maxBytes, dir: dir, metrics: m,
		client:   &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)},
		sem:      make(chan struct{}, concurrency),
		inflight: map[string]bool{},
		maxQueue: 8 * concurrency,
	}
}

// failedFor is how long a failed conversion is remembered before retrying.
const failedFor = 10 * time.Minute

// PDF returns the path of the cached PDF rendering of a blob, or starts the
// conversion and returns ErrPending. ErrUnavailable means it failed (or the
// file is too big); ErrBusy means the queue is full.
func (o *Office) PDF(ctx context.Context, blobID, name string, size int64) (string, error) {
	if o.URL == "" || size > o.MaxBytes {
		return "", ErrUnavailable
	}
	dst, err := o.dir.PreviewPath(blobID)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(dst); err == nil {
		o.metrics.OfficeConvert.WithLabelValues("cached").Inc()
		return dst, nil
	}
	failed := strings.TrimSuffix(dst, ".pdf") + ".failed"
	if st, err := os.Stat(failed); err == nil && time.Since(st.ModTime()) < failedFor {
		return "", ErrUnavailable
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.inflight[blobID] {
		return "", ErrPending
	}
	if len(o.inflight) >= o.maxQueue {
		o.metrics.OfficeConvert.WithLabelValues("busy").Inc()
		return "", ErrBusy
	}
	o.inflight[blobID] = true
	// The conversion belongs to no request: it keeps the trace link but not the cancellation.
	bg := context.WithoutCancel(ctx)
	go func() {
		defer func() {
			o.mu.Lock()
			delete(o.inflight, blobID)
			o.mu.Unlock()
		}()
		o.sem <- struct{}{}
		defer func() { <-o.sem }()
		cctx, cancel := context.WithTimeout(bg, o.Timeout)
		defer cancel()
		start := time.Now()
		err := o.convert(cctx, blobID, name, dst)
		o.metrics.OfficeDuration.Observe(time.Since(start).Seconds())
		switch {
		case err == nil:
			o.metrics.OfficeConvert.WithLabelValues("ok").Inc()
			return
		case errors.Is(err, context.DeadlineExceeded):
			o.metrics.OfficeConvert.WithLabelValues("timeout").Inc()
		default:
			o.metrics.OfficeConvert.WithLabelValues("error").Inc()
		}
		if o.Log != nil {
			o.Log.WarnContext(bg, "office conversion failed", "blob", blobID, "err", err)
		}
		msg := err.Error()
		o.dir.WriteAtomic(failed, func(w io.Writer) error { _, werr := io.WriteString(w, msg); return werr }) //nolint:errcheck
	}()
	return "", ErrPending
}

func (o *Office) convert(ctx context.Context, blobID, name, dst string) error {
	src, err := o.dir.Open(blobID)
	if err != nil {
		return err
	}
	defer src.Close()
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		// Stirling picks the converter from the file extension; the name is
		// reduced to a safe generic one with the original extension.
		ext := ""
		if dot := strings.LastIndexByte(name, '.'); dot >= 0 {
			ext = strings.ToLower(name[dot:])
		}
		part, err := mw.CreateFormFile("fileInput", "document"+ext)
		if err == nil {
			_, err = io.Copy(part, src)
		}
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.URL+"/api/v1/convert/file/pdf", pr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := o.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("stirling-pdf answered %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}
	return o.dir.WriteAtomic(dst, func(w io.Writer) error {
		head := make([]byte, 5)
		n, err := io.ReadFull(resp.Body, head)
		if err != nil || n < 5 || string(head) != "%PDF-" {
			return errors.New("stirling-pdf did not return a PDF")
		}
		if _, err := w.Write(head); err != nil {
			return err
		}
		_, err = io.Copy(w, io.LimitReader(resp.Body, 1<<30))
		return err
	})
}

// ---- ZIP listings ----

// ArchiveEntry is one file inside a ZIP.
type ArchiveEntry struct {
	Name       string    `json:"name"`
	Size       uint64    `json:"size"`
	Compressed uint64    `json:"compressed"`
	Modified   time.Time `json:"modified"`
	IsDir      bool      `json:"isDir"`
}

// ArchiveListing is what the viewer shows for a ZIP.
type ArchiveListing struct {
	Entries   []ArchiveEntry `json:"entries"`
	Total     int            `json:"total"`
	Truncated bool           `json:"truncated"`
}

// MaxArchiveEntries caps a listing.
const MaxArchiveEntries = 5000

// ListZip reads the central directory of a ZIP blob.
func ListZip(f io.ReaderAt, size int64) (*ArchiveListing, error) {
	zr, err := zip.NewReader(f, size)
	if err != nil {
		return nil, ErrUnavailable
	}
	out := &ArchiveListing{Total: len(zr.File), Entries: make([]ArchiveEntry, 0, min(len(zr.File), MaxArchiveEntries))}
	for i, zf := range zr.File {
		if i >= MaxArchiveEntries {
			out.Truncated = true
			break
		}
		out.Entries = append(out.Entries, ArchiveEntry{
			Name: zf.Name, Size: zf.UncompressedSize64, Compressed: zf.CompressedSize64,
			Modified: zf.Modified, IsDir: strings.HasSuffix(zf.Name, "/"),
		})
	}
	return out, nil
}
