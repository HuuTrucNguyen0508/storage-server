//go:build harness

package harness

import (
	"bytes"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const canary = "CANARY-e3b0c44298fc1c149afb"

func TestGuestListener(t *testing.T) {
	doc, err := os.ReadFile("../docs/design/API.md")
	if err != nil {
		t.Fatal(err)
	}
	s := start(t)
	s.claim()
	s.write("x.txt", "x")
	row := regexp.MustCompile("(?m)^\\| `(GET|POST|HEAD|PATCH|DELETE) ([^`]+)` \\| (Owner|None) \\|")
	id := regexp.MustCompile(`\{[a-z]+\}`)
	guestBase := "http://" + s.guestAddr
	anonymous := newClient(t, guestBase)
	sessioned := newClient(t, guestBase)
	sessioned.http.Jar = s.owner.http.Jar
	checked := 0
	for _, m := range row.FindAllStringSubmatch(string(doc), -1) {
		method, path, auth := m[1], id.ReplaceAllString(m[2], "abc"), m[3]
		if path == "/healthz" || strings.HasPrefix(path, "/api/public/") {
			continue
		}
		for name, c := range map[string]*client{"without a cookie": anonymous, "with a session cookie": sessioned} {
			if method == "HEAD" {
				if got := c.call(method, path, nil); got.status != 404 {
					t.Errorf("%s %s %s = %d", method, path, name, got.status)
				}
				continue
			}
			c.expectError(method, path, nil, 404, "not_found")
		}
		if auth == "Owner" {
			s2 := newClient(t, "http://"+s.ownerAddr)
			if got := s2.call(method, path, nil); got.status != 401 {
				t.Errorf("%s %s on the owner port without a cookie = %d, want 401", method, path, got.status)
			}
		}
		checked++
	}
	if checked < 27 {
		t.Fatalf("checked only %d routes", checked)
	}
	anonymous.expectError("GET", "/", nil, 404, "not_found")
	anonymous.expectError("GET", "/s/a/b", nil, 404, "not_found")
	r := anonymous.expect("GET", "/s/sometoken", nil, 200)
	if r.header.Get("Referrer-Policy") != "no-referrer" || !strings.Contains(string(r.body), "<title>") {
		t.Fatalf("shell = %v %s", r.header, r.body)
	}
	if got := anonymous.expect("GET", "/healthz", nil, 200); !bytes.Contains(got.body, []byte(`"ok"`)) {
		t.Fatalf("healthz = %s", got.body)
	}
	if resp, err := anonymous.http.Get("http://" + s.guestAddr + "/metrics"); err == nil {
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Fatalf("metrics on the guest port = %d", resp.StatusCode)
		}
	}
	if got := s.metricsLine("storage_disk_total_bytes"); got == "" || got == "storage_disk_total_bytes 0" {
		t.Fatalf("metrics = %q", got)
	}
	c := s.owner.call("POST", "/api/files/folder", map[string]string{"path": "f"}, "Sec-Fetch-Site", "cross-site")
	if c.status != 403 || c.code() != "cross_origin" {
		t.Fatalf("cross-site POST = %d %s", c.status, c.body)
	}
}

