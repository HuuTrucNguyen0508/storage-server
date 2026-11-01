//go:build harness

package harness

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

const giantSize = 5 << 30

func plantGiant(t *testing.T, s *server, rel string) *os.File {
	t.Helper()
	full := filepath.Join(s.root, rel)
	f, err := os.Create(full)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	if err := f.Truncate(giantSize); err != nil {
		t.Fatal(err)
	}
	g := seeded{seed: 7}
	for _, off := range []int64{0, 3 << 30, 4<<30 + 500, giantSize - 2*mib} {
		if _, err := f.WriteAt(g.at(off, 2*mib), off); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func TestRangeRead(t *testing.T) {
	s := start(t)
	s.claim()
	f := plantGiant(t, s, "movie.mkv")
	sh := s.share("movie.mkv", "link", nil)
	g := s.openGuest(sh.token())

	readBack := func(off, n int64) string {
		buf := make([]byte, n)
		if _, err := f.ReadAt(buf, off); err != nil && err != io.EOF {
			t.Fatal(err)
		}
		return string(buf)
	}
	for name, c := range map[string]struct {
		cl    *client
		route string
	}{
		"owner": {s.owner, "/api/files/content?path=movie.mkv"},
		"guest": {g.client, g.path("/content")},
	} {
		t.Run(name, func(t *testing.T) {
			for _, r := range []struct {
				header string
				off, n int64
				cr     string
			}{
				{"bytes=0-999", 0, 1000, "bytes 0-999/5368709120"},
				{"bytes=4294967796-4294969795", 4<<30 + 500, 2000, "bytes 4294967796-4294969795/5368709120"},
				{"bytes=3221225472-3221225473", 3 << 30, 2, "bytes 3221225472-3221225473/5368709120"},
				{"bytes=5368709119-5368709119", giantSize - 1, 1, "bytes 5368709119-5368709119/5368709120"},
				{"bytes=-500", giantSize - 500, 500, "bytes 5368708620-5368709119/5368709120"},
				{"bytes=5368709000-", giantSize - 120, 120, "bytes 5368709000-5368709119/5368709120"},
			} {
				got := c.cl.expect("GET", c.route, nil, 206, "Range", r.header)
				if got.header.Get("Content-Range") != r.cr {
					t.Errorf("%s Content-Range = %q", r.header, got.header.Get("Content-Range"))
				}
				if string(got.body) != readBack(r.off, r.n) {
					t.Errorf("%s body differs from the disk", r.header)
				}
			}
			c.cl.expect("GET", c.route, nil, 416, "Range", "bytes=5368709120-")

			tag := c.cl.expect("GET", c.route, nil, 206, "Range", "bytes=0-0").header.Get("Etag")
			if got := c.cl.expect("GET", c.route, nil, 206, "Range", "bytes=1-1", "If-Range", tag); string(got.body) != readBack(1, 1) {
				t.Error("a fresh If-Range lost its range")
			}
			req, err := http.NewRequest("GET", c.cl.base+c.route, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Range", "bytes=1-1")
			req.Header.Set("If-Range", `"stale"`)
			resp, err := c.cl.http.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 || resp.ContentLength != giantSize {
				t.Errorf("stale If-Range = %d, %d bytes", resp.StatusCode, resp.ContentLength)
			}
		})
	}
	s.checkRSS(128 * mib)
	if sh, _ := s.shareByID(sh.ID); sh.Uses != 1 {
		t.Errorf("seeks on one grant spent %d uses, want 1", sh.Uses)
	}
}

func TestContentRefusals(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("dir/a.txt", "a")
	s.owner.expectError("GET", "/api/files/content?path=dir", nil, 422, "not_regular")
	s.owner.expectError("GET", "/api/files/content?path=missing", nil, 404, "not_found")
	s.owner.expectError("GET", "/api/files/content?path="+url.QueryEscape("dir/a.txt/x"), nil, 404, "not_found")
	s.owner.expectError("GET", "/api/files?path=dir/a.txt", nil, 422, "not_a_directory")
	r := s.owner.expect("GET", "/api/files/content?path=dir/a.txt&download", nil, 200)
	if want := fmt.Sprintf("attachment; filename*=UTF-8''%s", "a.txt"); r.header.Get("Content-Disposition") != want {
		t.Fatalf("disposition = %q", r.header.Get("Content-Disposition"))
	}
}
