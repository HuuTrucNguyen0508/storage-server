//go:build crashpoints

package crash

import (
	"errors"
	"os"
	"strings"
	"time"
)

// Hit sends SIGKILL to this process when CRASH_AT names the point.
func Hit(p Point) {
	if os.Getenv("CRASH_AT") != string(p) {
		return
	}
	self, err := os.FindProcess(os.Getpid())
	if err == nil {
		err = self.Kill()
	}
	if err != nil {
		panic(err)
	}
	select {}
}

// Fail returns an error when FAIL_AT names the fault.
func Fail(f Fault) error {
	if os.Getenv("FAIL_AT") == string(f) {
		return errors.New("injected " + string(f))
	}
	return nil
}

// Pause sleeps when PAUSE_AT is "<gap>=<duration>".
func Pause(g Gap) {
	name, d, ok := strings.Cut(os.Getenv("PAUSE_AT"), "=")
	if !ok || name != string(g) {
		return
	}
	if dur, err := time.ParseDuration(d); err == nil {
		time.Sleep(dur)
	}
}
