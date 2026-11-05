package server_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// User B must not be able to see or touch anything of user A's.
func TestOtherUsersCannotReachMyFiles(t *testing.T) {
	e := newEnv(t)
	alice, bob := e.as("alice"), e.as("bob")
	root := alice.root()
	bob.root()
	folder := alice.mkdir(root, "private")
	file := alice.upload(folder.ID, "secret.txt", []byte("alice's secret"))
	img := alice.upload(folder.ID, "pic.png", pngBytes(t))
	zipf := alice.upload(folder.ID, "a.zip", zipBytes(t, map[string]string{"x.txt": "x"}))
	doc := alice.upload(folder.ID, "doc.docx", []byte("not really a docx"))
	bobDir := bob.mkdir(bob.root(), "mine")

	for _, id := range []string{folder.ID, file.ID, img.ID, zipf.ID, doc.ID, root} {
		for _, r := range []*resp{
			bob.get("/api/nodes/" + id),
			bob.get("/api/nodes/" + id + "/children"),
			bob.get("/api/nodes/" + id + "/content"),
			bob.get("/api/nodes/" + id + "/raw"),
			bob.get("/api/nodes/"+id+"/raw", "Range", "bytes=0-3"),
			bob.get("/api/nodes/" + id + "/thumbnail"),
			bob.get("/api/nodes/" + id + "/office-preview"),
			bob.get("/api/nodes/" + id + "/archive"),
			bob.get("/api/nodes/" + id + "/activity"),
			bob.get("/api/nodes/" + id + "/shares"),
			bob.get("/api/nodes/" + id + "/links"),
			bob.get("/api/zip?id=" + id),
			bob.req("PATCH", "/api/nodes/"+id, map[string]any{"name": "pwned"}),
			bob.req("PATCH", "/api/nodes/"+id, map[string]any{"parentId": bobDir.ID}),
			bob.req("DELETE", "/api/nodes/"+id, nil),
			bob.req("POST", "/api/nodes/trash", map[string]any{"ids": []string{id}}),
			bob.req("POST", "/api/nodes/copy", map[string]any{"ids": []string{id}, "parentId": bobDir.ID}),
			bob.req("POST", "/api/nodes/move", map[string]any{"ids": []string{id}, "parentId": bobDir.ID}),
			bob.req("POST", "/api/nodes/move", map[string]any{"ids": []string{bobDir.ID}, "parentId": id}),
			bob.req("POST", "/api/folders", map[string]any{"parentId": id, "name": "x"}),
			bob.req("POST", "/api/uploads", map[string]any{"parentId": id, "name": "x.txt", "size": 1}),
			bob.req("POST", "/api/nodes/"+id+"/shares", map[string]any{"username": "bob", "permission": "edit"}),
			bob.req("POST", "/api/nodes/"+id+"/links", map[string]any{"kind": "view"}),
			bob.req("PUT", "/api/nodes/"+id+"/star", nil),
			bob.req("POST", "/api/trash/"+id+"/restore", nil),
			bob.req("DELETE", "/api/trash/"+id, nil),
		} {
			if r.Status != http.StatusNotFound {
				t.Errorf("bob on alice's %s: status %d, want 404: %s", id, r.Status, r.Body)
			}
			if strings.Contains(string(r.Body), "alice's secret") {
				t.Fatalf("leaked content: %s", r.Body)
			}
		}
	}
	// Nothing changed for alice.
	if got := names(alice.children(folder.ID)); strings.Join(got, ",") != "a.zip,doc.docx,pic.png,secret.txt" {
		t.Fatalf("alice's folder changed: %v", got)
	}
	// Bob's search, recent and starred lists never show alice's files.
	for _, p := range []string{"/api/search?q=secret", "/api/recent", "/api/starred", "/api/shared"} {
		if body := string(bob.must(bob.get(p), 200).Body); strings.Contains(body, "secret") {
			t.Errorf("%s leaked alice's file: %s", p, body)
		}
	}
	// Bob cannot touch alice's upload sessions either.
	var up struct{ Upload struct{ ID string } }
	alice.must(alice.req("POST", "/api/uploads", map[string]any{"parentId": folder.ID, "name": "big.bin", "size": 10}), 201).json(&up)
	bob.must(bob.get("/api/uploads/"+up.Upload.ID), 404)
	bob.must(bob.req("PUT", "/api/uploads/"+up.Upload.ID, []byte("0123456789"), "Upload-Offset", "0"), 404)
	bob.must(bob.req("DELETE", "/api/uploads/"+up.Upload.ID, nil), 404)
}

