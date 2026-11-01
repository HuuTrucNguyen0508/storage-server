// Package upload owns the spool. An upload has no database row. Its state is
// what is on disk under .storage-server/spool/<id>/, and phaseOf derives it:
//
//	meta.json     written once at creation, immutable
//	data          the bytes; its size is the only resume offset
//	publish.json  the chosen destination, written before the rename
//
// Publishing goes through vault.Publish, so this package never writes the live
// tree. It speaks in offsets and lengths. Tus headers stay in the api package.
package upload

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"storage-server/internal/crash"
	"storage-server/internal/disk"
	"storage-server/internal/store"
	"storage-server/internal/vault"
)

// TTL is how long an idle upload, or a published tombstone, stays in the spool.
const (
	IdleTTL      = 7 * 24 * time.Hour
	TombstoneTTL = 24 * time.Hour
)

const (
	metaFile    = "meta.json"
	dataFile    = "data"
	publishFile = "publish.json"
	bufferSize  = 1 << 20
)

var (
	ErrNotFound       = errors.New("upload not found")
	ErrOffsetMismatch = errors.New("offset does not match bytes stored")
	ErrTooLong        = errors.New("more bytes than the declared length")
	ErrNoSpace        = errors.New("not enough free space")
)

type ID string

// ParseID validates an upload ID from a URL.
func ParseID(raw string) (ID, error) {
	if b, err := hex.DecodeString(raw); err != nil || len(b) != 16 {
		return "", ErrNotFound
	}
	return ID(raw), nil
}

func (id ID) file(name string) disk.Path {
	p, err := disk.ParsePath(string(id) + "/" + name)
	if err != nil {
		panic(err)
	}
	return p
}

func (id ID) dir() disk.Path {
	p, err := disk.ParsePath(string(id))
	if err != nil {
		panic(err)
	}
	return p
}

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
func phaseOf(size, length int64, hasData, hasPublish bool) Phase {
	switch {
	case !hasData && hasPublish:
		return Published
	case !hasData || size != length:
		return Receiving
	case hasPublish:
		return Publishing
	}
	return Complete
}

// Stream is a request body the manager can interrupt when a newer request for
// the same upload arrives. The api adapter sets a past read deadline.
type Stream interface {
	io.Reader
	Interrupt()
}

// Counters is what the manager reports to /metrics.
type Counters struct{ BytesReceived func(int64) }

// Publisher is the vault's side of a finished upload.
type Publisher interface {
	Publish(ctx context.Context, p vault.Publication) (disk.Path, error)
	CheckParents(dir disk.Path) error
}

type Manager struct {
	spool    *disk.Tree
	vault    Publisher
	minFree  func(need int64) error
	received func(int64)

	mu      sync.Mutex
	writers map[ID]*writer
}

type writer struct {
	stream Stream
	done   chan struct{}
}

func New(spool *disk.Tree, v Publisher, minFree func(int64) error, c *Counters) *Manager {
	m := &Manager{spool: spool, vault: v, minFree: minFree, writers: map[ID]*writer{}, received: func(int64) {}}
	if c != nil && c.BytesReceived != nil {
		m.received = c.BytesReceived
	}
	return m
}

// record is meta.json.
type record struct {
	Path   string        `json:"path"`
	Length int64         `json:"length"`
	Drop   store.ShareID `json:"drop,omitempty"`
}

type publishRecord struct {
	Path string `json:"path"`
}

func newID() ID {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return ID(hex.EncodeToString(b[:]))
}

