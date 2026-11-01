// Package upload owns the spool. An upload has no database row. Its state is
// what is on disk under .storage-server/spool/<id>/, and phaseOf derives it:
//
//	meta.json     written once at creation, immutable
//	data          the bytes; its size is the only resume offset
//	publish.json  the chosen destination, written before the rename
//
// This package speaks in offsets and lengths. Tus headers stay in the api package.
package upload

import (
	"context"
	"errors"
	"io"
	"time"

	"storage-server/internal/disk"
	"storage-server/internal/store"
)

// TTL is how long an idle upload, or a published tombstone, stays in the spool.
const (
	IdleTTL      = 7 * 24 * time.Hour
	TombstoneTTL = 24 * time.Hour
)

var (
	ErrNotFound       = errors.New("upload not found")
	ErrOffsetMismatch = errors.New("offset does not match bytes stored")
	ErrTooLong        = errors.New("more bytes than the declared length")
	ErrNoSpace        = errors.New("not enough free space")
	ErrScope          = errors.New("share target is not available")
)

type ID string

// Scope says who owns an upload and where it may land. A drop upload stores the
// share ID, not a path, so it follows the folder if the owner moves it.
type Scope struct {
	Drop store.ShareID // empty for the owner
}

type Phase int

const (
	Receiving Phase = iota
	Complete
	Publishing
	Published
)

type Status struct {
	Phase  Phase
	Offset int64
	Length int64
	Stored disk.Path // set when Published and the scope is the owner
}

// phaseOf is the state machine. It is pure so every crash state is a table test.
func phaseOf(size, length int64, hasData, hasPublish bool) Phase { panic("not implemented") }

// Stream is a request body the manager can interrupt when a newer request for
// the same upload arrives. The api adapter sets a past read deadline.
type Stream interface {
	io.Reader
	Interrupt()
}

// Destination resolves where a scope publishes. The api passes the owner's
// files tree, or the live target of a drop share at publish time.
type Destination func(ctx context.Context, s Scope) (*disk.Tree, error)

type Manager struct {
	spool   *disk.Tree
	dest    Destination
	minFree func(need int64) error
	writers map[ID]*writer
	metrics *Counters
}

type writer struct {
	stream Stream
	done   chan struct{}
}

// Counters is what the manager reports to /metrics.
type Counters struct{ BytesReceived func(int64) }

func New(spool *disk.Tree, dest Destination, minFree func(int64) error, c *Counters) *Manager {
	panic("not implemented")
}

// Create writes meta.json into <id>.new, then renames it to <id>. A zero-length
// upload publishes before Create returns.
func (m *Manager) Create(ctx context.Context, s Scope, path disk.Path, length int64) (ID, Status, error) {
	panic("not implemented")
}

// Status stops any live writer first, so the offset it returns stays true until
// the next Append. It stops a writer without registering, because a finished
// handler's keep-alive connection would otherwise be cut by the next takeover.
func (m *Manager) Status(ctx context.Context, s Scope, id ID) (Status, error) {
	panic("not implemented")
}

// Append takes over from any live writer, checks offset against the stat size,
// streams through a fixed 1 MiB buffer, fsyncs, and publishes on the last byte.
func (m *Manager) Append(ctx context.Context, s Scope, id ID, offset int64, body Stream) (Status, error) {
	panic("not implemented")
}

// Cancel removes meta.json, then the directory.
func (m *Manager) Cancel(ctx context.Context, s Scope, id ID) error { panic("not implemented") }

// Recover removes half-created and metaless directories, and publishes any
// upload whose bytes all arrived. Running it twice changes nothing.
func (m *Manager) Recover(ctx context.Context) error { panic("not implemented") }

// Sweep expires idle uploads and old tombstones.
func (m *Manager) Sweep(ctx context.Context, now time.Time) error { panic("not implemented") }
