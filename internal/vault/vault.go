// Package vault owns everything that changes where a thing lives: rename, move,
// trash, restore, purge, and the share rows that must follow. It is the single
// writer of the live namespace's structure, and it is the only caller of
// disk.Move for the trash.
//
// One rule converges every crash: journal the intent, rename, then commit the
// share rewrite. On restart the disk decides. If the destination exists the
// rename happened, so commit. Otherwise drop the intent.
package vault

import (
	"context"
	"errors"
	"sync"
	"time"

	"storage-server/internal/disk"
	"storage-server/internal/store"
)

// Retention is how long a trash item lives.
const Retention = 30 * 24 * time.Hour

var ErrMoveIntoSelf = errors.New("cannot move a folder into itself")

// Item is one trash entry, read from its own directory. A database loss cannot
// lose it: <id>/meta.json and <id>/item are the whole record.
type Item struct {
	ID        disk.TrashID
	Original  disk.Path
	Name      string
	Kind      disk.Kind
	DeletedAt time.Time
}

// Outcome is one element of a multi-select result.
type Outcome struct {
	From disk.Path
	To   disk.Path
	Err  error
}

type Vault struct {
	disk *disk.Disk
	db   *store.Store
	mu   sync.Mutex
}

func New(d *disk.Disk, db *store.Store) *Vault { return &Vault{disk: d, db: db} }

func (v *Vault) Rename(ctx context.Context, e disk.Entry, to disk.Name) (disk.Path, error) {
	panic("not implemented")
}

// Move moves each entry into a folder. Items fail independently.
func (v *Vault) Move(ctx context.Context, from []disk.Entry, toDir disk.Path) []Outcome {
	panic("not implemented")
}

// Trash suspends every share at or under each entry by moving it.
func (v *Vault) Trash(ctx context.Context, entries []disk.Entry, now time.Time) []Outcome {
	panic("not implemented")
}

// Restore returns the item to its original path, recreating parents. If that
// path is taken it uses the first free disk.Candidates name and shares follow.
func (v *Vault) Restore(ctx context.Context, id disk.TrashID) (disk.Path, error) {
	panic("not implemented")
}

// ListTrash reads the trash directory.
func (v *Vault) ListTrash(ctx context.Context) ([]Item, error) { panic("not implemented") }

// CreateShare checks the target and inserts under the lock, so a target cannot
// move between the check and the insert.
func (v *Vault) CreateShare(ctx context.Context, sh store.Share, target disk.Path) (store.Share, error) {
	panic("not implemented")
}

// Sweep purges items past Retention. A purge removes meta.json first, which is
// the commit point: an item without meta.json is never listed or restored.
func (v *Vault) Sweep(ctx context.Context, now time.Time) error { panic("not implemented") }

// Recover replays the journal, then deletes any trash directory that lacks
// meta.json or item, along with shares still pointing into it. Running it twice
// changes nothing.
func (v *Vault) Recover(ctx context.Context) error { panic("not implemented") }

// relocate is the one implementation of journal, rename, commit. Rename, Move,
// Trash and Restore all reach the disk through it, with v.mu held.
func (v *Vault) relocate(ctx context.Context, from, to disk.Location) error {
	panic("not implemented")
}