func TestReadShareCannotModifyAndEditShareCan(t *testing.T) {
	e := newEnv(t)
	alice, bob, carol := e.as("alice"), e.as("bob"), e.as("carol")
	root := alice.root()
	shared := alice.mkdir(root, "Holiday")
	sub := alice.mkdir(shared.ID, "day1")
	f := alice.upload(sub.ID, "beach.txt", []byte("sand"))
	alice.must(alice.req("POST", "/api/nodes/"+shared.ID+"/shares", map[string]any{"username": "bob", "permission": "read"}), 201)

	// Bob sees it under "Shared with me" and can browse and download.
	var sh struct{ Items []node }
	bob.must(bob.get("/api/shared"), 200).json(&sh)
	if len(sh.Items) != 1 || sh.Items[0].ID != shared.ID || sh.Items[0].Permission != "read" {
		t.Fatalf("shared with bob: %+v", sh.Items)
	}
	if got := names(bob.children(sub.ID)); len(got) != 1 || got[0] != "beach.txt" {
		t.Fatalf("bob browse: %v", got)
	}
	if body := bob.must(bob.get("/api/nodes/"+f.ID+"/content"), 200).Body; string(body) != "sand" {
		t.Fatalf("bob download: %q", body)
	}
	// Breadcrumbs stop at the shared folder.
	var meta struct {
		Crumbs     []struct{ ID, Name string }
		Permission string
	}
	bob.must(bob.get("/api/nodes/"+f.ID), 200).json(&meta)
	if meta.Crumbs[0].ID != shared.ID || meta.Permission != "read" {
		t.Fatalf("bob crumbs: %+v", meta)
	}
	// Read cannot modify anything.
	bobRoot := bob.root()
	for _, r := range []*resp{
		bob.req("PATCH", "/api/nodes/"+f.ID, map[string]any{"name": "x.txt"}),
		bob.req("DELETE", "/api/nodes/"+f.ID, nil),
		bob.req("DELETE", "/api/nodes/"+sub.ID, nil),
		bob.req("POST", "/api/nodes/trash", map[string]any{"ids": []string{f.ID}}),
		bob.req("POST", "/api/folders", map[string]any{"parentId": sub.ID, "name": "new"}),
		bob.req("POST", "/api/uploads", map[string]any{"parentId": sub.ID, "name": "n.txt", "size": 3}),
		bob.req("POST", "/api/nodes/move", map[string]any{"ids": []string{f.ID}, "parentId": shared.ID}),
		bob.req("POST", "/api/nodes/copy", map[string]any{"ids": []string{f.ID}, "parentId": sub.ID}),
	} {
		if r.Status != http.StatusForbidden {
			t.Errorf("read share modified: %d %s", r.Status, r.Body)
		}
	}
	// Owner-only operations stay hidden from a reader.
	bob.must(bob.req("POST", "/api/nodes/"+f.ID+"/links", map[string]any{"kind": "view"}), 403)
	bob.must(bob.req("POST", "/api/nodes/"+shared.ID+"/shares", map[string]any{"username": "carol", "permission": "read"}), 403)
	bob.must(bob.get("/api/nodes/"+f.ID+"/activity"), 403)
	// Bob may copy shared files into his own space.
	bob.must(bob.req("POST", "/api/nodes/copy", map[string]any{"ids": []string{f.ID}, "parentId": bobRoot}), 201)
	// Carol, who has no share, sees nothing.
	carol.must(carol.get("/api/nodes/"+f.ID), 404)

	// Upgrade to edit: uploads, renames and deletes inside work, and count
	// against alice's quota; the shared folder itself stays alice's.
	alice.must(alice.req("POST", "/api/nodes/"+shared.ID+"/shares", map[string]any{"username": "bob", "permission": "edit"}), 201)
	n := bob.upload(sub.ID, "bob.txt", []byte("hello from bob"))
	if n.Owner != "alice" {
		t.Fatalf("upload by editor should belong to the folder owner, got %q", n.Owner)
	}
	bob.must(bob.req("PATCH", "/api/nodes/"+n.ID, map[string]any{"name": "renamed.txt"}), 200)
	bob.must(bob.req("POST", "/api/folders", map[string]any{"parentId": shared.ID, "name": "day2"}), 201)
	bob.must(bob.req("DELETE", "/api/nodes/"+f.ID, nil), 204)
	bob.must(bob.req("DELETE", "/api/nodes/"+shared.ID, nil), 403)
	bob.must(bob.req("PATCH", "/api/nodes/"+shared.ID, map[string]any{"name": "Mine now"}), 403)
	// Moving across spaces is refused.
	bob.must(bob.req("POST", "/api/nodes/move", map[string]any{"ids": []string{n.ID}, "parentId": bobRoot}), 400)
	var me struct{ Usage struct{ UsedBytes int64 } }
	alice.must(alice.get("/api/me"), 200).json(&me)
	if me.Usage.UsedBytes != int64(len("sand")+len("hello from bob")) {
		t.Fatalf("alice usage %d", me.Usage.UsedBytes)
	}
	// The trashed file lands in alice's trash.
	var tr struct{ Items []node }
	alice.must(alice.get("/api/trash"), 200).json(&tr)
	if len(tr.Items) != 1 || tr.Items[0].ID != f.ID {
		t.Fatalf("alice trash: %+v", tr.Items)
	}
	// Removing the share takes access away at once.
	var shares struct {
		Items []struct{ ID, Username string }
	}
	alice.must(alice.get("/api/nodes/"+shared.ID+"/shares"), 200).json(&shares)
	alice.must(alice.req("DELETE", "/api/shares/"+shares.Items[0].ID, nil), 204)
	bob.must(bob.get("/api/nodes/"+sub.ID+"/children"), 404)
}