// Create writes meta.json into <id>.new, then renames it to <id>. A zero-length
// upload publishes before Create returns.
func (m *Manager) Create(ctx context.Context, s Scope, path disk.Path, length int64) (ID, Status, error) {
	e, ok := path.Entry()
	if !ok {
		return "", Status{}, disk.ErrInvalidPath
	}
	if err := m.minFree(length); err != nil {
		return "", Status{}, err
	}
	if s.Drop == "" {
		if err := m.vault.CheckParents(e.Dir); err != nil {
			return "", Status{}, err
		}
	}
	id := newID()
	rec := record{Path: path.String(), Length: length, Drop: s.Drop}
	encoded, err := json.Marshal(rec)
	if err != nil {
		return "", Status{}, err
	}
	staging, err := disk.ParsePath(string(id) + ".new")
	if err != nil {
		return "", Status{}, err
	}
	if err := m.spool.Mkdir(staging); err != nil {
		return "", Status{}, err
	}
	meta, _ := disk.ParseName(metaFile)
	if err := m.spool.WriteDurable(staging.Join(meta), encoded); err != nil {
		return "", Status{}, err
	}
	if length == 0 {
		data, _ := disk.ParseName(dataFile)
		w, err := m.spool.OpenAppend(staging.Join(data))
		if err != nil {
			return "", Status{}, err
		}
		if err := errors.Join(w.Sync(), w.Close()); err != nil {
			return "", Status{}, err
		}
	}
	from, _ := staging.Entry()
	to, _ := id.dir().Entry()
	if _, err := disk.Move(m.spool, from, m.spool, to); err != nil {
		return "", Status{}, err
	}
	crash.Hit(crash.UploadAfterCreate)
	if length == 0 {
		st, err := m.finish(ctx, id, rec)
		return id, st, err
	}
	return id, Status{Phase: Receiving, Length: length}, nil
}

func (m *Manager) load(s Scope, id ID) (record, error) {
	data, err := m.spool.ReadSmall(id.file(metaFile))
	if errors.Is(err, disk.ErrNotFound) {
		return record{}, ErrNotFound
	}
	if err != nil {
		return record{}, err
	}
	var rec record
	if err := json.Unmarshal(data, &rec); err != nil {
		return record{}, fmt.Errorf("upload %s: %w", id, err)
	}
	if rec.Drop != s.Drop {
		return record{}, ErrNotFound
	}
	return rec, nil
}

func (m *Manager) statusOf(id ID, rec record) (Status, error) {
	var size int64
	hasData, hasPublish := true, true
	info, err := m.spool.Stat(id.file(dataFile))
	switch {
	case err == nil:
		size = info.Size
	case errors.Is(err, disk.ErrNotFound):
		hasData = false
	default:
		return Status{}, err
	}
	if _, err := m.spool.Stat(id.file(publishFile)); errors.Is(err, disk.ErrNotFound) {
		hasPublish = false
	} else if err != nil {
		return Status{}, err
	}
	st := Status{Phase: phaseOf(size, rec.Length, hasData, hasPublish), Offset: size, Length: rec.Length}
	if st.Phase != Published {
		return st, nil
	}
	st.Offset = rec.Length
	if rec.Drop == "" {
		data, err := m.spool.ReadSmall(id.file(publishFile))
		if err != nil {
			return Status{}, err
		}
		var pub publishRecord
		if err := json.Unmarshal(data, &pub); err != nil {
			return Status{}, fmt.Errorf("upload %s: %w", id, err)
		}
		if st.Stored, err = disk.ParsePath(pub.Path); err != nil {
			return Status{}, fmt.Errorf("upload %s: %w", id, err)
		}
	}
	return st, nil
}

// stop interrupts any live writer and waits for it to exit.
func (m *Manager) stop(id ID) {
	for {
		m.mu.Lock()
		w := m.writers[id]
		m.mu.Unlock()
		if w == nil {
			return
		}
		w.stream.Interrupt()
		<-w.done
	}
}

// claim makes body the upload's one writer. It cancels only a live writer, so a
// finished handler's keep-alive connection is never cut by the next takeover.
func (m *Manager) claim(id ID, body Stream) (release func()) {
	for {
		m.mu.Lock()
		w := m.writers[id]
		if w == nil {
			mine := &writer{stream: body, done: make(chan struct{})}
			m.writers[id] = mine
			m.mu.Unlock()
			return func() {
				m.mu.Lock()
				delete(m.writers, id)
				m.mu.Unlock()
				close(mine.done)
			}
		}
		m.mu.Unlock()
		w.stream.Interrupt()
		<-w.done
	}
}

