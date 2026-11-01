//go:build harness

// Package harness proves the brief against the real binary, a real socket and a
// real filesystem. There are no mocks. Run on the disk type the server will use:
//
//	HARNESS_DIR=/path/on/real/disk go test -tags harness -timeout 2h ./harness
//
// TestMain builds cmd/storage-server twice: plain, and with -tags crashpoints.
// HARNESS_LONG=1 adds the multi-gigabyte cases and the ten minute soak.
// HARNESS_RACE=1 builds both binaries with the race detector.
package harness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

const ownerPassword = "correct horse battery"

var (
	workDir   string
	plainBin  string
	crashBin  string
	longTier  = os.Getenv("HARNESS_LONG") != ""
	raceBuild = os.Getenv("HARNESS_RACE") != ""
)

func TestMain(m *testing.M) {
	if deny := os.Getenv("HARNESS_SECCOMP_DENY"); deny != "" {
		execDenied(deny)
	}
	os.Exit(run(m))
}

func run(m *testing.M) int {
	base := os.Getenv("HARNESS_DIR")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		base = filepath.Join(home, ".cache", "storage-server-harness")
	}
	if err := os.MkdirAll(base, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	dir, err := os.MkdirTemp(base, "run-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer os.RemoveAll(dir)
	workDir = dir
	plainBin = filepath.Join(dir, "storage-server")
	crashBin = filepath.Join(dir, "storage-server-crash")
	for bin, tags := range map[string]string{plainBin: "", crashBin: "crashpoints"} {
		args := []string{"build", "-tags", tags, "-o", bin}
		if raceBuild {
			args = append(args, "-race")
		}
		cmd := exec.Command("go", append(args, "../cmd/storage-server")...)
		if out, err := cmd.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "build %s: %v\n%s", bin, err, out)
			return 1
		}
	}
	return m.Run()
}

// server is the binary under test, on its own root and state directories.
type server struct {
	t                *testing.T
	bin              string
	dir, root, state string
	env              []string
	ownerAddr        string
	guestAddr        string
	opsAddr          string
	owner            *client

	cmd    *exec.Cmd
	exited chan error
	logs   *lockedBuffer
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

func start(t *testing.T, env ...string) *server { return startBin(t, plainBin, env...) }

func startBin(t *testing.T, bin string, env ...string) *server {
	t.Helper()
	dir, err := os.MkdirTemp(workDir, "t-")
	if err != nil {
		t.Fatal(err)
	}
	s := &server{
		t: t, bin: bin, dir: dir, root: filepath.Join(dir, "root"), state: filepath.Join(dir, "state"), env: env,
		ownerAddr: freeAddr(t), guestAddr: freeAddr(t), opsAddr: freeAddr(t),
	}
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		s.stop()
		chmodAll(dir)
		os.RemoveAll(dir)
	})
	s.boot()
	s.owner = newClient(t, "http://"+s.ownerAddr)
	return s
}

func chmodAll(dir string) {
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.Type().IsRegular() && d.IsDir() {
			os.Chmod(p, 0o755)
		}
		return nil
	})
}

func (s *server) baseEnv() []string {
	return append(os.Environ(),
		"ROOT_DIR="+s.root, "STATE_DIR="+s.state,
		"OWNER_ADDR="+s.ownerAddr, "GUEST_ADDR="+s.guestAddr, "OPS_ADDR="+s.opsAddr,
		"PUBLIC_URL=http://"+s.ownerAddr, "SHARE_URL=http://"+s.guestAddr, "MIN_FREE_BYTES=0",
	)
}

func (s *server) boot() {
	s.t.Helper()
	s.launch()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-s.exited:
			s.exited <- err
			s.t.Fatalf("server exited at boot: %v\n%s", err, s.logs)
		default:
		}
		resp, err := http.Get("http://" + s.opsAddr + "/healthz")
		if err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.t.Fatalf("server did not listen\n%s", s.logs)
}

func (s *server) launch() {
	s.logs = &lockedBuffer{}
	s.cmd = exec.Command(s.bin)
	s.cmd.Env = append(s.baseEnv(), s.env...)
	s.cmd.Stdout = s.logs
	s.cmd.Stderr = s.logs
	if err := s.cmd.Start(); err != nil {
		s.t.Fatal(err)
	}
	s.exited = make(chan error, 1)
	cmd := s.cmd
	exited := s.exited
	go func() { exited <- cmd.Wait() }()
}

