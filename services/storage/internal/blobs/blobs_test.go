package blobs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type failAfter struct {
	r io.Reader
	n int
}

func (f *failAfter) Read(p []byte) (int, error) {
	if f.n <= 0 {
		return 0, io.ErrUnexpectedEOF
	}
	if len(p) > f.n {
		p = p[:f.n]
	}
	n, err := f.r.Read(p)
	f.n -= n
	return n, err
}

func TestAppendChunkResumesAndHashes(t *testing.T) {
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := "00000000-0000-0000-0000-000000000001"
	data := bytes.Repeat([]byte("0123456789"), 1000)
	off, st, err := d.AppendChunk(session, 0, nil, bytes.NewReader(data[:3000]), 5000)
	if err != nil || off != 3000 {
		t.Fatalf("first chunk: %d %v", off, err)
	}
	// Interrupted after 1234 bytes: those bytes count.
	off, st, err = d.AppendChunk(session, off, st, &failAfter{r: bytes.NewReader(data[3000:6000]), n: 1234}, 5000)
	if !errors.Is(err, io.ErrUnexpectedEOF) || off != 4234 {
		t.Fatalf("interrupted: %d %v", off, err)
	}
	// Garbage past the recorded offset (a crash before the DB write) is dropped.
	f, _ := os.OpenFile(must(d.UploadPath(session)), os.O_WRONLY|os.O_APPEND, 0)
	f.Write([]byte("garbage"))
	f.Close()
	if _, _, err := d.AppendChunk(session, off, st, bytes.NewReader(data[off:]), 10); !errors.Is(err, ErrTooMuch) {
		t.Fatalf("oversized chunk: %v", err)
	}
	off, st, err = d.AppendChunk(session, off, st, bytes.NewReader(data[off:]), int64(len(data))-off)
	if err != nil || off != int64(len(data)) {
		t.Fatalf("last chunk: %d %v", off, err)
	}
	sum, _ := Sum(st)
	want := sha256.Sum256(data)
	if sum != hex.EncodeToString(want[:]) {
		t.Fatal("hash mismatch")
	}
	id := NewID()
	if err := d.Commit(session, id); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(must(d.Path(id)))
	if !bytes.Equal(got, data) {
		t.Fatal("content mismatch")
	}
	for _, bad := range []string{"../x", "ABC", "", "0123456789abcdef0123456789abcdeg"} {
		if _, err := d.Path(bad); err == nil {
			t.Errorf("Path(%q) accepted", bad)
		}
		if _, err := d.UploadPath(bad); err == nil {
			t.Errorf("UploadPath(%q) accepted", bad)
		}
	}
}

func must(p string, err error) string {
	if err != nil {
		panic(err)
	}
	return p
}

func TestQuarantineRoundTrip(t *testing.T) {
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	id := NewID()
	p := must(d.Path(id))
	os.MkdirAll(filepath.Dir(p), 0o700)
	os.WriteFile(p, []byte("data"), 0o600)
	old := time.Now().Add(-48 * time.Hour)
	os.Chtimes(p, old, old)
	thumb := must(d.ThumbPath(id, 256))
	os.WriteFile(thumb, []byte("jpg"), 0o600)
	if err := d.Quarantine(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("blob still in place")
	}
	if _, err := os.Stat(thumb); !os.IsNotExist(err) {
		t.Fatal("thumbnail kept")
	}
	var seen []string
	d.Quarantined(func(qid string, since time.Time) {
		seen = append(seen, qid)
		if time.Since(since) > time.Minute {
			t.Errorf("quarantine time %v not refreshed", since)
		}
	})
	if len(seen) != 1 || seen[0] != id {
		t.Fatalf("quarantined %v", seen)
	}
	// Quarantining a blob that is already gone is not an error.
	if err := d.Quarantine(id); err != nil {
		t.Fatal(err)
	}
	if err := d.Unquarantine(id); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p); string(got) != "data" {
		t.Fatalf("unquarantined content %q", got)
	}
	for _, bad := range []string{"../x", "ABC", ""} {
		if d.Quarantine(bad) == nil || d.Unquarantine(bad) == nil || d.Purge(bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
