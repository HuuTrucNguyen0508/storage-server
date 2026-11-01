//go:build harness

package harness

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	seccompSetModeFilter = 1
	seccompRetErrno      = 0x00050000
	seccompRetAllow      = 0x7fff0000
)

// denied maps a primitive to the x86-64 syscall number and the errno a kernel or
// filesystem without it would give.
var denied = map[string]struct {
	nr    uint32
	errno syscall.Errno
}{
	"openat2":   {437, syscall.ENOSYS},
	"renameat2": {316, syscall.EINVAL},
	"fsync":     {74, syscall.EIO},
}

// execDenied installs a seccomp filter on this thread and execs the server under
// it, so the startup probes meet a kernel that really refuses the call.
func execDenied(name string) {
	rule := denied[name]
	runtime.LockOSThread()
	filter := []unix.SockFilter{
		{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: 0},
		{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, Jt: 0, Jf: 1, K: rule.nr},
		{Code: unix.BPF_RET | unix.BPF_K, K: seccompRetErrno | uint32(rule.errno)},
		{Code: unix.BPF_RET | unix.BPF_K, K: seccompRetAllow},
	}
	prog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	if _, _, errno := unix.Syscall(unix.SYS_SECCOMP, seccompSetModeFilter, 0, uintptr(unsafe.Pointer(&prog))); errno != 0 {
		fmt.Fprintln(os.Stderr, errno)
		os.Exit(3)
	}
	target := os.Getenv("HARNESS_EXEC")
	err := syscall.Exec(target, []string{target}, os.Environ())
	fmt.Fprintln(os.Stderr, err)
	os.Exit(3)
}

// TestStartupProbes runs the real binary on a real root with each primitive
// refused by seccomp. Change 4: it must refuse to start, name the primitive and
// name the filesystem, and it must not fall back.
func TestStartupProbes(t *testing.T) {
	if runtime.GOARCH != "amd64" {
		t.Skip("the seccomp numbers are for amd64")
	}
	for name, want := range map[string]string{
		"openat2":   "openat2 failed",
		"renameat2": "renameat2 RENAME_NOREPLACE failed",
		"fsync":     "directory fsync failed",
	} {
		t.Run(name, func(t *testing.T) {
			s := start(t)
			s.stop()
			self, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			s.bin = self
			s.env = []string{"HARNESS_SECCOMP_DENY=" + name, "HARNESS_EXEC=" + plainBin}
			s.launch()
			select {
			case err := <-s.exited:
				s.cmd = nil
				if err == nil {
					t.Fatalf("exit 0 without %s\n%s", name, s.logs)
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("the server started without %s\n%s", name, s.logs)
			}
			logs := s.logs.String()
			if !strings.Contains(logs, want) || !strings.Contains(logs, "no fallback") {
				t.Fatalf("log does not name the primitive %q:\n%s", want, logs)
			}
			if !strings.Contains(logs, " on btrfs") && !strings.Contains(logs, " on ext4") && !strings.Contains(logs, " on xfs") {
				t.Fatalf("log does not name the filesystem:\n%s", logs)
			}
		})
	}
}

// TestProbeAcceptsThisFilesystem is the other half: with nothing denied, the same
// launcher path boots. Without it a broken launcher would pass the test above.
func TestProbeAcceptsThisFilesystem(t *testing.T) {
	s := start(t)
	if got := s.healthz(); got != 200 {
		t.Fatalf("healthz = %d", got)
	}
	entries, err := os.ReadDir(s.root + "/.storage-server")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if got := strings.Join(names, " "); got != "spool trash" {
		t.Fatalf("reserved dir holds %q", got)
	}
}