func (s *server) stop() {
	if s.cmd == nil {
		return
	}
	s.cmd.Process.Kill()
	<-s.exited
	s.cmd = nil
}

// kill sends SIGKILL and waits. restart boots on the same directories, which runs
// the recovery path.
func (s *server) kill() {
	s.t.Helper()
	if s.cmd == nil {
		return
	}
	if err := s.cmd.Process.Signal(syscall.SIGKILL); err != nil && err != os.ErrProcessDone {
		s.t.Fatal(err)
	}
	<-s.exited
	s.cmd = nil
}

// waitDied waits for a crash point to fire inside the server.
func (s *server) waitDied() {
	s.t.Helper()
	select {
	case err := <-s.exited:
		s.cmd = nil
		if ws, ok := exitStatus(err); !ok || ws != syscall.SIGKILL {
			s.t.Fatalf("server stopped with %v, want SIGKILL\n%s", err, s.logs)
		}
	case <-time.After(30 * time.Second):
		s.t.Fatalf("crash point never fired\n%s", s.logs)
	}
}

func exitStatus(err error) (syscall.Signal, bool) {
	ee, ok := err.(*exec.ExitError)
	if !ok {
		return 0, false
	}
	ws, ok := ee.Sys().(syscall.WaitStatus)
	if !ok || !ws.Signaled() {
		return 0, false
	}
	return ws.Signal(), true
}

func (s *server) restart(env ...string) {
	s.t.Helper()
	s.kill()
	s.env = env
	s.boot()
}

// peakRSS reads VmHWM from /proc, in bytes.
func (s *server) peakRSS() int64 {
	s.t.Helper()
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", s.cmd.Process.Pid))
	if err != nil {
		s.t.Fatal(err)
	}
	m := regexp.MustCompile(`VmHWM:\s+(\d+) kB`).FindSubmatch(data)
	if m == nil {
		s.t.Fatal("no VmHWM")
	}
	kb, err := strconv.ParseInt(string(m[1]), 10, 64)
	if err != nil {
		s.t.Fatal(err)
	}
	return kb << 10
}

func (s *server) checkRSS(limit int64) {
	s.t.Helper()
	if raceBuild {
		return
	}
	if got := s.peakRSS(); got > limit {
		s.t.Errorf("VmHWM = %d MiB, limit %d MiB", got>>20, limit>>20)
	}
}

func (s *server) setupCode() string {
	s.t.Helper()
	m := regexp.MustCompile(`"msg":"setup_code","code":"([A-Z0-9]+)"`).FindStringSubmatch(s.logs.String())
	if m == nil {
		s.t.Fatalf("no setup code in the log\n%s", s.logs)
	}
	return m[1]
}

// claim runs first-time setup and leaves s.owner logged in.
func (s *server) claim() {
	s.t.Helper()
	s.owner.expect("POST", "/api/setup", map[string]string{"code": s.setupCode(), "password": ownerPassword}, 201)
}

func (s *server) write(rel, body string) string {
	s.t.Helper()
	full := filepath.Join(s.root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		s.t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		s.t.Fatal(err)
	}
	return full
}

func (s *server) read(rel string) string {
	s.t.Helper()
	data, err := os.ReadFile(filepath.Join(s.root, rel))
	if err != nil {
		s.t.Fatal(err)
	}
	return string(data)
}

func (s *server) exists(rel string) bool {
	_, err := os.Lstat(filepath.Join(s.root, rel))
	return err == nil
}

