//go:build harness

package harness

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAPINoStore(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("photo.png", "not an image")
	sh := s.share("photo.png", "link", nil)
	guest := newClient(t, "http://"+s.guestAddr)
	guest.expect("POST", "/api/public/"+sh.token()+"/open", nil, 204)
	for _, tc := range []struct {
		c      *client
		path   string
		status int
	}{
		{s.owner, "/api/session", 200},
		{s.owner, "/api/files/thumb?path=photo.png&w=256", 415},
		{guest, "/api/public/" + sh.token() + "/thumb?w=1", 400},
		{guest, "/api/not-a-route", 404},
	} {
		r := tc.c.expect("GET", tc.path, nil, tc.status)
		if got := r.header.Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s Cache-Control=%q", tc.path, got)
		}
	}
	ranged, err := s.owner.do("GET", "/api/files/content?path=photo.png", nil, "Range", "bytes=999-1000")
	if err != nil {
		t.Fatal(err)
	}
	if ranged.status != 416 || ranged.header.Get("Cache-Control") != "no-store" {
		t.Errorf("range error = %d, cache %q", ranged.status, ranged.header.Get("Cache-Control"))
	}
	s.owner.expect("POST", "/api/files/trash", map[string]any{"paths": []string{"photo.png"}}, 200)
	r := guest.expect("GET", "/api/public/"+sh.token(), nil, 410)
	if got := r.header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("410 Cache-Control=%q", got)
	}
}

func TestPreviewMetadata(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("photo.png", "image")
	sh := s.share("photo.png", "link", nil)
	facts := decodeJSON[map[string]any](t, s.owner.expect("GET", "/api/public/"+sh.token(), nil, 200))
	if facts["preview"] != "image" {
		t.Errorf("file preview=%v", facts["preview"])
	}
	r := s.owner.expect("GET", "/api/search?q=photo", nil, 200)
	var hit map[string]any
	if err := json.Unmarshal([]byte(strings.Split(string(r.body), "\n")[0]), &hit); err != nil {
		t.Fatal(err)
	}
	if hit["preview"] != "image" {
		t.Errorf("search preview=%v", hit["preview"])
	}
}
