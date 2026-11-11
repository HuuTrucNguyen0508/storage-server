package server_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

type linkCreated struct {
	Link struct {
		ID            string `json:"id"`
		DownloadCount int    `json:"downloadCount"`
		HasPassword   bool   `json:"hasPassword"`
	} `json:"link"`
	Token string `json:"token"`
	URL   string `json:"url"`
}

func (c *client) link(id string, body map[string]any) linkCreated {
	c.e.t.Helper()
	var l linkCreated
	c.must(c.req("POST", "/api/nodes/"+id+"/links", body), 201).json(&l)
	return l
}

func TestPublicLinkPasswordLimitAndRevoke(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	root := alice.root()
	dir := alice.mkdir(root, "photos")
	f := alice.upload(dir.ID, "a.txt", []byte("public bytes"))
	secret := alice.upload(root, "secret.txt", []byte("not shared"))
	l := alice.link(dir.ID, map[string]any{"kind": "view", "password": "hunter2", "maxDownloads": 2})
	if len(l.Token) < 43 || !strings.HasPrefix(l.URL, origin+"/s/") {
		t.Fatalf("token %q url %q", l.Token, l.URL)
	}
	p := "/api/public/" + l.Token

	g := e.guest()
	var info struct {
		Link struct {
			RequiresPassword bool `json:"requiresPassword"`
			Unlocked         bool `json:"unlocked"`
		} `json:"link"`
		Node *node `json:"node"`
	}
	g.must(g.get(p), 200).json(&info)
	if !info.Link.RequiresPassword || info.Link.Unlocked || info.Node != nil {
		t.Fatalf("locked info: %+v", info)
	}
	g.must(g.get(p+"/nodes/"+dir.ID+"/children"), 401)
	g.must(g.get(p+"/nodes/"+f.ID+"/content"), 401)
	// A forged identity header changes nothing on public routes.
	g.must(g.get(p+"/nodes/"+f.ID+"/content", "Remote-User", "alice", "Remote-Groups", "users,admins"), 401)
	g.must(g.req("POST", p+"/unlock", map[string]any{"password": "wrong"}), 401)
	g.must(g.req("POST", p+"/unlock", map[string]any{"password": "hunter2"}), 200)
	g.must(g.get(p), 200).json(&info)
	if !info.Link.Unlocked || info.Node == nil || info.Node.ID != dir.ID {
		t.Fatalf("unlocked info: %+v", info)
	}
	if got := names(g.children2(p, dir.ID)); len(got) != 1 || got[0] != "a.txt" {
		t.Fatalf("guest listing: %v", got)
	}
	// Nothing outside the linked folder is reachable.
	g.must(g.get(p+"/nodes/"+secret.ID+"/content"), 404)
	g.must(g.get(p+"/nodes/"+root+"/children"), 404)
	// Previews of a kind the viewer shows do not count; downloads do; a
	// resumed range does not.
	if body := g.must(g.get(p+"/nodes/"+f.ID+"/raw"), 200).Body; string(body) != "public bytes" {
		t.Fatalf("guest preview %q", body)
	}
	if body := g.must(g.get(p+"/nodes/"+f.ID+"/content"), 200).Body; string(body) != "public bytes" {
		t.Fatalf("guest download %q", body)
	}
	g.must(g.get(p+"/nodes/"+f.ID+"/content", "Range", "bytes=3-"), 206)
	g.must(g.get(p+"/zip"), 200)
	// Limit of 2 reached: the link is gone for everything.
	g.must(g.get(p+"/nodes/"+f.ID+"/content"), 410)
	g.must(g.get(p), 410)
	var links struct {
		Items []struct {
			ID            string `json:"id"`
			Status        string `json:"status"`
			DownloadCount int    `json:"downloadCount"`
		}
	}
	alice.must(alice.get("/api/links"), 200).json(&links)
	if links.Items[0].DownloadCount != 2 || links.Items[0].Status != "exhausted" {
		t.Fatalf("link list: %+v", links.Items)
	}
	// The response never includes the token or the hash.
	if b := string(alice.get("/api/links").Body); strings.Contains(b, l.Token) || strings.Contains(b, "argon2") {
		t.Fatalf("link list leaks secrets: %s", b)
	}

	// Revocation takes effect on the next request.
	l2 := alice.link(f.ID, map[string]any{"kind": "view"})
	g2 := e.guest()
	g2.must(g2.get("/api/public/"+l2.Token+"/nodes/"+f.ID+"/content"), 200)
	alice.must(alice.req("DELETE", "/api/links/"+l2.Link.ID, nil), 204)
	g2.must(g2.get("/api/public/"+l2.Token+"/nodes/"+f.ID+"/content"), 404)
	g2.must(g2.get("/api/public/"+l2.Token), 404)

	// Activity shows the link download.
	var act struct {
		Items []struct{ Action, Actor string }
	}
	alice.must(alice.get("/api/nodes/"+f.ID+"/activity"), 200).json(&act)
	found := false
	for _, a := range act.Items {
		found = found || a.Action == "downloaded_by_link"
	}
	if !found {
		t.Fatalf("activity: %+v", act.Items)
	}
}