// journal counts move rows by reading the same file the server uses.
func (s *server) journal() int {
	s.t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(s.state, "state.db")+"?mode=ro")
	if err != nil {
		s.t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM pending_moves`).Scan(&n); err != nil {
		s.t.Fatal(err)
	}
	return n
}

func (s *server) healthz() int {
	s.t.Helper()
	resp, err := http.Get("http://" + s.opsAddr + "/healthz")
	if err != nil {
		s.t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// client is one browser: its own cookie jar against one listener.
type client struct {
	t    *testing.T
	base string
	http *http.Client
}

func newClient(t *testing.T, base string) *client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &client{t: t, base: base, http: &http.Client{Jar: jar, Timeout: 2 * time.Minute}}
}

type reply struct {
	status int
	body   []byte
	header http.Header
}

func (r reply) code() string {
	var e struct {
		Error struct{ Code string } `json:"error"`
	}
	json.Unmarshal(r.body, &e)
	return e.Error.Code
}

func (c *client) do(method, path string, in any, headers ...string) (reply, error) {
	var body io.Reader
	switch v := in.(type) {
	case nil:
	case string:
		body = strings.NewReader(v)
	case []byte:
		body = bytes.NewReader(v)
	default:
		encoded, err := json.Marshal(in)
		if err != nil {
			c.t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, c.base+path, body)
	if err != nil {
		return reply{}, err
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return reply{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return reply{resp.StatusCode, data, resp.Header}, err
}

func (c *client) call(method, path string, in any, headers ...string) reply {
	c.t.Helper()
	r, err := c.do(method, path, in, headers...)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	return r
}

func (c *client) expect(method, path string, in any, status int, headers ...string) reply {
	c.t.Helper()
	r := c.call(method, path, in, headers...)
	if r.status != status {
		c.t.Fatalf("%s %s = %d %s, want %d", method, path, r.status, r.body, status)
	}
	return r
}

func (c *client) expectError(method, path string, in any, status int, code string, headers ...string) {
	c.t.Helper()
	r := c.call(method, path, in, headers...)
	if r.status != status || r.code() != code {
		c.t.Fatalf("%s %s = %d %s, want %d %s", method, path, r.status, r.body, status, code)
	}
}

func decodeJSON[T any](t *testing.T, r reply) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(r.body, &v); err != nil {
		t.Fatalf("decode %s: %v", r.body, err)
	}
	return v
}

type share struct {
	ID      string `json:"id"`
	URL     string `json:"url"`
	Kind    string `json:"kind"`
	Path    string `json:"path"`
	State   string `json:"state"`
	Uses    int    `json:"uses"`
	MaxUses *int   `json:"maxUses"`
	HasPass bool   `json:"hasPassword"`
}

func (sh share) token() string { return sh.URL[strings.LastIndexByte(sh.URL, '/')+1:] }

func (s *server) share(path, kind string, extra map[string]any) share {
	s.t.Helper()
	in := map[string]any{"path": path, "kind": kind}
	for k, v := range extra {
		in[k] = v
	}
	return decodeJSON[share](s.t, s.owner.expect("POST", "/api/shares", in, 201))
}

func (s *server) shares() []share {
	s.t.Helper()
	return decodeJSON[[]share](s.t, s.owner.expect("GET", "/api/shares", nil, 200))
}

func (s *server) shareByID(id string) (share, bool) {
	s.t.Helper()
	for _, sh := range s.shares() {
		if sh.ID == id {
			return sh, true
		}
	}
	return share{}, false
}

type trashItem struct {
	ID           string `json:"id"`
	OriginalPath string `json:"originalPath"`
}

func (s *server) trash(paths ...string) string {
	s.t.Helper()
	out := decodeJSON[struct {
		Results []struct {
			TrashID string `json:"trashId"`
			Error   string `json:"error"`
		} `json:"results"`
	}](s.t, s.owner.expect("POST", "/api/files/trash", map[string]any{"paths": paths}, 200))
	if len(out.Results) == 0 || out.Results[0].Error != "" {
		s.t.Fatalf("trash %v = %+v", paths, out)
	}
	return out.Results[0].TrashID
}

func (s *server) trashItems() []trashItem {
	s.t.Helper()
	return decodeJSON[[]trashItem](s.t, s.owner.expect("GET", "/api/trash", nil, 200))
}

// guest is one visitor to one link.
type guest struct {
	*client
	token string
}

func (s *server) guest(token string) *guest {
	s.t.Helper()
	return &guest{newClient(s.t, "http://"+s.guestAddr), token}
}

func (g *guest) path(suffix string) string { return "/api/public/" + g.token + suffix }

func (g *guest) open() {
	g.t.Helper()
	g.expect("POST", g.path("/open"), nil, 204)
}

func (s *server) openGuest(token string) *guest {
	s.t.Helper()
	g := s.guest(token)
	g.open()
	return g
}

// fetch opens a link in a fresh browser and returns the bytes it serves.
func (s *server) fetch(token string) string {
	s.t.Helper()
	g := s.openGuest(token)
	return string(g.expect("GET", g.path("/content"), nil, 200).body)
}

func withTimeout(t *testing.T, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}
