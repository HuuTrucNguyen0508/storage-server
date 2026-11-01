//go:build harness

package harness

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"storage-server/internal/crash"
)

const payload = "the payload a guest was promised"

type scene struct {
	s          *server
	file, dir  share
	trashID    string
	uploadURL  string
	uploadBody []byte
}

func newScene(t *testing.T, env ...string) *scene {
	t.Helper()
	s := startBin(t, crashBin, env...)
	s.claim()
	s.write("dir/file.txt", payload)
	s.write("elsewhere/keep.txt", "unrelated")
	return &scene{s: s, file: s.share("dir/file.txt", "link", nil), dir: s.share("dir", "link", nil)}
}

func (c *scene) request(act func()) {
	c.s.t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { recover() }()
		act()
	}()
	c.s.waitDied()
	<-done
}

func (c *scene) post(path string, in any) {
	c.s.owner.do("POST", path, in)
}

func (c *scene) snapshot() string {
	s := c.s
	s.t.Helper()
	var lines []string
	filepath.WalkDir(s.root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(s.root, p)
		if d.Type().IsRegular() {
			info, _ := d.Info()
			lines = append(lines, fmt.Sprintf("%s %d", rel, info.Size()))
		} else {
			lines = append(lines, rel+"/")
		}
		return nil
	})
	for _, sh := range s.shares() {
		lines = append(lines, fmt.Sprintf("share %s %s %s %d", sh.ID, sh.Path, sh.State, sh.Uses))
	}
	for _, it := range s.trashItems() {
		lines = append(lines, "trash "+it.ID+" "+it.OriginalPath)
	}
	slices.Sort(lines)
	return strings.Join(lines, "\n")
}

func (c *scene) converge() {
	s := c.s
	s.t.Helper()
	s.restart()
	first := c.snapshot()
	s.restart()
	if second := c.snapshot(); first != second {
		s.t.Fatalf("a second recovery changed the state:\n%s\n---\n%s", first, second)
	}
	if n := s.journal(); n != 0 {
		s.t.Fatalf("%d journal rows after recovery", n)
	}
	for _, it := range s.trashItems() {
		dir := filepath.Join(s.root, ".storage-server/trash", it.ID)
		for _, name := range []string{"meta.json", "item"} {
			if _, err := os.Lstat(filepath.Join(dir, name)); err != nil {
				s.t.Fatalf("listed trash item lacks %s", name)
			}
		}
	}
}

func (c *scene) linkServes(name string) {
	s := c.s
	s.t.Helper()
	if got := s.fetch(c.file.token()); got != payload {
		s.t.Fatalf("file link serves %q", got)
	}
	g := s.openGuest(c.dir.token())
	if got := string(g.expect("GET", g.path("/content?path="+name), nil, 200).body); got != payload {
		s.t.Fatalf("folder link serves %q", got)
	}
}

func (c *scene) linksSuspended() {
	s := c.s
	s.t.Helper()
	for _, sh := range []share{c.file, c.dir} {
		s.guest(sh.token()).expectError("POST", "/api/public/"+sh.token()+"/open", nil, 410, "unavailable")
		if got, ok := s.shareByID(sh.ID); !ok || got.State != "suspended" {
			s.t.Fatalf("share = %+v, %v", got, ok)
		}
	}
}

func (c *scene) renameFile() {
	if c.s.exists("dir/file.txt") {
		c.s.owner.expect("POST", "/api/files/rename", map[string]string{"path": "dir/file.txt", "name": "renamed.txt"}, 200)
	}
}

func (c *scene) moveFile() {
	if c.s.exists("dir/file.txt") {
		c.s.owner.expect("POST", "/api/files/move", map[string]any{"paths": []string{"dir/file.txt"}, "to": "elsewhere"}, 200)
	}
}

func (c *scene) trashDir() {
	if c.s.exists("dir") {
		c.s.trash("dir")
	}
}

func (c *scene) restoreDir() {
	if items := c.s.trashItems(); len(items) == 1 {
		c.s.owner.expect("POST", "/api/trash/"+items[0].ID+"/restore", nil, 200)
	}
}

func (c *scene) purgeDir() {
	if items := c.s.trashItems(); len(items) == 1 {
		c.s.owner.expect("DELETE", "/api/trash/"+items[0].ID, nil, 204)
	}
}

