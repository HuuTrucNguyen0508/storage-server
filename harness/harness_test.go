//go:build harness

// Package harness proves the brief against the real binary, a real socket and a
// real filesystem. There are no mocks. Run on the disk type the server will use:
//
//	HARNESS_DIR=/path/on/real/disk go test -tags harness -timeout 2h ./harness
//
// TestMain builds cmd/storage-server twice: plain, and with -tags crashpoints.
package harness

import "testing"

// server is the binary under test, on its own root and state directories.
type server struct{}

func start(t *testing.T, env ...string) *server { panic("not implemented") }

// kill sends SIGKILL and waits. restart boots on the same directories, which runs
// the recovery path.
func (s *server) kill()    { panic("not implemented") }
func (s *server) restart() { panic("not implemented") }

// peakRSS reads VmHWM from /proc.
func (s *server) peakRSS() int64 { panic("not implemented") }

// TestUploadResume sends 6 GiB of seeded ChaCha8 through tus. It cuts the socket
// at two random offsets, SIGKILLs the server at a third, simulates a page reload
// by resuming from the saved upload URL in a fresh client, and stalls one writer
// to force a takeover. It asserts the final SHA-256, that HEAD equals the bytes
// on disk after each fault, that no partial file was ever visible in the folder
// (a poller lists it throughout), and that VmHWM stays under 128 MiB.
func TestUploadResume(t *testing.T) { panic("not implemented") }

// TestRangeRead checks 206 and Content-Range at the start, middle and last byte
// of a file over 4 GiB, a suffix range, If-Range with a stale validator, and 416.
// Each body is compared with the same bytes read directly from disk.
func TestRangeRead(t *testing.T) { panic("not implemented") }

// TestSymlinkEscape plants, directly on disk, relative, absolute, directory and
// reserved-dir symlinks, a share-scope sideways link and a FIFO. It tries each
// through every route that takes a path, on both surfaces, plus ".." forms and
// encoded forms. A swapper flips a directory and symlink under load. It asserts
// no response contains the canary and no request hangs.
func TestSymlinkEscape(t *testing.T) { panic("not implemented") }

// TestHostileUpload uploads HTML and SVG through a drop link, asserts the exact
// response headers on both surfaces, then loads each URL by direct navigation and
// inside an iframe in headless Chromium. The page tries to write a canary to the
// app origin's localStorage and call a beacon route. It asserts neither happened.
// A PDF with embedded JavaScript gets the same check. Web checks stay headless.
func TestHostileUpload(t *testing.T) { panic("not implemented") }

// TestCrashMatrix runs each scenario once per crash.All on the crashpoints build,
// with CRASH_AT set: trash, restore, move, rename, purge and upload. After SIGKILL
// and restart it asserts: Recover ran twice with the same result, no partial file
// in the tree, every trash item restorable, every share resolves to the file it
// resolved to before, and a retried request reaches the same end state.
func TestCrashMatrix(t *testing.T) { panic("not implemented") }

// TestKillSoak runs mixed operations on the plain binary for ten minutes with
// SIGKILL at random times, checking the same invariants after each restart.
func TestKillSoak(t *testing.T) { panic("not implemented") }

// TestShareLifecycle covers rename, move, trash of the file and of an ancestor,
// restore to a taken path, purge, revoke, expiry, wrong passwords and the limiter.
func TestShareLifecycle(t *testing.T) { panic("not implemented") }

// TestMaxUses races 40 guests on max_uses=3 and asserts exactly three got bytes,
// a preview bot's GET spent nothing, and a video seek after exhaustion still works
// for a holder.
func TestMaxUses(t *testing.T) { panic("not implemented") }

// TestDropPrivacy asserts a drop guest cannot list, read, or learn the final name
// on a collision, and that two guests uploading one name both keep their bytes.
func TestDropPrivacy(t *testing.T) { panic("not implemented") }

// TestStreamedZip downloads a folder over 4 GiB and verifies with 7z and Python,
// asserts peak RSS stays bounded, and that a read error mid-stream aborts the
// connection. Info-ZIP unzip is expected to fail above 4 GiB, see DESIGN.md.
func TestStreamedZip(t *testing.T) { panic("not implemented") }

// TestGuestListener asserts every Owner route is 404 on the guest port, with and
// without a valid session cookie.
func TestGuestListener(t *testing.T) { panic("not implemented") }

// TestFirstRun asserts the server refuses login and setup without the logged code,
// and the code stops working after one use.
func TestFirstRun(t *testing.T) { panic("not implemented") }

// TestCompose runs docker compose up -d with a generated .env, walks the core
// loop through the published port, runs every profile through config validation,
// and greps the rendered config for docker.sock and default credentials.
func TestCompose(t *testing.T) { panic("not implemented") }
