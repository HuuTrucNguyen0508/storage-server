package blobs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"testing"
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
