// Package testdb gives integration tests a real PostgreSQL: one throwaway
// postgres container per test binary, one fresh database per test.
// Set TEST_DATABASE_URL to use an existing server instead of Docker.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Image is the pinned server image, matching the cluster's major version.
const Image = "postgres:18.6-alpine"

var (
	once      sync.Once
	baseURL   string
	container string
	startErr  error
)

func start() {
	if u := os.Getenv("TEST_DATABASE_URL"); u != "" {
		baseURL = u
		return
	}
	// No --rm: if Postgres exits during startup, its logs must still be readable.
	// No tmpfs data directory: it kept the container from starting on GitHub's runners.
	out, err := exec.Command("docker", "run", "-d", "-p", "127.0.0.1::5432",
		"-e", "POSTGRES_PASSWORD=test", "-e", "POSTGRES_USER=test", "-e", "POSTGRES_DB=test",
		Image, "-c", "fsync=off", "-c", "max_connections=500").Output()
	if err != nil {
		var stderr []byte
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = ee.Stderr
		}
		startErr = fmt.Errorf("docker run %s: %v: %s", Image, err, stderr)
		return
	}
	// stdout is only the container ID; pull progress goes to stderr.
	container = strings.TrimSpace(string(out))
	var port []byte
	for i := 0; i < 50; i++ { // the published port appears once the container runs
		if port, err = exec.Command("docker", "port", container, "5432/tcp").Output(); err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err != nil {
		startErr = fmt.Errorf("docker port: %v; %s", err, containerState())
		return
	}
	hostport := strings.TrimSpace(strings.Split(string(port), "\n")[0])
	baseURL = "postgres://test:test@" + hostport + "/test?sslmode=disable"
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		conn, err := pgx.Connect(ctx, baseURL)
		if err == nil {
			err = conn.Ping(ctx)
			conn.Close(ctx)
		}
		cancel()
		if err == nil {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	startErr = fmt.Errorf("postgres in %s never became ready; %s", container, containerState())
}

// containerState describes why the test container isn't serving, for the error message.
func containerState() string {
	state, _ := exec.Command("docker", "inspect", "-f", "{{.State.Status}} exit={{.State.ExitCode}} {{.State.Error}}", container).CombinedOutput()
	logs, _ := exec.Command("docker", "logs", "--tail", "30", container).CombinedOutput()
	return fmt.Sprintf("container %s: %s\nlast logs:\n%s", container, strings.TrimSpace(string(state)), logs)
}

// Stop removes the container; call it from TestMain after m.Run.
func Stop() {
	if container != "" {
		exec.Command("docker", "rm", "-f", container).Run() //nolint:errcheck
	}
}

// New creates an empty database for one test and returns its URL.
func New(t testing.TB) string {
	t.Helper()
	once.Do(start)
	if startErr != nil {
		t.Fatalf("test database: %v", startErr)
	}
	b := make([]byte, 6)
	rand.Read(b) //nolint:errcheck
	name := "t_" + hex.EncodeToString(b)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(baseURL)
	u.Path = "/" + name
	return u.String()
}