// Status stops any live writer first, so the offset it returns stays true until
// the next Append. It stops a writer without registering, because a finished
// handler's keep-alive connection would otherwise be cut by the next takeover.
func (m *Manager) Status(ctx context.Context, s Scope, id ID) (Status, error) {
	m.stop(id)
	rec, err := m.load(s, id)
	if err != nil {
		return Status{}, err
	}
	return m.statusOf(id, rec)
}

// Append takes over from any live writer, checks offset against the stat size,
// streams through a fixed 1 MiB buffer, fsyncs, and publishes on the last byte.
// Bytes that arrived before a read error are kept and reported in the Status.
func (m *Manager) Append(ctx context.Context, s Scope, id ID, offset int64, body Stream) (Status, error) {
	release := m.claim(id, body)
	defer release()
	rec, err := m.load(s, id)
	if err != nil {
		return Status{}, err
	}
	st, err := m.statusOf(id, rec)
	if err != nil {
		return Status{}, err
	}
	if offset != st.Offset {
		return st, ErrOffsetMismatch
	}
	switch st.Phase {
	case Published:
		return st, nil
	case Complete, Publishing:
		return m.finish(ctx, id, rec)
	}
	if err := m.minFree(rec.Length - offset); err != nil {
		return st, err
	}
	w, err := m.spool.OpenAppend(id.file(dataFile))
	if err != nil {
		return st, mapNoSpace(err)
	}
	n, copyErr := m.copy(w, body, rec.Length-offset)
	syncErr := errors.Join(w.Sync(), w.Close())
	if syncErr != nil {
		return st, mapNoSpace(syncErr)
	}
	st.Offset += n
	if copyErr != nil {
		return st, copyErr
	}
	if st.Offset < rec.Length {
		return st, nil
	}
	st.Phase = Complete
	crash.Hit(crash.UploadAfterSync)
	return m.finish(ctx, id, rec)
}

func mapNoSpace(err error) error {
	if errors.Is(err, disk.ErrNoSpace) {
		return ErrNoSpace
	}
	return err
}

func (m *Manager) copy(w io.Writer, body io.Reader, room int64) (int64, error) {
	buf := make([]byte, bufferSize)
	var written int64
	for {
		n, rerr := body.Read(buf)
		if int64(n) > room-written {
			return written, ErrTooLong
		}
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return written, mapNoSpace(err)
			}
			written += int64(n)
			m.received(int64(n))
			crash.Hit(crash.UploadMidAppend)
		}
		if errors.Is(rerr, io.EOF) {
			return written, nil
		}
		if rerr != nil {
			return written, rerr
		}
	}
}

// finish publishes for a client. A drop whose share is suspended or gone stays
// Complete with no error, because a guest must not learn why.
func (m *Manager) finish(ctx context.Context, id ID, rec record) (Status, error) {
	st, err := m.publish(ctx, id, rec)
	if rec.Drop != "" && (errors.Is(err, vault.ErrUnavailable) || errors.Is(err, vault.ErrShareGone)) {
		return st, nil
	}
	return st, err
}

// publish moves complete bytes into the tree.
func (m *Manager) publish(ctx context.Context, id ID, rec record) (Status, error) {
	st := Status{Phase: Complete, Offset: rec.Length, Length: rec.Length}
	path, err := disk.ParsePath(rec.Path)
	if err != nil {
		return st, err
	}
	from, _ := id.file(dataFile).Entry()
	stored, err := m.vault.Publish(ctx, vault.Publication{
		From: from,
		Drop: rec.Drop,
		Path: path,
		Intent: func(to disk.Path) error {
			encoded, err := json.Marshal(publishRecord{Path: to.String()})
			if err != nil {
				return err
			}
			if err := m.spool.WriteDurable(id.file(publishFile), encoded); err != nil {
				return err
			}
			crash.Hit(crash.UploadAfterIntent)
			return nil
		},
	})
	if err != nil {
		return st, err
	}
	crash.Hit(crash.UploadAfterPublish)
	st.Phase = Published
	if rec.Drop == "" {
		st.Stored = stored
	}
	return st, nil
}

// Cancel removes meta.json, then the directory.
func (m *Manager) Cancel(ctx context.Context, s Scope, id ID) error {
	m.stop(id)
	if _, err := m.load(s, id); err != nil {
		return err
	}
	return m.remove(id)
}