func plantAttack(t *testing.T, s *server) {
	t.Helper()
	outside := filepath.Join(s.dir, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte(canary), 0o644); err != nil {
		t.Fatal(err)
	}
	s.write("sibling.txt", canary)
	s.write("shared/ok.txt", "fine")
	s.write(".storage-server/trash/planted.txt", canary)
	links := map[string]string{
		"rel-out":         "../outside/secret.txt",
		"abs-out":         filepath.Join(outside, "secret.txt"),
		"dir-out":         "../outside",
		"alias-trash":     ".storage-server/trash",
		"shared/sideways": "../sibling.txt",
		"shared/updir":    "..",
	}
	for link, target := range links {
		if err := os.Symlink(target, filepath.Join(s.root, link)); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Mkfifo(filepath.Join(s.root, "fifo"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(s.root, "shared/fifo"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSymlinkEscape(t *testing.T) {
	s := start(t)
	s.claim()
	plantAttack(t, s)
	sh := s.share("shared", "link", nil)
	g := s.openGuest(sh.token())

	ownerPaths := []string{
		"rel-out", "abs-out", "dir-out", "dir-out/secret.txt", "alias-trash", "alias-trash/planted.txt",
		"shared/sideways", "shared/updir", "shared/updir/sibling.txt", "fifo", "shared/fifo",
		"..", "../outside/secret.txt", "shared/..", "shared/../sibling.txt", "./rel-out", "/etc/passwd",
		"shared//ok.txt", ".storage-server/trash/planted.txt", ".STORAGE-SERVER/trash/planted.txt",
		"..\\outside", "%2e%2e/outside/secret.txt", "..%2foutside%2fsecret.txt",
		"rel-out/", "dir-out/../dir-out/secret.txt", "a\x00b",
	}
	guestPaths := []string{
		"sideways", "updir", "updir/sibling.txt", "fifo", "..", "../sibling.txt", "../outside/secret.txt",
		"/sibling.txt", ".storage-server/trash/planted.txt", "./sideways", "%2e%2e/sibling.txt", "ok.txt/../../sibling.txt",
	}
	check := func(route string, r reply, err error) {
		t.Helper()
		if err != nil {
			if strings.Contains(err.Error(), "deadline") || strings.Contains(err.Error(), "Timeout") {
				t.Errorf("%s hung: %v", route, err)
			}
			return
		}
		if bytes.Contains(r.body, []byte(canary)) {
			t.Errorf("%s leaked the canary", route)
		}
		if r.status == 200 && strings.Contains(route, "content") {
			t.Errorf("%s served bytes: %q", route, r.body)
		}
	}
	short := func(c *client) *client {
		cp := *c
		h := *c.http
		h.Timeout = 5 * time.Second
		cp.http = &h
		return &cp
	}
	o, gc := short(s.owner), short(g.client)
	for _, p := range ownerPaths {
		q := url.QueryEscape(p)
		for _, route := range []string{"/api/files?path=", "/api/files/content?path=", "/api/files/thumb?w=256&path=", "/api/search?q=secret&path="} {
			r, err := o.do("GET", route+q, nil)
			check(route+q, r, err)
		}
		form := "path=" + q
		r, err := o.do("POST", "/api/files/zip", form, "Content-Type", "application/x-www-form-urlencoded")
		check("zip "+p, r, err)
		for _, attempt := range []struct {
			route string
			body  any
		}{
			{"/api/shares", map[string]string{"path": p, "kind": "link"}},
			{"/api/shares", map[string]string{"path": p, "kind": "drop"}},
			{"/api/files/folder", map[string]string{"path": p + "/new"}},
		} {
			r, err := o.do("POST", attempt.route, attempt.body)
			check(attempt.route+" "+p, r, err)
			if r.status == 201 && attempt.route == "/api/shares" {
				t.Errorf("shared %q", p)
			}
		}
		r, err = o.do("POST", "/api/uploads", nil, tusHeaders("Upload-Length", "1", "Upload-Metadata", "path "+b64(p+"/x"))...)
		check("upload "+p, r, err)
	}
	for _, p := range guestPaths {
		q := url.QueryEscape(p)
		for _, route := range []string{"/files?path=", "/content?path=", "/thumb?w=256&path="} {
			r, err := gc.do("GET", g.path(route+q), nil)
			check("guest "+route+q, r, err)
		}
		r, err := gc.do("POST", g.path("/zip"), "path="+q, "Content-Type", "application/x-www-form-urlencoded")
		check("guest zip "+p, r, err)
	}
	r := gc.call("POST", g.path("/zip"), nil)
	if r.status != 200 || bytes.Contains(r.body, []byte(canary)) || !bytes.Contains(r.body, []byte("fine")) {
		t.Fatalf("whole-share zip = %d, %d bytes", r.status, len(r.body))
	}

	for _, want := range []struct {
		path string
		code string
	}{
		{"rel-out", "symlink_refused"}, {"dir-out/secret.txt", "symlink_refused"}, {"fifo", "not_regular"},
		{"..", "invalid_path"}, {".storage-server/trash/planted.txt", "reserved_name"},
	} {
		got := o.call("GET", "/api/files/content?path="+url.QueryEscape(want.path), nil)
		if got.code() != want.code {
			t.Errorf("content %s = %d %s, want %s", want.path, got.status, got.body, want.code)
		}
	}
	if got := gc.call("GET", g.path("/content?path=sideways"), nil); got.code() != "symlink_refused" {
		t.Errorf("guest sideways = %d %s", got.status, got.body)
	}
	if got := string(gc.expect("GET", g.path("/content?path=ok.txt"), nil, 200).body); got != "fine" {
		t.Errorf("a real file through the share = %q", got)
	}
	if entries, _ := os.ReadDir(filepath.Join(s.dir, "outside")); len(entries) != 1 {
		t.Errorf("a route wrote outside the root: %v", entries)
	}

	for link, moved := range map[string]string{"rel-out": "moved-out", "fifo": "moved-fifo"} {
		o.expect("POST", "/api/files/rename", map[string]string{"path": link, "name": moved}, 200)
		o.expectError("GET", "/api/files/content?path="+moved, nil, 422, map[string]string{"moved-out": "symlink_refused", "moved-fifo": "not_regular"}[moved])
	}
	s.trash("moved-out")
	if body, err := os.ReadFile(filepath.Join(s.dir, "outside/secret.txt")); err != nil || string(body) != canary {
		t.Fatalf("trashing a link touched its target: %v", err)
	}

	swap := filepath.Join(s.root, "shared/swap")
	real := filepath.Join(s.root, "shared/swap.dir")
	link := filepath.Join(s.root, "shared/swap.link")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "f.txt"), []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dir, "outside/f.txt"), []byte(canary), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../outside", link); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(real, swap); err != nil {
		t.Fatal(err)
	}
	var stop atomic.Bool
	var wg sync.WaitGroup
	wg.Go(func() {
		toDir := false
		for !stop.Load() {
			if toDir {
				os.Rename(swap, link)
				os.Rename(real, swap)
			} else {
				os.Rename(swap, real)
				os.Rename(link, swap)
			}
			toDir = !toDir
		}
	})
	var served, leaks atomic.Int64
	deadline := time.Now().Add(1500 * time.Millisecond)
	var readers sync.WaitGroup
	for range 6 {
		readers.Go(func() {
			for time.Now().Before(deadline) {
				r, err := gc.do("GET", g.path("/content?path=swap/f.txt"), nil)
				if err != nil {
					continue
				}
				if bytes.Contains(r.body, []byte(canary)) {
					leaks.Add(1)
				}
				if r.status == 200 {
					served.Add(1)
				}
			}
		})
	}
	readers.Wait()
	stop.Store(true)
	wg.Wait()
	if leaks.Load() != 0 {
		t.Fatalf("%d racing reads leaked the canary", leaks.Load())
	}
	t.Logf("racing reads served=%d leaks=0", served.Load())
}

func TestURLPathTraversalDoesNotReachTheShell(t *testing.T) {
	s := start(t)
	s.claim()
	conn, err := net.Dial("tcp", s.guestAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "GET /../../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	body, _ := io.ReadAll(conn)
	if bytes.Contains(body, []byte("root:")) {
		t.Fatalf("response = %s", body)
	}
}

const wantCSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"

func TestHostileUpload(t *testing.T) {
	s := start(t)
	s.claim()
	s.owner.expect("POST", "/api/files/folder", map[string]string{"path": "inbox"}, 201)
	drop := s.share("inbox", "drop", nil)
	d := s.openGuest(drop.token())
	hostile := map[string]struct {
		body string
		ct   string
		disp string
	}{
		"page.html": {`<script>localStorage.canary=1;fetch("/beacon")</script>`, "text/plain; charset=utf-8", "inline; filename*=UTF-8''page.html"},
		"x.svg":     {`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`, "image/svg+xml", "inline; filename*=UTF-8''x.svg"},
		"evil.pdf":  {"%PDF-1.4\n1 0 obj<</OpenAction<</JS(app.alert(1))/S/JavaScript>>>>endobj", "application/pdf", "inline; filename*=UTF-8''evil.pdf"},
		"run.js":    {`alert(1)`, "text/plain; charset=utf-8", "inline; filename*=UTF-8''run.js"},
		"app.exe":   {`MZ`, "application/octet-stream", "attachment; filename*=UTF-8''app.exe"},
	}
	for name, h := range hostile {
		url := tusCreate(d.client, d.path("/uploads"), name, int64(len(h.body)))
		tusPatch(d.client, url, 0, []byte(h.body))
	}
	folder := s.share("inbox", "link", nil)
	g := s.openGuest(folder.token())
	for name, h := range hostile {
		for surface, r := range map[string]reply{
			"owner": s.owner.expect("GET", "/api/files/content?path=inbox/"+name, nil, 200),
			"guest": g.expect("GET", g.path("/content?path="+name), nil, 200),
		} {
			for key, want := range map[string]string{
				"Content-Type":                 h.ct,
				"Content-Disposition":          h.disp,
				"Content-Security-Policy":      wantCSP,
				"X-Content-Type-Options":       "nosniff",
				"Cross-Origin-Resource-Policy": "same-origin",
				"Referrer-Policy":              "no-referrer",
			} {
				if got := r.header.Get(key); got != want {
					t.Errorf("%s %s %s = %q, want %q", surface, name, key, got, want)
				}
			}
			if string(r.body) != h.body {
				t.Errorf("%s %s body changed", surface, name)
			}
		}
	}
	t.Run("browser", func(t *testing.T) {
		t.Skip("the headless Chromium half needs the built frontend and belongs to a later step")
	})
}
