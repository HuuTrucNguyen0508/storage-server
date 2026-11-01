//go:build harness

package harness

import (
	"archive/zip"
	"bytes"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestOwnerFiles(t *testing.T) {
	s := start(t)
	s.claim()
	o := s.owner
	if got := decodeJSON[map[string]string](t, o.expect("POST", "/api/files/folder", map[string]string{"path": "a/b"}, 201)); got["path"] != "a/b" {
		t.Fatalf("mkdir = %v", got)
	}
	o.expect("POST", "/api/files/folder", map[string]string{"path": "a/b"}, 201)
	s.write("a/note.md", "# hi")
	s.write("a/photo.PNG", "x")
	o.expectError("POST", "/api/files/folder", map[string]string{"path": "a/note.md"}, 409, "exists")

	type entry struct {
		Name    string `json:"name"`
		Kind    string `json:"kind"`
		Size    int64  `json:"size"`
		Preview string `json:"preview"`
	}
	list := decodeJSON[struct {
		Path    string  `json:"path"`
		Entries []entry `json:"entries"`
	}](t, o.expect("GET", "/api/files?path=a", nil, 200))
	want := []entry{{"b", "dir", 0, ""}, {"note.md", "file", 4, "text"}, {"photo.PNG", "file", 1, "image"}}
	if list.Path != "a" || !slices.Equal(list.Entries, want) {
		t.Fatalf("listing = %+v", list)
	}

	type outcome struct {
		Path    string `json:"path"`
		NewPath string `json:"newPath"`
		Error   string `json:"error"`
	}
	out := decodeJSON[struct {
		Results []outcome `json:"results"`
	}](t, o.expect("POST", "/api/files/move", map[string]any{"paths": []string{"a/note.md", "a/nope", "a"}, "to": "a/b"}, 200))
	wantOut := []outcome{{Path: "a/note.md", NewPath: "a/b/note.md"}, {Path: "a/nope", Error: "not_found"}, {Path: "a", Error: "move_into_self"}}
	if !slices.Equal(out.Results, wantOut) {
		t.Fatalf("move = %+v", out.Results)
	}
	o.expectError("POST", "/api/files/move", map[string]any{"paths": []string{"a/photo.PNG"}, "to": "../x"}, 400, "invalid_path")
	o.expectError("POST", "/api/files/trash", map[string]any{"paths": []string{""}}, 400, "invalid_path")
	o.expectError("POST", "/api/files/rename", map[string]string{"path": "a/photo.PNG", "name": "x/y"}, 400, "invalid_path")
	o.expectError("POST", "/api/files/rename", "{not json", 400, "invalid_json")

	s.write("trip/Beach Photos.jpg", "x")
	s.write("trip/beach.txt", "x")
	s.write("other/photos of beach.png", "x")
	lines := strings.Split(strings.TrimSpace(string(o.expect("GET", "/api/search?q=BEACH+photos", nil, 200).body)), "\n")
	want2 := []string{
		`"path":"other/photos of beach.png"`, `"path":"trip/Beach Photos.jpg"`, `"done":true,"truncated":false`,
	}
	if len(lines) != 3 {
		t.Fatalf("search = %q", lines)
	}
	for i, w := range want2 {
		if !strings.Contains(lines[i], w) {
			t.Errorf("search line %d = %s, want %s", i, lines[i], w)
		}
	}
	scoped := string(o.expect("GET", "/api/search?q=beach&path=trip", nil, 200).body)
	if strings.Contains(scoped, "other/") {
		t.Fatalf("scoped search = %s", scoped)
	}
	o.expectError("GET", "/api/search?q=+", nil, 400, "query_required")
	o.expectError("GET", "/api/search?q=x&path=missing", nil, 404, "not_found")
	for i := range 1005 {
		s.write(fmt.Sprintf("many/hit%d.txt", i), "")
	}
	r := strings.Split(strings.TrimSpace(string(o.expect("GET", "/api/search?q=hit", nil, 200).body)), "\n")
	if len(r) != 1001 || !strings.Contains(r[1000], `"truncated":true`) {
		t.Fatalf("capped search gave %d lines, last %s", len(r), r[len(r)-1])
	}
}

func pngFile(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		img.Set(x, 0, color.RGBA{G: 255, A: 255})
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestThumbnails(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("pics/wide.png", pngFile(t, 1000, 500))
	s.write("pics/note.txt", "x")
	r := s.owner.expect("GET", "/api/files/thumb?path=pics/wide.png&w=256", nil, 200)
	img, format, err := image.Decode(bytes.NewReader(r.body))
	if err != nil || format != "jpeg" || img.Bounds().Dx() != 256 || img.Bounds().Dy() != 128 {
		t.Fatalf("thumb = %v %s %v", err, format, img.Bounds())
	}
	if r.header.Get("Content-Type") != "image/jpeg" || r.header.Get("Content-Security-Policy") != wantCSP {
		t.Fatalf("headers = %v", r.header)
	}
	s.owner.expectError("GET", "/api/files/thumb?path=pics/wide.png&w=100", nil, 400, "invalid_width")
	s.owner.expectError("GET", "/api/files/thumb?path=pics/note.txt&w=256", nil, 415, "no_thumbnail")

	limit := 1
	sh := s.share("pics", "link", map[string]any{"maxUses": limit})
	g := s.openGuest(sh.token())
	g.expect("GET", g.path("/thumb?path=wide.png&w=256"), nil, 200)
	g.expect("GET", g.path("/files"), nil, 200)
	if got, _ := s.shareByID(sh.ID); got.Uses != 0 {
		t.Fatalf("browsing spent %d uses", got.Uses)
	}
	file := s.share("pics/wide.png", "link", nil)
	fg := s.openGuest(file.token())
	fg.expect("GET", fg.path("/thumb?w=1024"), nil, 200)
}

func deny(t *testing.T, s *server, token string, status int, code string) {
	t.Helper()
	s.guest(token).expectError("GET", "/api/public/"+token, nil, status, code)
}

// TestShareLifecycle covers rename, move, trash of the file and of an ancestor,
// restore to a taken path, purge, revoke, expiry, wrong passwords and the limiter.
func TestShareLifecycle(t *testing.T) {
	s := start(t)
	s.claim()
	o := s.owner
	s.write("dir/sub/doc.txt", payload)
	sh := s.share("dir/sub/doc.txt", "link", nil)
	folder := s.share("dir", "link", nil)
	if sh.State != "active" || !strings.HasPrefix(sh.URL, "http://"+s.guestAddr+"/s/") {
		t.Fatalf("share = %+v", sh)
	}

	o.expect("POST", "/api/files/rename", map[string]string{"path": "dir/sub/doc.txt", "name": "renamed.txt"}, 200)
	if got := s.fetch(sh.token()); got != payload {
		t.Fatalf("after rename = %q", got)
	}
	o.expect("POST", "/api/files/rename", map[string]string{"path": "dir/sub", "name": "subfolder"}, 200)
	if got := s.fetch(sh.token()); got != payload {
		t.Fatalf("after ancestor rename = %q", got)
	}
	o.expect("POST", "/api/files/folder", map[string]string{"path": "elsewhere"}, 201)
	o.expect("POST", "/api/files/move", map[string]any{"paths": []string{"dir/subfolder/renamed.txt"}, "to": "elsewhere"}, 200)
	if got := s.fetch(sh.token()); got != payload {
		t.Fatalf("after move = %q", got)
	}
	if got, _ := s.shareByID(sh.ID); got.Path != "elsewhere/renamed.txt" {
		t.Fatalf("share path = %q", got.Path)
	}

	id := s.trash("elsewhere/renamed.txt")
	deny(t, s, sh.token(), 410, "unavailable")
	if got, _ := s.shareByID(sh.ID); got.State != "suspended" || got.Path != "elsewhere/renamed.txt" {
		t.Fatalf("suspended share = %+v", got)
	}
	if got := s.upload("elsewhere/renamed.txt", "new bytes at the trashed path"); got != "elsewhere/renamed.txt" {
		t.Fatalf("stored = %q", got)
	}
	deny(t, s, sh.token(), 410, "unavailable")

	restored := decodeJSON[map[string]string](t, o.expect("POST", "/api/trash/"+id+"/restore", nil, 200))
	if restored["path"] != "elsewhere/renamed (1).txt" {
		t.Fatalf("restored to %q", restored["path"])
	}
	if got := s.fetch(sh.token()); got != payload {
		t.Fatalf("after restore to a taken path = %q", got)
	}

	ancestor := s.trash("elsewhere")
	deny(t, s, sh.token(), 410, "unavailable")
	o.expect("POST", "/api/trash/"+ancestor+"/restore", nil, 200)
	if got := s.fetch(sh.token()); got != payload {
		t.Fatalf("after ancestor restore = %q", got)
	}

	id = s.trash("elsewhere")
	o.expect("DELETE", "/api/trash/"+id, nil, 204)
	deny(t, s, sh.token(), 404, "not_found")
	if _, ok := s.shareByID(sh.ID); ok {
		t.Fatal("a purged item kept its share")
	}
	o.expectError("DELETE", "/api/trash/"+id, nil, 404, "not_found")
	o.expectError("POST", "/api/trash/"+id+"/restore", nil, 404, "not_found")

	s.write("one.txt", "1")
	s.write("two.txt", "2")
	s.trash("one.txt")
	s.trash("two.txt")
	o.expect("DELETE", "/api/trash", nil, 204)
	if got := s.trashItems(); len(got) != 0 {
		t.Fatalf("trash = %+v", got)
	}

	s.write("gone.txt", "bye")
	outOfBand := s.share("gone.txt", "link", nil)
	if err := os.Remove(filepath.Join(s.root, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.shareByID(outOfBand.ID); got.State != "missing" {
		t.Fatalf("deleted outside the app = %+v", got)
	}
	deny(t, s, outOfBand.token(), 410, "unavailable")
	s.write("gone.txt", "back")
	if got := s.fetch(outOfBand.token()); got != "back" {
		t.Fatalf("put back = %q", got)
	}

	g := s.openGuest(folder.token())
	g.expect("GET", g.path("/files"), nil, 200)
	o.expect("DELETE", "/api/shares/"+folder.ID, nil, 204)
	g.expectError("GET", g.path("/files"), nil, 404, "not_found")
	o.expectError("DELETE", "/api/shares/"+folder.ID, nil, 404, "not_found")

	soon := time.Now().Add(1500 * time.Millisecond).UTC().Format(time.RFC3339Nano)
	s.write("brief.txt", "brief")
	brief := s.share("brief.txt", "link", map[string]any{"expiresAt": soon})
	bg := s.openGuest(brief.token())
	bg.expect("GET", bg.path("/content"), nil, 200)
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	deny(t, s, s.share("brief.txt", "link", map[string]any{"expiresAt": past}).token(), 410, "expired")
	time.Sleep(2 * time.Second)
	bg.expectError("GET", bg.path("/content"), nil, 410, "expired")
	if got, _ := s.shareByID(brief.ID); got.State != "expired" {
		t.Fatalf("state = %+v", got)
	}

	locked := s.share("brief.txt", "link", map[string]any{"password": "guest secret"})
	if !locked.HasPass {
		t.Fatalf("share = %+v", locked)
	}
	facts := decodeJSON[map[string]any](t, s.guest(locked.token()).expect("GET", "/api/public/"+locked.token(), nil, 200))
	if facts["passwordRequired"] != true || facts["name"] != "brief.txt" || facts["size"] != float64(5) || facts["isFolder"] != false {
		t.Fatalf("facts = %v", facts)
	}
	lg := s.guest(locked.token())
	lg.expectError("GET", lg.path("/content"), nil, 401, "open_required")
	for range 5 {
		lg.expectError("POST", lg.path("/open"), map[string]string{"password": "nope"}, 401, "bad_credentials")
	}
	r := lg.call("POST", lg.path("/open"), map[string]string{"password": "guest secret"})
	if r.status != 429 || r.header.Get("Retry-After") == "" {
		t.Fatalf("locked open = %d %v", r.status, r.header)
	}
	s.restart()
	lg.expectError("POST", lg.path("/open"), map[string]string{"password": "guest secret"}, 429, "rate_limited")
	unlocked := s.share("brief.txt", "link", map[string]any{"password": "guest secret"})
	ug := s.guest(unlocked.token())
	ug.expect("POST", ug.path("/open"), map[string]string{"password": "guest secret"}, 204)
	if got := string(ug.expect("GET", ug.path("/content"), nil, 200).body); got != "brief" {
		t.Fatalf("passworded link = %q", got)
	}

	s.owner.expectError("POST", "/api/shares", map[string]string{"path": "nope", "kind": "link"}, 404, "not_found")
	s.owner.expectError("POST", "/api/shares", map[string]string{"path": "brief.txt", "kind": "drop"}, 422, "drop_needs_folder")
	s.owner.expectError("POST", "/api/shares", map[string]any{"path": "brief.txt", "kind": "link", "maxUses": 0}, 400, "invalid_request")
	s.owner.expectError("POST", "/api/shares", map[string]string{"path": "brief.txt", "kind": "other"}, 400, "invalid_request")
}

// TestMaxUses races 40 guests on max_uses=3 and asserts exactly three got bytes,
// a preview bot's GET spent nothing, and a video seek after exhaustion still works
// for a holder.
func TestMaxUses(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("video.mp4", strings.Repeat("v", 4096))
	limit := 3
	sh := s.share("video.mp4", "link", map[string]any{"maxUses": limit})

	bot := s.guest(sh.token())
	bot.expect("GET", "/api/public/"+sh.token(), nil, 200)
	bot.expect("GET", "/s/"+sh.token(), nil, 200)
	headGuest := s.openGuest(sh.token())
	headGuest.expect("HEAD", headGuest.path("/content"), nil, 200)
	if got, _ := s.shareByID(sh.ID); got.Uses != 0 {
		t.Fatalf("a bot spent %d uses", got.Uses)
	}

	const guests = 40
	var opened []*guest
	for range guests {
		opened = append(opened, s.openGuest(sh.token()))
	}
	var served, refused atomic.Int64
	var wg sync.WaitGroup
	for _, g := range opened {
		wg.Go(func() {
			r, err := g.do("GET", g.path("/content"), nil, "Range", "bytes=0-99")
			switch {
			case err != nil:
				t.Error(err)
			case r.status == 206 && len(r.body) == 100:
				served.Add(1)
			case r.status == 410 && r.code() == "exhausted":
				refused.Add(1)
			default:
				t.Errorf("guest got %d %s", r.status, r.body)
			}
		})
	}
	wg.Wait()
	if served.Load() != 3 || refused.Load() != guests-3 {
		t.Fatalf("served %d, refused %d", served.Load(), refused.Load())
	}
	if got, _ := s.shareByID(sh.ID); got.Uses != 3 || got.State != "exhausted" {
		t.Fatalf("share = %+v", got)
	}

	var holder *guest
	for _, g := range opened {
		if r, _ := g.do("GET", g.path("/content"), nil, "Range", "bytes=2000-2099"); r.status == 206 {
			holder = g
			break
		}
	}
	if holder == nil {
		t.Fatal("no holder can seek after exhaustion")
	}
	holder.expect("GET", holder.path("/content"), nil, 206, "Range", "bytes=4000-4095")
	holder.expect("GET", "/api/public/"+sh.token(), nil, 200)
	stranger := s.guest(sh.token())
	stranger.expectError("POST", stranger.path("/open"), nil, 410, "exhausted")
	stranger.expectError("GET", "/api/public/"+sh.token(), nil, 410, "exhausted")
	if got, _ := s.shareByID(sh.ID); got.Uses != 3 {
		t.Fatalf("seeks spent uses: %+v", got)
	}

	s.write("folder/a.txt", "a")
	s.write("folder/b.txt", "b")
	one := 1
	lim := s.share("folder", "link", map[string]any{"maxUses": one})
	g := s.openGuest(lim.token())
	g.expect("GET", g.path("/files"), nil, 200)
	g.expectError("GET", g.path("/content?path=missing.txt"), nil, 404, "not_found")
	if got, _ := s.shareByID(lim.ID); got.Uses != 0 {
		t.Fatalf("a 404 spent a use: %+v", got)
	}
	g.expect("GET", g.path("/content?path=a.txt"), nil, 200)
	g.expect("GET", g.path("/content?path=a.txt"), nil, 200)
	g.expectError("GET", g.path("/content?path=b.txt"), nil, 410, "exhausted")
	g.expectError("POST", g.path("/zip"), nil, 410, "exhausted")
	g.expect("GET", g.path("/content?path=a.txt"), nil, 200)

	zipLimit := s.share("folder", "link", map[string]any{"maxUses": one})
	z := s.openGuest(zipLimit.token())
	form := []string{"Content-Type", "application/x-www-form-urlencoded"}
	z.expect("POST", z.path("/zip"), "path=a.txt&path=b.txt", 200, form...)
	z.expect("POST", z.path("/zip"), "path=b.txt&path=a.txt", 200, form...)
	z.expectError("GET", z.path("/content?path=a.txt"), nil, 410, "exhausted")
	if got, _ := s.shareByID(zipLimit.ID); got.Uses != 1 {
		t.Fatalf("a repeated zip spent %d uses", got.Uses)
	}
}

func headerShape(h map[string][]string) string {
	var parts []string
	for k, v := range h {
		switch k {
		case "Location", "Date":
			parts = append(parts, k)
		default:
			parts = append(parts, k+"="+strings.Join(v, ","))
		}
	}
	slices.Sort(parts)
	return strings.Join(parts, "\n")
}

// TestDropPrivacy asserts a drop guest cannot list, read, or learn the final name
// on a collision, and that two guests uploading one name both keep their bytes.
func TestDropPrivacy(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("inbox/existing.txt", "the owner's file")
	drop := s.share("inbox", "drop", nil)
	if drop.Kind != "drop" {
		t.Fatalf("share = %+v", drop)
	}
	facts := decodeJSON[map[string]any](t, s.guest(drop.token()).expect("GET", "/api/public/"+drop.token(), nil, 200))
	if facts["kind"] != "drop" || facts["isFolder"] != true || facts["size"] != nil {
		t.Fatalf("facts = %v", facts)
	}
	g := s.openGuest(drop.token())
	g.expectError("GET", g.path("/files"), nil, 404, "not_found")
	g.expectError("GET", g.path("/content?path=existing.txt"), nil, 404, "not_found")
	g.expectError("GET", g.path("/thumb?path=existing.txt&w=256"), nil, 404, "not_found")
	g.expectError("POST", g.path("/zip"), nil, 404, "not_found")

	create := func(name string) reply {
		return g.expect("POST", g.path("/uploads"), nil, 201, tusHeaders("Upload-Length", "5", "Upload-Metadata", "path "+b64(name))...)
	}
	send := func(url string) reply { return tusPatch(g.client, url, 0, []byte("drop!")) }

	taken := create("existing.txt")
	fresh := create("fresh.txt")
	if a, b := headerShape(taken.header), headerShape(fresh.header); a != b {
		t.Fatalf("POST differs when the name is taken:\n%s\n---\n%s", a, b)
	}
	if a, b := headerShape(send(taken.header.Get("Location")).header), headerShape(send(fresh.header.Get("Location")).header); a != b {
		t.Fatalf("PATCH differs when the name is taken:\n%s\n---\n%s", a, b)
	}
	for _, loc := range []string{taken.header.Get("Location"), fresh.header.Get("Location")} {
		r := g.expect("HEAD", loc, nil, 200, tusHeaders()...)
		if r.header.Get("X-Stored-Path") != "" || r.header.Get("Upload-Offset") != "5" {
			t.Fatalf("HEAD = %v", r.header)
		}
	}
	if s.read("inbox/existing.txt") != "the owner's file" || s.read("inbox/existing (1).txt") != "drop!" {
		t.Fatal("a collision was not resolved privately")
	}

	second := s.openGuest(drop.token())
	for i, c := range []*guest{g, second} {
		url := tusCreate(c.client, c.path("/uploads"), "same.txt", 3)
		tusPatch(c.client, url, 0, []byte(fmt.Sprintf("g%d!", i)))
	}
	a, b := s.read("inbox/same.txt"), s.read("inbox/same (1).txt")
	if !slices.Contains([]string{a, b}, "g0!") || !slices.Contains([]string{a, b}, "g1!") {
		t.Fatalf("two guests lost bytes: %q %q", a, b)
	}

	before, _ := os.ReadDir(filepath.Join(s.root, "inbox"))
	for _, bad := range []string{"sub/x.txt", "../x.txt", "existing.txt/x", "/x.txt", "a\\..\\..", ".storage-server"} {
		r := g.call("POST", g.path("/uploads"), nil, tusHeaders("Upload-Length", "1", "Upload-Metadata", "path "+b64(bad))...)
		if bad == "a\\..\\.." {
			if r.status != 201 {
				t.Fatalf("a backslash is an ordinary name on Linux: %d %s", r.status, r.body)
			}
			continue
		}
		if r.status != 400 {
			t.Fatalf("drop name %q = %d %s", bad, r.status, r.body)
		}
	}
	after, _ := os.ReadDir(filepath.Join(s.root, "inbox"))
	if len(before) != len(after) {
		t.Fatalf("a refused name touched the folder: %d then %d", len(before), len(after))
	}

	other := s.share("inbox", "drop", nil)
	stranger := s.openGuest(other.token())
	stranger.expectError("HEAD", stranger.path("/uploads/"+lastSegment(fresh.header.Get("Location"))), nil, 404, "", tusHeaders()...)

	link := s.share("inbox/existing.txt", "link", nil)
	lg := s.openGuest(link.token())
	lg.expectError("POST", lg.path("/uploads"), nil, 404, "not_found", tusHeaders("Upload-Length", "1", "Upload-Metadata", "path "+b64("x"))...)

	url := tusCreate(g.client, g.path("/uploads"), "held.txt", 4)
	id := s.trash("inbox")
	g.expectError("PATCH", url, "held", 410, "unavailable", tusHeaders("Content-Type", "application/offset+octet-stream", "Upload-Offset", "0")...)
	s.owner.expect("POST", "/api/trash/"+id+"/restore", nil, 200)
	tusPatch(g.client, url, 0, []byte("held"))
	if s.read("inbox/held.txt") != "held" {
		t.Fatal("a drop did not finish after restore")
	}

	limit := 1
	one := s.share("inbox", "drop", map[string]any{"maxUses": limit})
	a1 := s.openGuest(one.token())
	a2 := s.openGuest(one.token())
	url1 := tusCreate(a1.client, a1.path("/uploads"), "limited.txt", 1)
	tusPatch(a1.client, url1, 0, []byte("x"))
	tusCreate(a1.client, a1.path("/uploads"), "limited2.txt", 1)
	a2.expectError("POST", a2.path("/uploads"), nil, 410, "exhausted", tusHeaders("Upload-Length", "1", "Upload-Metadata", "path "+b64("z"))...)
	if got, _ := s.shareByID(one.ID); got.Uses != 1 {
		t.Fatalf("uses = %d", got.Uses)
	}
}

func newRequest(c *client, route, form string) (*http.Response, error) {
	req, err := http.NewRequest("POST", c.base+route, strings.NewReader(form))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	long := *c.http
	long.Timeout = 0
	return long.Do(req)
}

func lastSegment(s string) string { return s[strings.LastIndexByte(s, '/')+1:] }

func verifyZip(t *testing.T, path string) {
	t.Helper()
	py := `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
sys.exit("bad entry %s" % bad if bad else 0)`
	if out, err := exec.Command("python3", "-I", "-c", py, path).CombinedOutput(); err != nil {
		t.Fatalf("python zipfile: %v\n%s", err, out)
	}
	if out, err := exec.Command("7z", "t", path).CombinedOutput(); err != nil {
		t.Fatalf("7z t: %v\n%s", err, out)
	}
}

// TestStreamedZip downloads a folder and verifies with 7z and Python, 5 GiB in the
// long tier, asserts peak RSS stays bounded, and that a read error mid-stream
// aborts the connection. Info-ZIP unzip is expected to fail above 4 GiB, see
// DESIGN.md.
func TestStreamedZip(t *testing.T) {
	s := start(t)
	s.claim()
	size := int64(32 * mib)
	if longTier {
		size = giantSize
	}
	s.write("set/small.txt", "small")
	s.write("set/deep/er/inner.txt", "inner")
	if err := os.MkdirAll(filepath.Join(s.root, "set/empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(s.root, "set/big.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	marker := seeded{seed: 3}.at(0, mib)
	if _, err := f.WriteAt(marker, size-mib); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := os.Symlink("/etc/passwd", filepath.Join(s.root, "set/link")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(s.root, "set/fifo"), 0o644); err != nil {
		t.Fatal(err)
	}

	stream := func(c *client, route, form string) string {
		out := filepath.Join(s.dir, "out.zip")
		w, err := os.Create(out)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		r, err := newRequest(c, route, form)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		if r.StatusCode != 200 || r.Header.Get("Content-Type") != "application/zip" {
			t.Fatalf("zip = %d %v", r.StatusCode, r.Header)
		}
		if r.Header.Get("Content-Security-Policy") != wantCSP || r.Header.Get("Content-Disposition") != "attachment; filename*=UTF-8''set.zip" {
			t.Fatalf("headers = %v", r.Header)
		}
		if r.ContentLength != -1 {
			t.Fatalf("the zip was buffered, Content-Length %d", r.ContentLength)
		}
		if _, err := io.Copy(w, r.Body); err != nil {
			t.Fatal(err)
		}
		return out
	}
	path := stream(s.owner, "/api/files/zip", "path=set")
	verifyZip(t, path)
	r, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	var big *zip.File
	for _, e := range r.File {
		names = append(names, e.Name)
		if e.Name == "set/big.bin" {
			big = e
		}
	}
	slices.Sort(names)
	want := "set/ set/big.bin set/deep/ set/deep/er/ set/deep/er/inner.txt set/empty/ set/small.txt"
	if got := strings.Join(names, " "); got != want {
		t.Fatalf("entries = %q", got)
	}
	if big == nil || big.UncompressedSize64 != uint64(size) {
		t.Fatalf("big entry = %+v", big)
	}
	r.Close()
	s.checkRSS(128 * mib)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	sh := s.share("set", "link", nil)
	g := s.openGuest(sh.token())
	if out := stream(g.client, g.path("/zip"), ""); out == "" {
		t.Fatal("no guest zip")
	}
	guestZip, err := zip.OpenReader(filepath.Join(s.dir, "out.zip"))
	if err != nil {
		t.Fatal(err)
	}
	defer guestZip.Close()
	for _, e := range guestZip.File {
		if strings.HasPrefix(e.Name, "set/") {
			t.Fatalf("a whole-share zip has a leading folder: %s", e.Name)
		}
	}
	verifyZip(t, filepath.Join(s.dir, "out.zip"))
	os.Remove(filepath.Join(s.dir, "out.zip"))

	if os.Geteuid() != 0 {
		s.write("broken/a.txt", strings.Repeat("a", mib))
		s.write("broken/z.txt", "unreadable")
		if err := os.Chmod(filepath.Join(s.root, "broken/z.txt"), 0); err != nil {
			t.Fatal(err)
		}
		resp, err := newRequest(s.owner, "/api/files/zip", "path=broken")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		if _, err := io.Copy(io.Discard, resp.Body); err == nil {
			t.Fatal("a read error ended as a clean response")
		}
	}
	s.owner.expectError("POST", "/api/files/zip", "path=missing", 404, "not_found", "Content-Type", "application/x-www-form-urlencoded")
	s.owner.expectError("POST", "/api/files/zip", "", 400, "invalid_path", "Content-Type", "application/x-www-form-urlencoded")
}
