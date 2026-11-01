//go:build harness

package harness

import (
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestFirstRun(t *testing.T) {
	s := start(t)
	type session struct {
		SetupRequired bool `json:"setupRequired"`
		Authenticated bool `json:"authenticated"`
	}
	got := decodeJSON[session](t, s.owner.expect("GET", "/api/session", nil, 200))
	if got != (session{SetupRequired: true}) {
		t.Fatalf("session = %+v", got)
	}
	s.owner.expectError("POST", "/api/login", map[string]string{"password": ownerPassword}, 401, "bad_credentials")
	s.owner.expectError("POST", "/api/setup", map[string]string{"code": "WRONG", "password": ownerPassword}, 401, "bad_code")
	s.owner.expectError("POST", "/api/setup", map[string]string{"code": "", "password": ownerPassword}, 401, "bad_code")
	s.owner.expectError("GET", "/api/files", nil, 401, "unauthenticated")

	code := s.setupCode()
	if len(code) != 16 {
		t.Fatalf("code = %q", code)
	}
	s.owner.expectError("POST", "/api/setup", map[string]string{"code": code, "password": "short"}, 422, "weak_password")
	s.owner.expect("POST", "/api/setup", map[string]string{"code": code, "password": ownerPassword}, 201)
	got = decodeJSON[session](t, s.owner.expect("GET", "/api/session", nil, 200))
	if got != (session{Authenticated: true}) {
		t.Fatalf("session after setup = %+v", got)
	}
	s.owner.expect("GET", "/api/files", nil, 200)

	stranger := newClient(t, "http://"+s.ownerAddr)
	stranger.expectError("POST", "/api/setup", map[string]string{"code": code, "password": ownerPassword}, 409, "already_set_up")
	stranger.expectError("GET", "/api/files", nil, 401, "unauthenticated")

	if s.restart(); strings.Contains(s.logs.String(), "setup_code") {
		t.Fatalf("a claimed server logged a setup code\n%s", s.logs)
	}
	s.owner.expect("GET", "/api/files", nil, 200)
}

func TestSessionsAndPasswordChange(t *testing.T) {
	s := start(t)
	s.claim()
	phone := newClient(t, "http://"+s.ownerAddr)
	phone.expect("POST", "/api/login", map[string]string{"password": ownerPassword}, 204, "User-Agent", "phone")

	type sess struct {
		ID        string `json:"id"`
		UserAgent string `json:"userAgent"`
		Current   bool   `json:"current"`
	}
	list := decodeJSON[[]sess](t, s.owner.expect("GET", "/api/sessions", nil, 200))
	if len(list) != 2 {
		t.Fatalf("sessions = %+v", list)
	}
	var phoneID string
	current := 0
	for _, e := range list {
		if e.Current {
			current++
		}
		if e.UserAgent == "phone" {
			phoneID = e.ID
		}
	}
	if current != 1 || phoneID == "" {
		t.Fatalf("sessions = %+v", list)
	}
	s.owner.expect("DELETE", "/api/sessions/"+phoneID, nil, 204)
	phone.expectError("GET", "/api/files", nil, 401, "unauthenticated")
	s.owner.expectError("DELETE", "/api/sessions/"+phoneID, nil, 404, "not_found")

	phone.expect("POST", "/api/login", map[string]string{"password": ownerPassword}, 204)
	s.owner.expectError("POST", "/api/account/password", map[string]string{"current": "wrong one", "new": "another password"}, 401, "bad_credentials")
	s.owner.expectError("POST", "/api/account/password", map[string]string{"current": ownerPassword, "new": "short"}, 422, "weak_password")
	s.owner.expect("POST", "/api/account/password", map[string]string{"current": ownerPassword, "new": "another password"}, 204)
	s.owner.expect("GET", "/api/files", nil, 200)
	phone.expectError("GET", "/api/files", nil, 401, "unauthenticated")
	phone.expectError("POST", "/api/login", map[string]string{"password": ownerPassword}, 401, "bad_credentials")
	phone.expect("POST", "/api/login", map[string]string{"password": "another password"}, 204)
	phone.expect("POST", "/api/logout", nil, 204)
	phone.expectError("GET", "/api/files", nil, 401, "unauthenticated")
}

func TestLoginLimiterSurvivesRestart(t *testing.T) {
	s := start(t)
	s.claim()
	browser := newClient(t, "http://"+s.ownerAddr)
	for range 5 {
		browser.expectError("POST", "/api/login", map[string]string{"password": "not the password"}, 401, "bad_credentials")
	}
	r := browser.call("POST", "/api/login", map[string]string{"password": ownerPassword})
	if r.status != 429 || r.code() != "rate_limited" || r.header.Get("Retry-After") == "" {
		t.Fatalf("locked login = %d %s, Retry-After %q", r.status, r.body, r.header.Get("Retry-After"))
	}
	if got := s.metricsLine("storage_login_failures_total"); got != "storage_login_failures_total 5" {
		t.Fatalf("metric = %q", got)
	}
	s.restart()
	browser.expectError("POST", "/api/login", map[string]string{"password": ownerPassword}, 429, "rate_limited")
}

func TestCookieAttributes(t *testing.T) {
	s := start(t, "PUBLIC_URL=https://storage.example", "SHARE_URL=https://share.example:8443")
	s.write("a.txt", "a")
	r := s.owner.expect("POST", "/api/setup", map[string]string{"code": s.setupCode(), "password": ownerPassword}, 201)
	cookie := r.header.Get("Set-Cookie")
	for _, want := range []string{"storage_session=", "Path=/", "HttpOnly", "Secure", "SameSite=Strict"} {
		if !strings.Contains(cookie, want) {
			t.Fatalf("session cookie %q lacks %s", cookie, want)
		}
	}
	insecure := newClient(t, "http://"+s.ownerAddr)
	r = insecure.expect("POST", "/api/login", map[string]string{"password": ownerPassword}, 204)
	session := strings.SplitN(r.header.Get("Set-Cookie"), ";", 2)[0]
	sh := decodeJSON[share](t, insecure.expect("POST", "/api/shares", map[string]string{"path": "a.txt", "kind": "link"}, 201, "Cookie", session))
	if !strings.HasPrefix(sh.URL, "https://share.example:8443/s/") {
		t.Fatalf("url = %q", sh.URL)
	}
	g := s.guest(sh.token())
	grant := g.expect("POST", g.path("/open"), nil, 204).header.Get("Set-Cookie")
	for _, want := range []string{"storage_grant=", "Path=/api/public/" + sh.token(), "HttpOnly", "Secure", "SameSite=Strict", "Expires="} {
		if !strings.Contains(grant, want) {
			t.Fatalf("grant cookie %q lacks %s", grant, want)
		}
	}
}

func TestHealthcheckSubcommand(t *testing.T) {
	s := start(t)
	probe := func() error {
		cmd := exec.Command(s.bin, "healthcheck")
		cmd.Env = append(os.Environ(), "OWNER_ADDR="+s.ownerAddr)
		return cmd.Run()
	}
	if err := probe(); err != nil {
		t.Fatalf("healthcheck on a live server: %v", err)
	}
	s.kill()
	if err := probe(); err == nil {
		t.Fatal("healthcheck passed on a dead server")
	}
}

func TestMetricsCountTransfersBySurface(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("doc.txt", "0123456789")
	sh := s.share("doc.txt", "link", nil)
	s.owner.expect("GET", "/api/files/content?path=doc.txt", nil, 200)
	if got := s.fetch(sh.token()); got != "0123456789" {
		t.Fatalf("fetch = %q", got)
	}
	if stored := s.upload("up.txt", "abc"); stored != "up.txt" {
		t.Fatalf("stored = %q", stored)
	}
	for line, want := range map[string]string{
		`storage_transfer_bytes_total{direction="down",surface="owner"}`: "10",
		`storage_transfer_bytes_total{direction="down",surface="guest"}`: "10",
		`storage_transfer_bytes_total{direction="up",surface="owner"}`:   "3",
		`storage_shares`:      "1",
		`storage_trash_items`: "0",
	} {
		if got := s.metricsLine(line + " "); got != line+" "+want {
			t.Errorf("metric = %q, want %s", got, want)
		}
	}
}

func (s *server) metricsLine(prefix string) string {
	s.t.Helper()
	resp, err := http.Get("http://" + s.opsAddr + "/metrics")
	if err != nil {
		s.t.Fatal(err)
	}
	defer resp.Body.Close()
	var b strings.Builder
	buf := make([]byte, 64<<10)
	for {
		n, err := resp.Body.Read(buf)
		b.Write(buf[:n])
		if err != nil {
			break
		}
	}
	for _, line := range strings.Split(b.String(), "\n") {
		if strings.HasPrefix(line, prefix) {
			return line
		}
	}
	return ""
}

func TestResetOwner(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("kept.txt", "kept")
	sh := s.share("kept.txt", "link", nil)

	s.kill()
	cmd := exec.Command(s.bin, "reset-owner")
	cmd.Env = append(os.Environ(), "STATE_DIR="+s.state)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("reset-owner: %v\n%s", err, out)
	}
	s.restart()
	s.owner.expectError("GET", "/api/files", nil, 401, "unauthenticated")
	s.owner.expectError("POST", "/api/login", map[string]string{"password": ownerPassword}, 401, "bad_credentials")
	s.owner.expect("POST", "/api/setup", map[string]string{"code": s.setupCode(), "password": "a brand new password"}, 201)
	if got := s.fetch(sh.token()); got != "kept" {
		t.Fatalf("the link served %q after reset", got)
	}
}

func TestReservedDirIsInvisible(t *testing.T) {
	s := start(t)
	s.claim()
	s.write("visible.txt", "x")
	body := string(s.owner.expect("GET", "/api/files", nil, 200).body)
	if strings.Contains(body, ".storage-server") || !strings.Contains(body, "visible.txt") {
		t.Fatalf("listing = %s", body)
	}
	s.owner.expectError("GET", "/api/files?path=.storage-server", nil, 400, "reserved_name")
	s.owner.expectError("GET", "/api/files/content?path=.STORAGE-server/trash", nil, 400, "reserved_name")
	s.owner.expectError("POST", "/api/files/rename", map[string]string{"path": "visible.txt", "name": ".Storage-Server"}, 400, "reserved_name")
	hits := string(s.owner.expect("GET", "/api/search?q=spool", nil, 200).body)
	if strings.Contains(hits, ".storage-server") {
		t.Fatalf("search = %s", hits)
	}
}
