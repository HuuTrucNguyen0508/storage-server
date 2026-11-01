//go:build harness

package harness

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const mib = 1 << 20

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func tusHeaders(extra ...string) []string {
	return append([]string{"Tus-Resumable", "1.0.0"}, extra...)
}

// tusCreate returns the upload's path.
func tusCreate(c *client, route, path string, length int64) string {
	c.t.Helper()
	r := c.expect("POST", route, nil, 201, tusHeaders(
		"Upload-Length", strconv.FormatInt(length, 10),
		"Upload-Metadata", "path "+b64(path))...)
	loc := r.header.Get("Location")
	if loc == "" {
		c.t.Fatalf("no Location: %+v", r.header)
	}
	return loc
}

func tusOffset(c *client, url string) int64 {
	c.t.Helper()
	r := c.expect("HEAD", url, nil, 200, tusHeaders()...)
	n, err := strconv.ParseInt(r.header.Get("Upload-Offset"), 10, 64)
	if err != nil {
		c.t.Fatalf("Upload-Offset %q", r.header.Get("Upload-Offset"))
	}
	if r.header.Get("Cache-Control") != "no-store" {
		c.t.Fatalf("Cache-Control = %q", r.header.Get("Cache-Control"))
	}
	return n
}

func tusPatch(c *client, url string, offset int64, body []byte) reply {
	c.t.Helper()
	return c.expect("PATCH", url, body, 204, tusHeaders(
		"Content-Type", "application/offset+octet-stream",
		"Upload-Offset", strconv.FormatInt(offset, 10))...)
}

// upload sends one whole file through tus and returns the stored path.
func (s *server) upload(path, body string) string {
	s.t.Helper()
	url := tusCreate(s.owner, "/api/uploads", path, int64(len(body)))
	return tusPatch(s.owner, url, 0, []byte(body)).header.Get("X-Stored-Path")
}

// seeded produces the same bytes for the same offset, so any resume point can be
// served and the final hash can be computed without storing the file.
type seeded struct{ seed uint64 }

const seedBlock = mib

func (g seeded) block(i int64) []byte {
	var key [32]byte
	binary.LittleEndian.PutUint64(key[:], g.seed)
	binary.LittleEndian.PutUint64(key[8:], uint64(i))
	out := make([]byte, seedBlock)
	rand.NewChaCha8(key).Read(out)
	return out
}

func (g seeded) at(offset int64, n int) []byte {
	out := make([]byte, 0, n)
	for len(out) < n {
		i, skip := offset/seedBlock, offset%seedBlock
		b := g.block(i)[skip:]
		take := min(len(b), n-len(out))
		out = append(out, b[:take]...)
		offset += int64(take)
	}
	return out
}

func (g seeded) sum(length int64) string {
	h := sha256.New()
	for off := int64(0); off < length; off += seedBlock {
		h.Write(g.at(off, int(min(seedBlock, length-off))))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func hashFile(t *testing.T, path string) string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// rawPatch writes the head of a PATCH and part of its body on a bare socket, so
// the test decides exactly when the connection dies.
func rawPatch(t *testing.T, addr, url, cookie string, offset, contentLength int64, part []byte) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "PATCH %s HTTP/1.1\r\nHost: %s\r\nCookie: %s\r\nTus-Resumable: 1.0.0\r\nContent-Type: application/offset+octet-stream\r\nUpload-Offset: %d\r\nContent-Length: %d\r\n\r\n",
		url, addr, cookie, offset, contentLength)
	if _, err := conn.Write(part); err != nil {
		t.Fatal(err)
	}
	return conn
}

