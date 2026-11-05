package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/blobs"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/config"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/server"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/telemetry"
	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/testdb"
)

func TestMain(m *testing.M) {
	shutdown, err := telemetry.InitTracing(context.Background())
	if err != nil {
		panic(err)
	}
	code := m.Run()
	shutdown(context.Background())
	testdb.Stop()
	os.Exit(code)
}

const origin = "https://storage.lab.localhost"

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type env struct {
	t       *testing.T
	cfg     config.Config
	srv     *httptest.Server
	s       *server.Server
	st      *store.Store
	dir     string
	logs    *syncBuffer
	metrics *telemetry.Metrics
	metSrv  *httptest.Server
}

func newEnv(t *testing.T, tweak ...func(*config.Config)) *env {
	t.Helper()
	cfg := config.Config{
		PublicURL: origin, Domain: "lab.localhost", AuthPublicURL: "https://auth.lab.localhost", HomeURL: "https://home.lab.localhost/",
		AuthMode: "header", AdminGroup: "admins", UserGroup: "users",
		DefaultQuota: 50 * config.GiB, MaxFileSize: 10 * config.GiB, MaxChunkSize: 8 << 20, MinFreePercent: 0,
		TrashRetention: 30 * 24 * time.Hour, UploadTTL: 24 * time.Hour, TextPreviewCap: 1 << 20,
		OfficeConcurrency: 2, OfficeTimeout: 5 * time.Second, OfficeMaxBytes: 100 << 20,
	}
	for _, f := range tweak {
		f(&cfg)
	}
	cfg.DatabaseURL = testdb.New(t)
	cfg.DataDir = t.TempDir()
	logs := &syncBuffer{}
	t.Cleanup(func() {
		if t.Failed() {
			for _, line := range strings.Split(logs.String(), "\n") {
				if strings.Contains(line, `"level":"error"`) || strings.Contains(line, `"level":"warn"`) {
					t.Log(line)
				}
			}
		}
	})
	log := telemetry.NewLogger(logs, slog.LevelDebug)
	ctx := context.Background()
	st, err := store.Open(ctx, cfg.DatabaseURL, cfg.DefaultQuota, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	dir, err := blobs.Open(cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	m := telemetry.NewMetrics()
	ui := fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>storage</title>")},
		"assets/app-abc123.js": {Data: []byte("console.log(1)")},
		"favicon.svg":          {Data: []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")},
	}
	s, err := server.New(ctx, cfg, log, st, dir, m, ui)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	met := httptest.NewServer(s.MetricsHandler())
	t.Cleanup(met.Close)
	return &env{t: t, cfg: cfg, srv: srv, s: s, st: st, dir: cfg.DataDir, logs: logs, metrics: m, metSrv: met}
}

// client is a person: a signed-in user (user != "") or an anonymous guest.
type client struct {
	e      *env
	user   string
	groups string
	http   *http.Client
}

func (e *env) as(user string) *client {
	groups := "users"
	if user == "admin" {
		groups = "admins,users"
	}
	jar, _ := cookiejar.New(nil)
	return &client{e: e, user: user, groups: groups, http: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (e *env) guest() *client { return e.as("") }

type resp struct {
	t      *testing.T
	Status int
	Header http.Header
	Body   []byte
}

func (r *resp) json(v any) {
	r.t.Helper()
	if err := json.Unmarshal(r.Body, v); err != nil {
		r.t.Fatalf("decode %q: %v", r.Body, err)
	}
}

func (r *resp) m() map[string]any {
	var v map[string]any
	r.json(&v)
	return v
}

// req sends a request. A body of type []byte is sent as octet-stream,
// anything else non-nil as JSON. Mutating requests get the anti-forgery
// header unless hdr overrides it. hdr is key, value pairs.
func (c *client) req(method, path string, body any, hdr ...string) *resp {
	c.e.t.Helper()
	var rd io.Reader
	ctype := ""
	switch b := body.(type) {
	case nil:
	case []byte:
		rd, ctype = bytes.NewReader(b), "application/octet-stream"
	case io.Reader:
		rd, ctype = b, "application/octet-stream"
	default:
		js, _ := json.Marshal(b)
		rd, ctype = bytes.NewReader(js), "application/json"
	}
	r, err := http.NewRequest(method, c.e.srv.URL+path, rd)
	if err != nil {
		c.e.t.Fatal(err)
	}
	if ctype != "" {
		r.Header.Set("Content-Type", ctype)
	}
	if method != http.MethodGet && method != http.MethodHead {
		r.Header.Set("X-Requested-With", "fetch")
	}
	if c.user != "" {
		r.Header.Set("Remote-User", c.user)
		r.Header.Set("Remote-Groups", c.groups)
		r.Header.Set("Remote-Email", c.user+"@example.com")
		r.Header.Set("Remote-Name", strings.ToUpper(c.user[:1])+c.user[1:])
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		if hdr[i+1] == "" {
			r.Header.Del(hdr[i])
		} else {
			r.Header.Set(hdr[i], hdr[i+1])
		}
	}
	res, err := c.http.Do(r)
	if err != nil {
		c.e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return &resp{t: c.e.t, Status: res.StatusCode, Header: res.Header, Body: b}
}

func (c *client) get(path string, hdr ...string) *resp {
	return c.req(http.MethodGet, path, nil, hdr...)
}

func (c *client) must(r *resp, want int) *resp {
	c.e.t.Helper()
	if r.Status != want {
		c.e.t.Fatalf("status %d, want %d: %s", r.Status, want, r.Body)
	}
	return r
}

type node struct {
	ID         string  `json:"id"`
	ParentID   *string `json:"parentId"`
	Name       string  `json:"name"`
	IsDir      bool    `json:"isDir"`
	Size       int64   `json:"size"`
	Kind       string  `json:"kind"`
	Owner      string  `json:"owner"`
	Starred    bool    `json:"starred"`
	Permission string  `json:"permission"`
}

func (c *client) root() string {
	c.e.t.Helper()
	var me struct {
		User struct {
			RootID string `json:"rootId"`
		} `json:"user"`
	}
	c.must(c.get("/api/me"), 200).json(&me)
	return me.User.RootID
}

func (c *client) mkdir(parent, name string) node {
	c.e.t.Helper()
	var out struct{ Node node }
	c.must(c.req("POST", "/api/folders", map[string]any{"parentId": parent, "name": name}), 201).json(&out)
	return out.Node
}

func (c *client) upload(parent, name string, data []byte) node {
	c.e.t.Helper()
	return c.uploadTo("", parent, "", name, data)
}

// uploadTo sends a whole file in one chunk; prefix is "" for the signed-in
// API or "/api/public/<token>" for a drop link.
func (c *client) uploadTo(prefix, parent, rel, name string, data []byte) node {
	c.e.t.Helper()
	base := "/api/uploads"
	if prefix != "" {
		base = prefix + "/uploads"
	}
	var created struct {
		Upload struct {
			ID string `json:"id"`
		} `json:"upload"`
		Node node `json:"node"`
	}
	c.must(c.req("POST", base, map[string]any{"parentId": parent, "name": name, "size": len(data), "relativePath": rel}), 201).json(&created)
	if len(data) == 0 {
		return created.Node
	}
	var done struct {
		Node node `json:"node"`
	}
	c.must(c.req("PUT", base+"/"+created.Upload.ID, data, "Upload-Offset", "0"), 201).json(&done)
	return done.Node
}

func (c *client) children(id string) []node {
	c.e.t.Helper()
	var out struct{ Items []node }
	c.must(c.get("/api/nodes/"+id+"/children"), 200).json(&out)
	return out.Items
}

func (e *env) metric(name string) float64 {
	e.t.Helper()
	res, err := http.Get(e.metSrv.URL + "/metrics")
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, name+" ") {
			f, _ := strconv.ParseFloat(strings.Fields(line)[1], 64)
			return f
		}
	}
	return -1
}

func names(nodes []node) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.Name
	}
	return out
}