func (c *client) children2(prefix, id string) []node {
	c.e.t.Helper()
	var out struct{ Items []node }
	c.must(c.get(prefix+"/nodes/"+id+"/children"), 200).json(&out)
	return out.Items
}

func TestPublicLinkExpiryAndUnknownTokens(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	f := alice.upload(alice.root(), "x.txt", []byte("x"))
	alice.must(alice.req("POST", "/api/nodes/"+f.ID+"/links", map[string]any{"kind": "view", "expiresAt": time.Now().Add(-time.Hour)}), 400)
	l := alice.link(f.ID, map[string]any{"kind": "view", "expiresAt": time.Now().Add(time.Hour)})
	g := e.guest()
	g.must(g.get("/api/public/"+l.Token+"/nodes/"+f.ID+"/content"), 200)
	if _, err := e.st.Pool.Exec(context.Background(), "UPDATE links SET expires_at = now() - interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	g.must(g.get("/api/public/"+l.Token+"/nodes/"+f.ID+"/content"), 410)
	for _, tok := range []string{"short", strings.Repeat("A", 43), l.Token + "x", strings.ToUpper(l.Token)} {
		if r := g.get("/api/public/" + tok); r.Status != 404 {
			t.Errorf("token %q: %d", tok, r.Status)
		}
	}
	// The guest page is served for any token; the SPA asks the API.
	page := g.must(g.get("/s/"+l.Token), 200)
	if page.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("share page referrer policy %q", page.Header.Get("Referrer-Policy"))
	}
	if !strings.Contains(page.Header.Get("Content-Security-Policy"), "script-src 'self'") {
		t.Fatalf("share page CSP %q", page.Header.Get("Content-Security-Policy"))
	}
	// /s/ never falls through to the private app, even with a forged identity.
	r := g.get("/s/"+l.Token+"/../../api/me", "Remote-User", "alice", "Remote-Groups", "users")
	if r.Status == 200 && strings.Contains(string(r.Body), "rootId") {
		t.Fatalf("path traversal reached the private API: %s", r.Body)
	}
	g.must(g.get("/api/public/"+l.Token+"/me", "Remote-User", "alice", "Remote-Groups", "users"), 404)
}

func TestLinkPasswordRateLimit(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	f := alice.upload(alice.root(), "x.txt", []byte("x"))
	l := alice.link(f.ID, map[string]any{"kind": "view", "password": "correct horse"})
	g := e.guest()
	for i := 0; i < 10; i++ {
		g.must(g.req("POST", "/api/public/"+l.Token+"/unlock", map[string]any{"password": "nope"}), 401)
	}
	r := g.must(g.req("POST", "/api/public/"+l.Token+"/unlock", map[string]any{"password": "correct horse"}), 429)
	if r.Header.Get("Retry-After") == "" {
		t.Fatal("no Retry-After")
	}
	// Another link from the same client still works until the per-client
	// limit (30 failures across links) is reached.
	for i := 0; i < 2; i++ {
		li := alice.link(f.ID, map[string]any{"kind": "view", "password": "pw"})
		if i == 0 {
			g.must(g.req("POST", "/api/public/"+li.Token+"/unlock", map[string]any{"password": "pw"}), 200)
		}
		for j := 0; j < 10; j++ {
			g.must(g.req("POST", "/api/public/"+li.Token+"/unlock", map[string]any{"password": "bad"}), 401)
		}
	}
	l3 := alice.link(f.ID, map[string]any{"kind": "view", "password": "pw3"})
	g.must(g.req("POST", "/api/public/"+l3.Token+"/unlock", map[string]any{"password": "pw3"}), 429)
	// A different client is not affected.
	g2 := e.guest()
	g2.must(g2.req("POST", "/api/public/"+l3.Token+"/unlock", map[string]any{"password": "pw3"}, "X-Real-Ip", "203.0.113.9"), 200)
	if e.metric(`storage_link_unlock_attempts_total{result="limited"}`) < 2 {
		t.Fatal("limited attempts not counted")
	}
}