func TestShareWithSomeoneWhoNeverSignedIn(t *testing.T) {
	e := newEnv(t)
	alice := e.as("alice")
	d := alice.mkdir(alice.root(), "for dave")
	alice.must(alice.req("POST", "/api/nodes/"+d.ID+"/shares", map[string]any{"username": "Dave", "permission": "read"}), 201)
	alice.must(alice.req("POST", "/api/nodes/"+d.ID+"/shares", map[string]any{"username": "no spaces", "permission": "read"}), 400)
	alice.must(alice.req("POST", "/api/nodes/"+d.ID+"/shares", map[string]any{"username": "alice", "permission": "read"}), 400)
	alice.must(alice.req("POST", "/api/nodes/"+d.ID+"/shares", map[string]any{"username": "erin", "permission": "admin"}), 400)
	dave := e.as("dave")
	var sh struct{ Items []node }
	dave.must(dave.get("/api/shared"), 200).json(&sh)
	if len(sh.Items) != 1 || sh.Items[0].Name != "for dave" {
		t.Fatalf("dave shared: %+v", sh.Items)
	}
}

func TestIdentityHeadersRequired(t *testing.T) {
	e := newEnv(t)
	g := e.guest()
	g.must(g.get("/api/me"), 401)
	g.must(g.get("/"), 401)
	stranger := e.as("mallory")
	stranger.groups = "visitors"
	stranger.must(stranger.get("/api/me"), 403)
	// Admin endpoints need the admins group.
	alice := e.as("alice")
	alice.must(alice.get("/api/admin/users"), 403)
	alice.must(alice.get("/api/admin/links"), 403)
	admin := e.as("admin")
	var users struct {
		Items []struct {
			ID         int64  `json:"id"`
			Username   string `json:"username"`
			QuotaBytes int64  `json:"quotaBytes"`
			UsedBytes  int64  `json:"usedBytes"`
		}
	}
	alice.upload(alice.root(), "a.txt", []byte("12345"))
	admin.must(admin.get("/api/admin/users"), 200).json(&users)
	var aliceID int64
	for _, u := range users.Items {
		if u.Username == "alice" {
			aliceID = u.ID
			if u.UsedBytes != 5 {
				t.Fatalf("admin sees alice usage %d", u.UsedBytes)
			}
		}
	}
	alice.must(alice.req("PATCH", "/api/admin/users/1", map[string]any{"quotaBytes": 1}), 403)
	admin.must(admin.req("PATCH", "/api/admin/users/"+itoa(aliceID), map[string]any{"quotaBytes": 1000}), 204)
	var me struct{ Usage struct{ QuotaBytes int64 } }
	alice.must(alice.get("/api/me"), 200).json(&me)
	if me.Usage.QuotaBytes != 1000 {
		t.Fatalf("quota after admin change: %d", me.Usage.QuotaBytes)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