func cookieHeader(t *testing.T, c *client) string {
	t.Helper()
	req, err := http.NewRequest("GET", c.base+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	var parts []string
	for _, ck := range c.http.Jar.Cookies(req.URL) {
		parts = append(parts, ck.Name+"="+ck.Value)
	}
	return strings.Join(parts, "; ")
}

func (s *server) spoolData(url string) string {
	return filepath.Join(s.root, ".storage-server/spool", url[strings.LastIndexByte(url, '/')+1:], "data")
}

// headEqualsDisk asks for the offset, then reads the file. HEAD stops any writer
// first, so the two must agree.
func headEqualsDisk(t *testing.T, s *server, c *client, url string) int64 {
	t.Helper()
	offset := tusOffset(c, url)
	st, err := os.Stat(s.spoolData(url))
	if err != nil {
		if offset == 0 && os.IsNotExist(err) {
			return 0
		}
		t.Fatal(err)
	}
	if st.Size() != offset {
		t.Fatalf("HEAD offset %d, data file holds %d", offset, st.Size())
	}
	return offset
}

func sendTo(t *testing.T, c *client, url string, g seeded, from, to, chunk int64) {
	t.Helper()
	for off := from; off < to; {
		n := min(chunk, to-off)
		tusPatch(c, url, off, g.at(off, int(n)))
		off += n
	}
}

// TestUploadResume sends seeded ChaCha8 through tus, 6 GiB in the long tier and
// 96 MiB otherwise. It cuts the socket at two offsets, SIGKILLs the server at a
// third, simulates a page reload by resuming from the saved upload URL in a fresh
// client, and stalls one writer to force a takeover. It asserts the final
// SHA-256, that HEAD equals the bytes on disk after each fault, that no partial
// file was ever visible in the folder (a poller lists it throughout), and that
// VmHWM stays under 128 MiB.
func TestUploadResume(t *testing.T) {
	total, chunk := int64(96*mib), int64(8*mib)
	if longTier {
		total, chunk = 6<<30, 64*mib
	}
	s := start(t)
	s.claim()
	g := seeded{seed: 42}
	want := g.sum(total)
	s.owner.expect("POST", "/api/files/folder", map[string]string{"path": "up"}, 201)
	url := tusCreate(s.owner, "/api/uploads", "up/big.bin", total)

	var stop atomic.Bool
	var polls atomic.Int64
	var poller sync.WaitGroup
	poller.Go(func() {
		for !stop.Load() {
			entries, err := os.ReadDir(filepath.Join(s.root, "up"))
			if err == nil {
				polls.Add(1)
				for _, e := range entries {
					info, err := e.Info()
					if err == nil && info.Size() != total {
						t.Errorf("partial file visible: %s, %d bytes", e.Name(), info.Size())
					}
				}
			}
			time.Sleep(2 * time.Millisecond)
		}
	})

	cookie := cookieHeader(t, s.owner)
	part := func(off int64) []byte { return g.at(off, int(chunk/2)) }

	sendTo(t, s.owner, url, g, 0, total/5, chunk)
	offset := headEqualsDisk(t, s, s.owner, url)
	conn := rawPatch(t, s.ownerAddr, url, cookie, offset, chunk, part(offset))
	conn.Close()
	first := waitOffsetAdvance(t, s, s.owner, url, offset)

	sendTo(t, s.owner, url, g, first, 2*total/5, chunk)
	offset = headEqualsDisk(t, s, s.owner, url)
	conn = rawPatch(t, s.ownerAddr, url, cookie, offset, chunk, part(offset))
	conn.Close()
	second := waitOffsetAdvance(t, s, s.owner, url, offset)

	sendTo(t, s.owner, url, g, second, 3*total/5, chunk)
	offset = headEqualsDisk(t, s, s.owner, url)
	conn = rawPatch(t, s.ownerAddr, url, cookie, offset, chunk, part(offset))
	s.checkRSS(128 * mib)
	s.kill()
	conn.Close()
	s.restart()

	reloaded := newClient(t, "http://"+s.ownerAddr)
	reloaded.http.Jar = s.owner.http.Jar
	offset = headEqualsDisk(t, s, reloaded, url)

	sendTo(t, reloaded, url, g, offset, 4*total/5, chunk)
	offset = headEqualsDisk(t, s, reloaded, url)
	stalled := rawPatch(t, s.ownerAddr, url, cookie, offset, chunk, part(offset))
	defer stalled.Close()
	time.Sleep(200 * time.Millisecond)
	began := time.Now()
	taken := headEqualsDisk(t, s, reloaded, url)
	if d := time.Since(began); d > 5*time.Second {
		t.Fatalf("takeover took %v", d)
	}
	stalled.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := bufio.NewReader(stalled).ReadByte(); err == nil {
		io.Copy(io.Discard, stalled)
	}

	r := reloaded.expect("PATCH", url, g.at(taken, int(min(chunk, total-taken))), 204, tusHeaders(
		"Content-Type", "application/offset+octet-stream", "Upload-Offset", strconv.FormatInt(taken, 10))...)
	sent, _ := strconv.ParseInt(r.header.Get("Upload-Offset"), 10, 64)
	sendTo(t, reloaded, url, g, sent, total, chunk)

	stop.Store(true)
	poller.Wait()
	if polls.Load() == 0 {
		t.Fatal("the poller never saw the folder")
	}
	if tusOffset(reloaded, url) != total {
		t.Fatal("HEAD lost the final offset")
	}
	if got := reloaded.expect("HEAD", url, nil, 200, tusHeaders()...).header.Get("X-Stored-Path"); got != "up/big.bin" {
		t.Fatalf("X-Stored-Path = %q", got)
	}
	if got := hashFile(t, filepath.Join(s.root, "up/big.bin")); got != want {
		t.Fatalf("sha256 = %s, want %s", got, want)
	}
	s.checkRSS(128 * mib)
}

// waitOffsetAdvance gives the server time to drain a cut request, then checks
// HEAD against the disk. A cut can leave the offset where it was.
func waitOffsetAdvance(t *testing.T, s *server, c *client, url string, from int64) int64 {
	t.Helper()
	time.Sleep(50 * time.Millisecond)
	offset := headEqualsDisk(t, s, c, url)
	if offset < from {
		t.Fatalf("offset went back from %d to %d", from, offset)
	}
	return offset
}

func TestTusProtocolErrors(t *testing.T) {
	s := start(t)
	s.claim()
	o := s.owner
	o.expectError("POST", "/api/uploads", nil, 412, "tus_version", "Upload-Length", "3", "Upload-Metadata", "path "+b64("x"))
	o.expectError("POST", "/api/uploads", nil, 400, "invalid_length", tusHeaders("Upload-Length", "-1", "Upload-Metadata", "path "+b64("x"))...)
	o.expectError("POST", "/api/uploads", nil, 400, "invalid_path", tusHeaders("Upload-Length", "3")...)
	o.expectError("POST", "/api/uploads", nil, 400, "invalid_path", tusHeaders("Upload-Length", "3", "Upload-Metadata", "path "+b64("../x"))...)
	o.expectError("POST", "/api/uploads", nil, 400, "reserved_name", tusHeaders("Upload-Length", "3", "Upload-Metadata", "path "+b64(".storage-server/x"))...)
	s.write("file", "x")
	o.expectError("POST", "/api/uploads", nil, 409, "exists", tusHeaders("Upload-Length", "3", "Upload-Metadata", "path "+b64("file/x"))...)

	url := tusCreate(o, "/api/uploads", "a.bin", 4)
	o.expectError("PATCH", url, "ab", 415, "content_type", tusHeaders("Upload-Offset", "0")...)
	patch := func(offset string, body string) (int, string) {
		r := o.call("PATCH", url, body, tusHeaders("Content-Type", "application/offset+octet-stream", "Upload-Offset", offset)...)
		return r.status, r.code()
	}
	if st, code := patch("x", "ab"); st != 400 || code != "invalid_offset" {
		t.Fatalf("bad offset = %d %s", st, code)
	}
	if st, code := patch("1", "ab"); st != 409 || code != "offset_mismatch" {
		t.Fatalf("wrong offset = %d %s", st, code)
	}
	if st, code := patch("0", "abcdefgh"); st != 413 || code != "too_long" {
		t.Fatalf("too long = %d %s", st, code)
	}
	if s.exists("a.bin") {
		t.Fatal("an over-long upload published")
	}
	o.expect("DELETE", url, nil, 204, tusHeaders()...)
	o.expectError("HEAD", url, nil, 404, "", tusHeaders()...)
	o.expectError("HEAD", "/api/uploads/not-an-id", nil, 404, "", tusHeaders()...)

	r := o.expect("POST", "/api/uploads", nil, 201, tusHeaders("Upload-Length", "0", "Upload-Metadata", "path "+b64("sub/empty.txt"))...)
	if r.header.Get("X-Stored-Path") != "sub/empty.txt" || r.header.Get("Upload-Offset") != "0" {
		t.Fatalf("zero-length headers = %v", r.header)
	}
	if got := s.read("sub/empty.txt"); got != "" {
		t.Fatalf("empty file holds %q", got)
	}
	if got := s.upload("a.bin", "once"); got != "a.bin" {
		t.Fatalf("stored = %q", got)
	}
	if got := s.upload("a.bin", "twice"); got != "a (1).bin" {
		t.Fatalf("collision stored = %q", got)
	}
	if s.read("a.bin") != "once" {
		t.Fatal("an upload overwrote a file")
	}
}

func TestLowDiskRefusesAnUpload(t *testing.T) {
	s := start(t, "MIN_FREE_BYTES=9000000000000000")
	s.claim()
	s.owner.expectError("POST", "/api/uploads", nil, 507, "insufficient_space", tusHeaders("Upload-Length", "1", "Upload-Metadata", "path "+b64("x"))...)
}
