//go:build harness

package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCompose(t *testing.T) {
	if os.Getenv("HARNESS_COMPOSE") == "" {
		t.Skip("set HARNESS_COMPOSE=1 to build and run Docker Compose")
	}
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(workDir, "compose-")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"root", "state", "tailscale-state"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	project := fmt.Sprintf("ss-harness-%d", time.Now().UnixNano())
	addr := freeAddr(t)
	envFile := filepath.Join(dir, ".env")
	env := "TS_STATE_DIR=" + filepath.Join(dir, "tailscale-state") + "\n" + fmt.Sprintf("STORAGE_ROOT=%s\nSTATE_DIR=%s\nPUID=%d\nPGID=%d\nBIND_ADDR=127.0.0.1\nPORT=%s\nPUBLIC_URL=http://%s\nSHARE_URL=http://%s\nMIN_FREE_BYTES=0\nGRAFANA_PASSWORD=isolated-compose-proof\n", filepath.Join(dir, "root"), filepath.Join(dir, "state"), os.Getuid(), os.Getgid(), strings.Split(addr, ":")[1], addr, addr)
	if err := os.WriteFile(envFile, []byte(env), 0600); err != nil {
		t.Fatal(err)
	}
	compose := func(args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "docker", append([]string{"compose", "-p", project, "--project-directory", root, "--env-file", envFile}, args...)...)
		cmd.Dir = root
		return cmd.CombinedOutput()
	}
	must := func(args ...string) []byte {
		t.Helper()
		out, err := compose(args...)
		if err != nil {
			t.Fatalf("compose %v: %v\n%s", args, err, out)
		}
		return out
	}
	t.Cleanup(func() {
		if t.Failed() {
			if out, err := compose("logs", "--no-color"); err == nil {
				t.Logf("compose logs:\n%s", out)
			}
		}
		if out, err := compose("--profile", "monitoring", "--profile", "tailscale", "--profile", "pdf", "down", "-v", "--rmi", "local", "--remove-orphans"); err != nil {
			t.Errorf("cleanup: %v\n%s", err, out)
		}
		// Compose leaves a locally built image behind even with --rmi local.
		if out, err := exec.Command("docker", "image", "rm", project+"-app").CombinedOutput(); err != nil {
			t.Errorf("image cleanup: %v\n%s", err, out)
		}
	})
	var cfg struct {
		Services map[string]struct {
			User        string            `json:"user"`
			ReadOnly    bool              `json:"read_only"`
			Caps        []string          `json:"cap_drop"`
			Security    []string          `json:"security_opt"`
			Environment map[string]string `json:"environment"`
			Ports       []struct {
				HostIP string `json:"host_ip"`
				Target uint16 `json:"target"`
			} `json:"ports"`
		} `json:"services"`
	}
	raw := must("--profile", "monitoring", "--profile", "tailscale", "--profile", "pdf", "config", "--format", "json")
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"app", "tailscale", "pdf", "prometheus", "grafana"} {
		s, ok := cfg.Services[name]
		if !ok || !s.ReadOnly || s.User == "" || strings.Split(s.User, ":")[0] == "0" || len(s.Caps) != 1 || s.Caps[0] != "ALL" || !strings.Contains(strings.Join(s.Security, ","), "no-new-privileges") {
			t.Fatalf("unhardened %s: %+v", name, s)
		}
		for _, p := range s.Ports {
			if p.HostIP != "127.0.0.1" {
				t.Fatalf("public host port on %s", name)
			}
		}
	}
	if strings.Contains(string(raw), "docker.sock") {
		t.Fatal("Docker socket mounted")
	}
	if len(cfg.Services["tailscale"].Ports) != 0 || cfg.Services["tailscale"].Environment["TS_USERSPACE"] != "true" {
		t.Fatal("tailscale must use userspace without host ports")
	}
	for _, p := range cfg.Services["app"].Ports {
		if p.Target != 8080 {
			t.Fatal("guest or ops listener published")
		}
	}
	for _, name := range []string{"tailnet", "funnel"} {
		b, err := os.ReadFile(filepath.Join(root, "deploy", "tailscale", name+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var serve struct {
			AllowFunnel map[string]bool
			Web         map[string]struct {
				Handlers map[string]struct{ Proxy string }
			}
		}
		if err := json.Unmarshal(b, &serve); err != nil {
			t.Fatal(err)
		}
		if name == "tailnet" && len(serve.AllowFunnel) != 0 {
			t.Fatal("tailnet config enables Funnel")
		}
		if name == "funnel" {
			if len(serve.AllowFunnel) != 1 || !serve.AllowFunnel["${TS_CERT_DOMAIN}:8443"] {
				t.Fatal("unexpected Funnel ports")
			}
			handlers := serve.Web["${TS_CERT_DOMAIN}:8443"].Handlers
			if len(handlers) != 1 || handlers["/"].Proxy != "http://app:8081" {
				t.Fatal("Funnel exposes more than guest")
			}
		}
		if serve.Web["${TS_CERT_DOMAIN}:443"].Handlers["/"].Proxy != "http://app:8080" || serve.Web["${TS_CERT_DOMAIN}:8444"].Handlers["/"].Proxy != "http://pdf:8080" {
			t.Fatal("tailnet owner or PDF route missing")
		}
	}
	must("build", "app")
	must("up", "-d", "--wait", "--wait-timeout", "60", "app")
	c := newClient(t, "http://"+addr)
	state := decodeJSON[map[string]bool](t, c.expect("GET", "/api/session", nil, 200))
	if !state["setupRequired"] {
		t.Fatal("not a fresh setup")
	}
	shell := c.expect("GET", "/", nil, 200)
	if !strings.Contains(string(shell.body), "assets/index-") || strings.Contains(string(shell.body), "frontend was not built") {
		t.Fatal("image lacks real frontend")
	}
	s := &server{t: t, owner: c, logs: &lockedBuffer{}}
	s.logs.Write(must("logs", "--no-color", "app"))
	s.claim()
	s.upload("compose.txt", "persisted through compose restart")
	sh := s.share("compose.txt", "link", nil)
	check := func() {
		t.Helper()
		r := c.expect("GET", "/api/files/content?path=compose.txt&download", nil, 200)
		if string(r.body) != "persisted through compose restart" {
			t.Fatal("download changed")
		}
		state := decodeJSON[map[string]bool](t, c.expect("GET", "/api/session", nil, 200))
		if state["setupRequired"] || !state["authenticated"] {
			t.Fatal("owner or session lost")
		}
		facts := decodeJSON[map[string]any](t, c.expect("GET", "/api/public/"+sh.token(), nil, 200))
		if facts["preview"] != "text" {
			t.Fatal("share lost")
		}
	}
	check()
	must("restart", "app")
	deadline := time.Now().Add(30 * time.Second)
	for {
		r, err := http.Get("http://" + addr + "/healthz")
		if err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("restart did not become healthy")
		}
		time.Sleep(50 * time.Millisecond)
	}
	check()
	t.Log("real image: setup, upload, download, persistent owner/session/share/file, hardened profiles and guest-only Funnel passed")
}