func (m *Manager) remove(id ID) error {
	if err := m.spool.Remove(id.file(metaFile)); err != nil && !errors.Is(err, disk.ErrNotFound) {
		return err
	}
	return m.spool.RemoveAll(id.dir())
}

// settle converges one spool directory. Anything without a readable meta.json is
// doomed. Complete bytes are offered to the vault again, and a complete drop
// upload whose share no longer exists is removed. ok is false when nothing is left.
func (m *Manager) settle(ctx context.Context, name string) (id ID, st Status, ok bool) {
	id, err := ParseID(name)
	if err != nil {
		m.discard(name)
		return "", Status{}, false
	}
	data, err := m.spool.ReadSmall(id.file(metaFile))
	var rec record
	if err == nil {
		err = json.Unmarshal(data, &rec)
	}
	if err != nil {
		m.discard(name)
		return "", Status{}, false
	}
	if st, err = m.statusOf(id, rec); err != nil {
		slog.Error("reading an upload", "id", name, "err", err)
		return "", Status{}, false
	}
	if st.Phase != Complete && st.Phase != Publishing {
		return id, st, true
	}
	st, err = m.publish(ctx, id, rec)
	switch {
	case errors.Is(err, vault.ErrShareGone):
		if err := m.remove(id); err != nil {
			slog.Error("removing an upload whose drop link is gone", "id", name, "err", err)
		}
		return "", Status{}, false
	case errors.Is(err, vault.ErrUnavailable):
	case err != nil:
		slog.Error("publishing a complete upload", "id", name, "err", err)
	}
	return id, st, true
}

func (m *Manager) discard(name string) {
	p, err := disk.ParsePath(name)
	if err == nil {
		err = m.spool.RemoveAll(p)
	}
	if err != nil {
		slog.Error("removing a dead spool entry", "name", name, "err", err)
	}
}

func (m *Manager) entries() ([]disk.Info, error) { return m.spool.List(disk.Path{}) }

// Recover removes half-created and metaless directories, and publishes any
// upload whose bytes all arrived. Running it twice changes nothing.
func (m *Manager) Recover(ctx context.Context) error {
	entries, err := m.entries()
	if err != nil {
		return err
	}
	for _, e := range entries {
		m.settle(ctx, e.Name)
	}
	return nil
}

// Sweep expires idle uploads and old tombstones. It leaves a live writer alone.
func (m *Manager) Sweep(ctx context.Context, now time.Time) error {
	entries, err := m.entries()
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		if m.live(ID(e.Name)) {
			continue
		}
		id, st, ok := m.settle(ctx, e.Name)
		if !ok {
			continue
		}
		if idle, err := m.expired(id, st.Phase, now); err != nil {
			errs = append(errs, err)
		} else if idle {
			errs = append(errs, m.remove(id))
		}
	}
	return errors.Join(errs...)
}

func (m *Manager) live(id ID) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.writers[id] != nil
}

func (m *Manager) expired(id ID, phase Phase, now time.Time) (bool, error) {
	if phase == Published {
		info, err := m.spool.Stat(id.file(publishFile))
		if err != nil {
			return false, err
		}
		return now.Sub(info.ModTime) >= TombstoneTTL, nil
	}
	last := time.Time{}
	for _, name := range []string{metaFile, dataFile} {
		info, err := m.spool.Stat(id.file(name))
		if errors.Is(err, disk.ErrNotFound) {
			continue
		}
		if err != nil {
			return false, err
		}
		if info.ModTime.After(last) {
			last = info.ModTime
		}
	}
	return now.Sub(last) >= IdleTTL, nil
}

// Stats is what /metrics reads: bytes held in the spool and uploads being written.
func (m *Manager) Stats(ctx context.Context) (bytes uint64, active int, err error) {
	err = m.spool.Walk(ctx, disk.Path{}, func(_ disk.Path, info disk.Info) error {
		bytes += uint64(info.Size)
		return nil
	})
	m.mu.Lock()
	defer m.mu.Unlock()
	return bytes, len(m.writers), err
}