func spoolEntries(s *server) []string {
	entries, _ := os.ReadDir(filepath.Join(s.root, ".storage-server/spool"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

type crashCase struct {
	name    string
	arrange func(c *scene)
	act     func(c *scene)
	finish  func(c *scene)
	points  []crash.Point
}

var movePoints = []crash.Point{crash.MoveAfterIntent, crash.MoveAfterRename, crash.MoveAfterCommit}

func crashCases() []crashCase {
	return []crashCase{
		{
			name: "rename",
			act: func(c *scene) {
				c.post("/api/files/rename", map[string]string{"path": "dir/file.txt", "name": "renamed.txt"})
			},
			finish: func(c *scene) { c.renameFile(); c.linkServes("renamed.txt") },
			points: movePoints,
		},
		{
			name: "move",
			act: func(c *scene) {
				c.post("/api/files/move", map[string]any{"paths": []string{"dir/file.txt"}, "to": "elsewhere"})
			},
			finish: func(c *scene) {
				c.moveFile()
				if got := c.s.fetch(c.file.token()); got != payload {
					c.s.t.Fatalf("file link serves %q", got)
				}
			},
			points: movePoints,
		},
		{
			name: "trash",
			act:  func(c *scene) { c.post("/api/files/trash", map[string]any{"paths": []string{"dir"}}) },
			finish: func(c *scene) {
				c.trashDir()
				c.linksSuspended()
				c.restoreDir()
				c.linkServes("file.txt")
			},
			points: append([]crash.Point{crash.TrashAfterMeta}, movePoints...),
		},
		{
			name:    "restore",
			arrange: func(c *scene) { c.trashID = c.s.trash("dir") },
			act:     func(c *scene) { c.post("/api/trash/"+c.trashID+"/restore", nil) },
			finish: func(c *scene) {
				c.restoreDir()
				c.linkServes("file.txt")
				entries, _ := os.ReadDir(filepath.Join(c.s.root, ".storage-server/trash"))
				if len(entries) != 0 {
					c.s.t.Fatalf("trash still holds %v", entries)
				}
			},
			points: append([]crash.Point{crash.RestoreAfterCommit}, movePoints...),
		},
		{
			name: "purge",
			arrange: func(c *scene) {
				c.s.write("dir/a.txt", "a")
				c.s.write("dir/b.txt", "b")
				c.trashID = c.s.trash("dir")
			},
			act: func(c *scene) { c.s.owner.do("DELETE", "/api/trash/"+c.trashID, nil) },
			finish: func(c *scene) {
				c.purgeDir()
				if items := c.s.trashItems(); len(items) != 0 {
					c.s.t.Fatalf("still listed: %+v", items)
				}
				if got := c.s.shares(); len(got) != 0 {
					c.s.t.Fatalf("shares survived a purge: %+v", got)
				}
				entries, _ := os.ReadDir(filepath.Join(c.s.root, ".storage-server/trash"))
				if len(entries) != 0 {
					c.s.t.Fatalf("trash still holds %v", entries)
				}
			},
			points: []crash.Point{crash.PurgeAfterMeta, crash.PurgeAfterShares, crash.PurgeMidRemove},
		},
		{
			name: "upload creation",
			act: func(c *scene) {
				c.s.owner.do("POST", "/api/uploads", nil, tusHeaders("Upload-Length", "5", "Upload-Metadata", "path "+b64("up.bin"))...)
			},
			finish: func(c *scene) {
				if c.s.exists("up.bin") {
					c.s.t.Fatal("a partial upload is in the tree")
				}
				if got := c.s.upload("up.bin", "bytes"); got != "up.bin" {
					c.s.t.Fatalf("retry stored %q", got)
				}
			},
			points: []crash.Point{crash.UploadAfterCreate},
		},
		{
			name: "upload bytes",
			arrange: func(c *scene) {
				c.uploadBody = seeded{seed: 9}.at(0, 3*mib)
				c.uploadURL = tusCreate(c.s.owner, "/api/uploads", "up.bin", int64(len(c.uploadBody)))
			},
			act: func(c *scene) {
				c.s.owner.do("PATCH", c.uploadURL, c.uploadBody, tusHeaders("Content-Type", "application/offset+octet-stream", "Upload-Offset", "0")...)
			},
			finish: func(c *scene) {
				offset := tusOffset(c.s.owner, c.uploadURL)
				if c.s.exists("up.bin") && offset != int64(len(c.uploadBody)) {
					c.s.t.Fatal("a partial upload is in the tree")
				}
				if offset < int64(len(c.uploadBody)) {
					tusPatch(c.s.owner, c.uploadURL, offset, c.uploadBody[offset:])
				}
				if got := c.s.read("up.bin"); got != string(c.uploadBody) {
					c.s.t.Fatalf("up.bin holds %d bytes, want %d intact", len(got), len(c.uploadBody))
				}
				if c.s.exists("up (1).bin") {
					c.s.t.Fatal("a redone publish stored the upload twice")
				}
				r := c.s.owner.expect("HEAD", c.uploadURL, nil, 200, tusHeaders()...)
				if r.header.Get("X-Stored-Path") != "up.bin" {
					c.s.t.Fatalf("X-Stored-Path = %q", r.header.Get("X-Stored-Path"))
				}
			},
			points: []crash.Point{crash.UploadMidAppend, crash.UploadAfterSync, crash.UploadAfterIntent, crash.UploadAfterPublish},
		},
	}
}

func TestCrashMatrix(t *testing.T) {
	covered := map[crash.Point]bool{}
	for _, tc := range crashCases() {
		for _, point := range tc.points {
			covered[point] = true
			t.Run(tc.name+"/"+string(point), func(t *testing.T) {
				c := newScene(t)
				if tc.arrange != nil {
					tc.arrange(c)
				}
				c.s.restart("CRASH_AT=" + string(point))
				c.request(func() { tc.act(c) })
				c.s.env = nil
				c.converge()
				tc.finish(c)
			})
		}
	}
	for _, p := range crash.All {
		if !covered[p] {
			t.Errorf("no scenario reaches crash point %s", p)
		}
	}
}

func journaledMove(t *testing.T, point crash.Point) *scene {
	t.Helper()
	c := newScene(t)
	c.s.restart("CRASH_AT=" + string(point))
	c.request(func() {
		c.post("/api/files/rename", map[string]string{"path": "dir/file.txt", "name": "renamed.txt"})
	})
	c.s.env = nil
	if n := c.s.journal(); n != 1 {
		t.Fatalf("journal holds %d rows after the crash", n)
	}
	return c
}

func TestRecoveryByIdentity(t *testing.T) {
	t.Run("the destination holds the inode, so the move commits", func(t *testing.T) {
		c := journaledMove(t, crash.MoveAfterRename)
		c.s.restart()
		if n := c.s.journal(); n != 0 {
			t.Fatalf("journal = %d", n)
		}
		if got, _ := c.s.shareByID(c.file.ID); got.Path != "dir/renamed.txt" {
			t.Fatalf("share = %+v", got)
		}
		c.linkServes("renamed.txt")
	})
	t.Run("a stranger at the destination does not capture the link", func(t *testing.T) {
		c := journaledMove(t, crash.MoveAfterIntent)
		c.s.write("dir/renamed.txt", "PRIVATE upload that appeared at the destination")
		c.s.restart()
		if n := c.s.journal(); n != 0 {
			t.Fatalf("journal = %d", n)
		}
		if got := c.s.fetch(c.file.token()); got != payload {
			t.Fatalf("the link now serves %q", got)
		}
		if got, _ := c.s.shareByID(c.file.ID); got.Path != "dir/file.txt" {
			t.Fatalf("share = %+v", got)
		}
	})
	t.Run("both paths replaced means the link is deleted", func(t *testing.T) {
		c := journaledMove(t, crash.MoveAfterIntent)
		src := filepath.Join(c.s.root, "dir/file.txt")
		if err := os.Remove(src); err != nil {
			t.Fatal(err)
		}
		c.s.write("dir/renamed.txt", "stranger one")
		c.s.write("dir/file.txt", "stranger two")
		c.s.restart()
		if n := c.s.journal(); n != 0 {
			t.Fatalf("journal = %d", n)
		}
		if _, ok := c.s.shareByID(c.file.ID); ok {
			t.Fatal("a link kept pointing at unrelated content")
		}
		c.s.guest(c.file.token()).expectError("GET", "/api/public/"+c.file.token(), nil, 404, "not_found")
		if !strings.Contains(c.s.logs.String(), "changed outside the app") {
			t.Fatalf("recovery did not log it:\n%s", c.s.logs)
		}
		if got, ok := c.s.shareByID(c.dir.ID); !ok || got.Path != "dir" {
			t.Fatalf("an unrelated folder link changed: %+v, %v", got, ok)
		}
	})
}

func TestFailedFsyncKeepsTheJournal(t *testing.T) {
	s := startBin(t, crashBin, "FAIL_AT="+string(crash.ParentFsync))
	s.claim()
	s.write("a.txt", payload)
	sh := s.share("a.txt", "link", nil)

	s.owner.expectError("POST", "/api/files/rename", map[string]string{"path": "a.txt", "name": "b.txt"}, 500, "not_durable")
	if !s.exists("b.txt") || s.exists("a.txt") {
		t.Fatal("the rename should have happened on disk")
	}
	if n := s.journal(); n != 1 {
		t.Fatalf("journal = %d, the row must stay", n)
	}
	if got := s.healthz(); got != 503 {
		t.Fatalf("healthz = %d", got)
	}
	got, _ := s.shareByID(sh.ID)
	if got.Path != "a.txt" {
		t.Fatalf("share rewritten before the move was durable: %+v", got)
	}

	s.restart()
	if n := s.journal(); n != 0 {
		t.Fatalf("journal after restart = %d", n)
	}
	if got := s.healthz(); got != 200 {
		t.Fatalf("healthz after restart = %d", got)
	}
	if got, _ := s.shareByID(sh.ID); got.Path != "b.txt" {
		t.Fatalf("share after restart = %+v", got)
	}
	if got := s.fetch(sh.token()); got != payload {
		t.Fatalf("the link serves %q", got)
	}
}

func TestGuestOpenRacesARename(t *testing.T) {
	s := startBin(t, crashBin, "PAUSE_AT="+string(crash.GuestAfterLoad)+"=600ms")
	s.claim()
	s.write("doc.txt", payload)
	sh := s.share("doc.txt", "link", nil)
	g := s.openGuest(sh.token())

	got := make(chan string, 1)
	go func() {
		r, err := g.do("GET", g.path("/content"), nil)
		if err != nil {
			got <- err.Error()
			return
		}
		got <- string(r.body)
	}()
	time.Sleep(150 * time.Millisecond)
	s.owner.expect("POST", "/api/files/rename", map[string]string{"path": "doc.txt", "name": "moved.txt"}, 200)
	if stored := s.upload("doc.txt", "PRIVATE new file at the old name"); stored != "doc.txt" {
		t.Fatalf("stored = %q", stored)
	}
	if body := <-got; body != payload {
		t.Fatalf("the guest read %q", body)
	}
	if body := s.fetch(sh.token()); body != payload {
		t.Fatalf("a later guest read %q", body)
	}
}

func TestGuestAdmissionRacesARename(t *testing.T) {
	s := startBin(t, crashBin, "PAUSE_AT="+string(crash.AdmitAfterLoad)+"=500ms")
	s.claim()
	s.write("doc.txt", payload)
	sh := s.share("doc.txt", "link", nil)
	g := s.openGuest(sh.token())

	got := make(chan reply, 1)
	go func() {
		r, err := g.do("GET", g.path("/content"), nil)
		if err != nil {
			t.Error(err)
		}
		got <- r
	}()
	time.Sleep(100 * time.Millisecond)
	s.owner.expect("POST", "/api/files/rename", map[string]string{"path": "doc.txt", "name": "moved.txt"}, 200)
	if r := <-got; r.status != 200 || string(r.body) != payload {
		t.Fatalf("a guest during a rename got %d %s", r.status, r.body)
	}
}

func TestDropsFollowAFolderUnderRenames(t *testing.T) {
	s := start(t)
	s.claim()
	s.owner.expect("POST", "/api/files/folder", map[string]string{"path": "inbox-0"}, 201)
	drop := s.share("inbox-0", "drop", nil)
	g := s.openGuest(drop.token())

	const uploads = 30
	var stopped atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		current := 0
		for i := 1; ; i++ {
			time.Sleep(time.Millisecond)
			name := fmt.Sprintf("inbox-%d", i)
			r, err := s.owner.do("POST", "/api/files/rename", map[string]string{"path": fmt.Sprintf("inbox-%d", current), "name": name})
			if err != nil || r.status != 200 {
				return
			}
			current = i
			if stopped.Load() {
				return
			}
		}
	}()
	for i := range uploads {
		url := tusCreate(g.client, g.path("/uploads"), fmt.Sprintf("f%d.txt", i), 8)
		tusPatch(g.client, url, 0, []byte(fmt.Sprintf("%08d", i)))
	}
	stopped.Store(true)
	<-done

	final, _ := s.shareByID(drop.ID)
	entries, err := os.ReadDir(filepath.Join(s.root, final.Path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != uploads {
		t.Fatalf("%s holds %d files, want %d", final.Path, len(entries), uploads)
	}
	top, err := os.ReadDir(s.root)
	if err != nil {
		t.Fatal(err)
	}
	var folders []string
	for _, e := range top {
		if e.IsDir() && e.Name() != ".storage-server" {
			folders = append(folders, e.Name())
		}
	}
	if len(folders) != 1 || folders[0] != final.Path {
		t.Fatalf("folders = %v, want only %s", folders, final.Path)
	}
	if left := spoolEntries(s); len(left) != uploads {
		t.Fatalf("spool = %d tombstones, want %d", len(left), uploads)
	}
}

func TestKillSoak(t *testing.T) {
	duration := 20 * time.Second
	if longTier {
		duration = 10 * time.Minute
	}
	s := start(t)
	s.claim()
	rng := rand.New(rand.NewPCG(1, 2))
	const files = 12
	type tracked struct {
		share share
		body  string
	}
	var links []tracked
	s.owner.expect("POST", "/api/files/folder", map[string]string{"path": "a"}, 201)
	s.owner.expect("POST", "/api/files/folder", map[string]string{"path": "b"}, 201)
	for i := range files {
		body := fmt.Sprintf("file %d %s", i, strings.Repeat("x", i*97))
		s.write(fmt.Sprintf("a/f%d.txt", i), body)
		links = append(links, tracked{s.share(fmt.Sprintf("a/f%d.txt", i), "link", nil), body})
	}

	act := func(ctx context.Context, rng *rand.Rand) {
		for ctx.Err() == nil {
			shares, err := s.owner.do("GET", "/api/shares", nil)
			if err != nil || shares.status != 200 {
				return
			}
			list := decodeJSON[[]share](s.t, shares)
			if len(list) == 0 {
				return
			}
			sh := list[rng.IntN(len(list))]
			switch rng.IntN(6) {
			case 0:
				s.owner.do("POST", "/api/files/rename", map[string]string{"path": sh.Path, "name": fmt.Sprintf("r%d.txt", rng.IntN(1000))})
			case 1:
				s.owner.do("POST", "/api/files/move", map[string]any{"paths": []string{sh.Path}, "to": []string{"a", "b"}[rng.IntN(2)]})
			case 2:
				s.owner.do("POST", "/api/files/trash", map[string]any{"paths": []string{sh.Path}})
			case 3:
				if r, err := s.owner.do("GET", "/api/trash", nil); err == nil && r.status == 200 {
					if items := decodeJSON[[]trashItem](s.t, r); len(items) > 0 {
						s.owner.do("POST", "/api/trash/"+items[rng.IntN(len(items))].ID+"/restore", nil)
					}
				}
			case 4:
				body := seeded{seed: rng.Uint64()}.at(0, 256<<10)
				r, err := s.owner.do("POST", "/api/uploads", nil, tusHeaders("Upload-Length", fmt.Sprint(len(body)), "Upload-Metadata", "path "+b64(fmt.Sprintf("b/u%d.bin", rng.IntN(1000))))...)
				if err == nil && r.status == 201 {
					s.owner.do("PATCH", r.header.Get("Location"), body, tusHeaders("Content-Type", "application/offset+octet-stream", "Upload-Offset", "0")...)
				}
			case 5:
				s.owner.do("POST", "/api/files/folder", map[string]string{"path": fmt.Sprintf("b/d%d", rng.IntN(20))})
			}
		}
	}
	check := func(round int) {
		t.Helper()
		if n := s.journal(); n != 0 {
			t.Fatalf("round %d: %d journal rows", round, n)
		}
		for _, l := range links {
			got, ok := s.shareByID(l.share.ID)
			if !ok {
				t.Fatalf("round %d: a link vanished", round)
			}
			switch got.State {
			case "active":
				if body := s.fetch(l.share.token()); body != l.body {
					t.Fatalf("round %d: link %s at %s serves %q", round, l.share.ID, got.Path, body[:min(40, len(body))])
				}
			case "suspended":
			default:
				t.Fatalf("round %d: link at %q is %s", round, got.Path, got.State)
			}
		}
		filepath.WalkDir(filepath.Join(s.root, "b"), func(p string, d os.DirEntry, err error) error {
			if err == nil && strings.HasSuffix(p, ".bin") {
				if info, _ := d.Info(); info.Size() != 256<<10 {
					t.Fatalf("round %d: partial upload %s in the tree", round, p)
				}
			}
			return nil
		})
	}
	deadline := time.Now().Add(duration)
	rounds := 0
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		actRNG := rand.New(rand.NewPCG(rng.Uint64(), rng.Uint64()))
		go func() {
			defer close(done)
			act(ctx, actRNG)
		}()
		time.Sleep(time.Duration(20+rng.IntN(300)) * time.Millisecond)
		s.kill()
		cancel()
		<-done
		s.restart()
		check(rounds)
		rounds++
	}
	t.Logf("%d kill rounds in %v", rounds, duration)
	if rounds < 5 {
		t.Fatalf("only %d rounds", rounds)
	}
}