func TestDropLinkUploadsWithoutSeeing(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	inbox := alice.mkdir(alice.root(), "Inbox")
	existing := alice.upload(inbox.ID, "private.txt", []byte("hidden"))
	alice.must(alice.req("POST", "/api/nodes/"+existing.ID+"/links", map[string]any{"kind": "drop"}), 400)
	l := alice.link(inbox.ID, map[string]any{"kind": "drop"})
	g := e.guest()
	p := "/api/public/" + l.Token
	var info struct {
		Link struct{ Kind string } `json:"link"`
		Node map[string]any        `json:"node"`
	}
	g.must(g.get(p), 200).json(&info)
	if info.Link.Kind != "drop" || info.Node["name"] != "Inbox" {
		t.Fatalf("drop info: %+v", info)
	}
	g.must(g.get(p+"/nodes/"+inbox.ID+"/children"), 404)
	g.must(g.get(p+"/nodes/"+existing.ID+"/content"), 404)
	g.must(g.get(p+"/zip"), 404)
	// The guest cannot choose another folder: parentId is ignored.
	n := g.uploadTo(p, alice.root(), "", "private.txt", []byte("from a guest"))
	if n.Name != "private (1).txt" {
		t.Fatalf("guest upload name %q", n.Name)
	}
	got := names(alice.children(inbox.ID))
	if strings.Join(got, ",") != "private (1).txt,private.txt" {
		t.Fatalf("inbox: %v", got)
	}
	// A view link cannot upload.
	vl := alice.link(inbox.ID, map[string]any{"kind": "view"})
	g.must(g.req("POST", "/api/public/"+vl.Token+"/uploads", map[string]any{"name": "x", "size": 1}), 404)
	if r := g.req("POST", p+"/uploads", map[string]any{"name": "y.txt", "size": 1}, "Origin", "https://pdf.lab.localhost"); r.Status != http.StatusForbidden {
		t.Fatalf("cross-origin guest upload: %d", r.Status)
	}
}

func TestLinkRangeAccounting(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	f := alice.upload(alice.root(), "range.txt", []byte("abcdef"))
	for _, rg := range []string{"bytes=00-", "bytes=-6", "bytes=0-0,1-", "bytes=1-"} {
		t.Run(rg, func(t *testing.T) {
			l := alice.link(f.ID, map[string]any{"kind": "view", "maxDownloads": 1})
			p := "/api/public/" + l.Token + "/nodes/" + f.ID + "/content"
			g := e.guest()
			headers := []string{"Range", rg}
			// A stale If-Range makes ServeContent ignore Range and send the whole file.
			if rg == "bytes=1-" {
				headers = append(headers, "If-Range", `"stale"`)
			}
			r := g.get(p, headers...)
			if r.Status != 200 && r.Status != 206 {
				t.Fatalf("download status %d", r.Status)
			}
			g.must(g.get(p), 410)
		})
	}
}

func TestLinkHeadDoesNotConsumeDownload(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	f := alice.upload(alice.root(), "head.txt", []byte("abcdef"))
	l := alice.link(f.ID, map[string]any{"kind": "view", "maxDownloads": 1})
	p := "/api/public/" + l.Token + "/nodes/" + f.ID + "/content"
	g := e.guest()
	g.must(g.req("HEAD", p, nil), 200)
	g.must(g.get(p), 200)
	g.must(g.get(p), 410)
}

// The public /raw endpoint serves only kinds the guest viewer reads through
// it, so a download limit can't be skipped by fetching a file as a preview.
func TestPublicRawOnlyServesViewableKinds(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	root := alice.root()
	dir := alice.mkdir(root, "shared")
	ids := map[string]string{}
	for _, name := range []string{"payload.bin", "setup.exe", "report.docx", "bundle.zip", "scan.tiff", "clip.mp4", "notes.md", "paper.pdf", "photo.png"} {
		ids[name] = alice.upload(dir.ID, name, []byte("bytes of "+name)).ID
	}
	l := alice.link(dir.ID, map[string]any{"kind": "view", "maxDownloads": 2})
	p := "/api/public/" + l.Token
	g := e.guest()
	// Office files preview through office-preview, ZIPs through archive, and
	// the rest have no viewer: /raw refuses them.
	for _, name := range []string{"payload.bin", "setup.exe", "report.docx", "bundle.zip", "scan.tiff"} {
		g.must(g.get(p+"/nodes/"+ids[name]+"/raw"), http.StatusNotFound)
		g.must(g.get(p+"/nodes/"+ids[name]+"/raw", "Range", "bytes=0-"), http.StatusNotFound)
	}
	// What the viewer shows stays free, however often it is viewed.
	for range 3 {
		for _, name := range []string{"clip.mp4", "notes.md", "paper.pdf", "photo.png"} {
			if body := g.must(g.get(p+"/nodes/"+ids[name]+"/raw"), 200).Body; string(body) != "bytes of "+name {
				t.Fatalf("%s preview %q", name, body)
			}
		}
	}
	// The unviewable file is still a download, and it counts.
	if body := g.must(g.get(p+"/nodes/"+ids["payload.bin"]+"/content"), 200).Body; string(body) != "bytes of payload.bin" {
		t.Fatalf("download %q", body)
	}
	var links struct {
		Items []struct {
			DownloadCount int `json:"downloadCount"`
		}
	}
	alice.must(alice.get("/api/links"), 200).json(&links)
	if len(links.Items) != 1 || links.Items[0].DownloadCount != 1 {
		t.Fatalf("download count: %+v", links.Items)
	}
	// The signed-in viewer endpoint is unchanged.
	r := alice.must(alice.get("/api/nodes/"+ids["payload.bin"]+"/raw"), 200)
	if r.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("owner raw type %q", r.Header.Get("Content-Type"))
	}
}
