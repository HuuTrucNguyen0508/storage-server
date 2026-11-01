// Package vault owns everything that changes where a thing lives: rename, move,
// trash, restore, purge, upload publish, and the share rows that must follow. It
// is the single writer of the live namespace's structure, and it is the only
// caller of disk.Move for the trash and for the live tree.
//
// One rule converges every crash: journal the intent with the source's inode,
// rename, then commit the share rewrite. On restart the disk decides, by inode.
// The destination holds the inode: commit. The source still holds it: drop the
// intent. Neither: something outside the app replaced both paths, so the shares
// that pointed there are deleted.
package vault

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"storage-server/internal/crash"
	"storage-server/internal/disk"
	"storage-server/internal/store"
)

// Retention is how long a trash item lives.
const Retention = 30 * 24 * time.Hour

const (
	metaFile = "meta.json"
	itemName = "item"
)

var (
	ErrMoveIntoSelf = errors.New("cannot move a folder into itself")
	// ErrUnavailable covers a share target that is trashed, missing, or was
	// replaced by something that cannot be served.
	ErrUnavailable = errors.New("share target is not available")
	ErrShareGone   = errors.New("share no longer exists")
)

// Item is one trash entry, read from its own directory. A database loss cannot
// lose it: <id>/meta.json and <id>/item are the whole record.
type Item struct {
	ID        disk.TrashID
	Original  disk.Path
	Name      string
	Kind      disk.Kind
	DeletedAt time.Time
}

type meta struct {
	OriginalPath string    `json:"originalPath"`
	Name         string    `json:"name"`
	Kind         disk.Kind `json:"kind"`
	DeletedAt    time.Time `json:"deletedAt"`
}

// Outcome is one element of a multi-select result.
type Outcome struct {
	From  disk.Path
	To    disk.Path
	Trash disk.TrashID
	Err   error
}

// Vault holds mu for every namespace change, and for reading across a guest's
// target resolve. mu is never held across a request body or a download stream.
type Vault struct {
	disk      *disk.Disk
	db        *store.Store
	mu        sync.RWMutex
	unhealthy atomic.Bool
}

func New(d *disk.Disk, db *store.Store) *Vault { return &Vault{disk: d, db: db} }

// Healthy is false after a rename whose durability or commit failed. Only a
// restart clears it, because only recovery can finish that move.
func (v *Vault) Healthy() bool { return !v.unhealthy.Load() }

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// ParseID validates a trash ID from a URL.
func ParseID(raw string) (disk.TrashID, error) {
	if b, err := hex.DecodeString(raw); err != nil || len(b) != 16 {
		return "", disk.ErrNotFound
	}
	return disk.TrashID(raw), nil
}

func trashPath(id disk.TrashID, name string) disk.Path {
	p, err := disk.ParsePath(string(id) + "/" + name)
	if err != nil {
		panic(err)
	}
	return p
}

func (v *Vault) locate(l disk.Location) (*disk.Tree, disk.Path) {
	if p, live := l.LivePath(); live {
		return v.disk.Files, p
	}
	id, rel, _ := l.Trashed()
	return v.disk.Trash, trashPath(id, itemName).Under(rel)
}

// relocate is the one implementation of journal, rename, commit. Rename, Move,
// Trash and Restore all reach the disk through it, with v.mu held. A client
// disconnect must not stop it halfway, so it ignores ctx cancellation.
func (v *Vault) relocate(ctx context.Context, from, to disk.Location) error {
	ctx = context.WithoutCancel(ctx)
	srcTree, srcPath := v.locate(from)
	dstTree, dstPath := v.locate(to)
	src, ok := srcPath.Entry()
	dst, ok2 := dstPath.Entry()
	if !ok || !ok2 {
		return disk.ErrInvalidPath
	}
	if _, err := dstTree.Stat(dstPath); err == nil {
		return disk.ErrExists
	} else if !errors.Is(err, disk.ErrNotFound) {
		return err
	}
	info, err := srcTree.Stat(srcPath)
	if err != nil {
		return err
	}
	id, err := v.db.BeginMove(ctx, from, to, info.Inode)
	if err != nil {
		return err
	}
	crash.Hit(crash.MoveAfterIntent)
	renamed, err := disk.Move(srcTree, src, dstTree, dst)
	if !renamed {
		return errors.Join(err, v.db.AbortMove(ctx, id))
	}
	crash.Hit(crash.MoveAfterRename)
	if err != nil {
		v.markUnhealthy(from, to, err)
		return err
	}
	if err := v.db.CommitMove(ctx, store.PendingMove{ID: id, From: from, To: to}); err != nil {
		v.markUnhealthy(from, to, err)
		return fmt.Errorf("%w: %w", disk.ErrNotDurable, err)
	}
	crash.Hit(crash.MoveAfterCommit)
	return nil
}

func (v *Vault) markUnhealthy(from, to disk.Location, err error) {
	v.unhealthy.Store(true)
	slog.Error("move kept in the journal until restart", "from", from.String(), "to", to.String(), "err", err)
}

func (v *Vault) Rename(ctx context.Context, e disk.Entry, to disk.Name) (disk.Path, error) {
	target, err := e.Dir.Child(to)
	if err != nil {
		return disk.Path{}, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.relocate(ctx, disk.Live(e.Path()), disk.Live(target.Path())); err != nil {
		return disk.Path{}, err
	}
	return target.Path(), nil
}

// Move moves each entry into a folder. Items fail independently.
func (v *Vault) Move(ctx context.Context, from []disk.Entry, toDir disk.Path) []Outcome {
	out := make([]Outcome, 0, len(from))
	for _, e := range from {
		to, err := v.moveOne(ctx, e, toDir)
		out = append(out, Outcome{From: e.Path(), To: to, Err: err})
	}
	return out
}

func (v *Vault) moveOne(ctx context.Context, e disk.Entry, toDir disk.Path) (disk.Path, error) {
	if e.Path().Contains(toDir) {
		return disk.Path{}, ErrMoveIntoSelf
	}
	target, err := toDir.Child(e.Name)
	if err != nil {
		return disk.Path{}, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	switch info, err := v.disk.Files.Stat(toDir); {
	case err != nil:
		return disk.Path{}, err
	case info.Kind == disk.KindSymlink:
		return disk.Path{}, disk.ErrSymlink
	case info.Kind != disk.KindDir:
		return disk.Path{}, disk.ErrNotDirectory
	}
	if err := v.relocate(ctx, disk.Live(e.Path()), disk.Live(target.Path())); err != nil {
		return disk.Path{}, err
	}
	return target.Path(), nil
}

// Mkdir goes through the vault so that a folder cannot appear in the middle of a
// relocate's check and rename.
func (v *Vault) Mkdir(p disk.Path) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.disk.Files.Mkdir(p)
}

// Trash suspends every share at or under each entry by moving it.
func (v *Vault) Trash(ctx context.Context, entries []disk.Entry, now time.Time) []Outcome {
	out := make([]Outcome, 0, len(entries))
	for _, e := range entries {
		id, err := v.trashOne(ctx, e, now)
		out = append(out, Outcome{From: e.Path(), Trash: id, Err: err})
	}
	return out
}

func (v *Vault) trashOne(ctx context.Context, e disk.Entry, now time.Time) (disk.TrashID, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	info, err := v.disk.Files.Stat(e.Path())
	if err != nil {
		return "", err
	}
	id := disk.TrashID(newID())
	record, err := json.Marshal(meta{OriginalPath: e.Path().String(), Name: e.Name.String(), Kind: info.Kind, DeletedAt: now.UTC()})
	if err != nil {
		return "", err
	}
	dir, err := disk.ParsePath(string(id))
	if err != nil {
		return "", err
	}
	if err := v.disk.Trash.Mkdir(dir); err != nil {
		return "", err
	}
	if err := v.disk.Trash.WriteDurable(trashPath(id, metaFile), record); err != nil {
		return "", errors.Join(err, v.disk.Trash.RemoveAll(dir))
	}
	crash.Hit(crash.TrashAfterMeta)
	if err := v.relocate(ctx, disk.Live(e.Path()), disk.InTrash(id, disk.Path{})); err != nil {
		if errors.Is(err, disk.ErrNotDurable) {
			return id, err
		}
		return "", errors.Join(err, v.disk.Trash.RemoveAll(dir))
	}
	return id, nil
}

func (v *Vault) readMeta(id disk.TrashID) (meta, disk.Path, error) {
	data, err := v.disk.Trash.ReadSmall(trashPath(id, metaFile))
	if err != nil {
		return meta{}, disk.Path{}, err
	}
	var m meta
	if err := json.Unmarshal(data, &m); err != nil {
		return meta{}, disk.Path{}, fmt.Errorf("trash item %s: %w", id, err)
	}
	original, err := disk.ParsePath(m.OriginalPath)
	if err != nil {
		return meta{}, disk.Path{}, fmt.Errorf("trash item %s: %w", id, err)
	}
	return m, original, nil
}

// Restore returns the item to its original path, recreating parents. If that
// path is taken it uses the first free disk.Candidates name and shares follow.
func (v *Vault) Restore(ctx context.Context, id disk.TrashID) (disk.Path, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	_, original, err := v.readMeta(id)
	if err != nil {
		return disk.Path{}, err
	}
	if _, err := v.disk.Trash.Stat(trashPath(id, itemName)); err != nil {
		return disk.Path{}, err
	}
	e, ok := original.Entry()
	if !ok {
		return disk.Path{}, disk.ErrInvalidPath
	}
	if err := v.disk.Files.Mkdir(e.Dir); err != nil {
		return disk.Path{}, err
	}
	dir, err := disk.ParsePath(string(id))
	if err != nil {
		return disk.Path{}, err
	}
	for name := range disk.Candidates(e.Name) {
		target := disk.Entry{Dir: e.Dir, Name: name}
		err := v.relocate(ctx, disk.InTrash(id, disk.Path{}), disk.Live(target.Path()))
		if errors.Is(err, disk.ErrExists) {
			continue
		}
		if err != nil {
			return disk.Path{}, err
		}
		crash.Hit(crash.RestoreAfterCommit)
		if err := v.disk.Trash.RemoveAll(dir); err != nil {
			return disk.Path{}, err
		}
		return target.Path(), nil
	}
	return disk.Path{}, disk.ErrExists
}

// ListTrash reads the trash directory, newest first. Only a directory holding
// both meta.json and item is an item.
func (v *Vault) ListTrash(ctx context.Context) ([]Item, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	entries, err := v.disk.Trash.List(disk.Path{})
	if err != nil {
		return nil, err
	}
	items := make([]Item, 0, len(entries))
	for _, e := range entries {
		id, err := ParseID(e.Name)
		if err != nil {
			continue
		}
		m, original, err := v.readMeta(id)
		if errors.Is(err, disk.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if _, err := v.disk.Trash.Stat(trashPath(id, itemName)); err != nil {
			continue
		}
		items = append(items, Item{ID: id, Original: original, Name: m.Name, Kind: m.Kind, DeletedAt: m.DeletedAt})
	}
	slices.SortFunc(items, func(a, b Item) int { return b.DeletedAt.Compare(a.DeletedAt) })
	return items, nil
}

// Purge deletes one trash item for good. Removing meta.json is the commit point:
// an item without it is never listed or restored. The tree is removed after the
// lock is released, because a large folder must not stop every other operation.
func (v *Vault) Purge(ctx context.Context, id disk.TrashID) error {
	if err := v.commitPurge(context.WithoutCancel(ctx), id); err != nil {
		return err
	}
	return v.removeTrash(id)
}

func (v *Vault) commitPurge(ctx context.Context, id disk.TrashID) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.disk.Trash.Remove(trashPath(id, metaFile)); err != nil {
		return err
	}
	crash.Hit(crash.PurgeAfterMeta)
	if err := v.db.DeleteSharesAt(ctx, disk.InTrash(id, disk.Path{})); err != nil {
		return err
	}
	crash.Hit(crash.PurgeAfterShares)
	return nil
}

func (v *Vault) removeTrash(id disk.TrashID) error {
	item := trashPath(id, itemName)
	if children, err := v.disk.Trash.List(item); err == nil && len(children) > 0 {
		if first, err := disk.ParseName(children[0].Name); err == nil {
			if err := v.disk.Trash.RemoveAll(item.Join(first)); err != nil {
				return err
			}
		}
	}
	crash.Hit(crash.PurgeMidRemove)
	dir, err := disk.ParsePath(string(id))
	if err != nil {
		return err
	}
	return v.disk.Trash.RemoveAll(dir)
}

// PurgeAll empties the trash. It keeps going after a failure, since one stuck
// item must not hold the rest of the owner's space.
func (v *Vault) PurgeAll(ctx context.Context) error {
	items, err := v.ListTrash(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, it := range items {
		errs = append(errs, v.Purge(ctx, it.ID))
	}
	return errors.Join(errs...)
}

// Sweep purges items past Retention.
func (v *Vault) Sweep(ctx context.Context, now time.Time) error {
	items, err := v.ListTrash(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, it := range items {
		if now.Sub(it.DeletedAt) >= Retention {
			errs = append(errs, v.Purge(ctx, it.ID))
		}
	}
	return errors.Join(errs...)
}

// CreateShare checks the target and inserts under the lock, so a target cannot
// move between the check and the insert.
func (v *Vault) CreateShare(ctx context.Context, sh store.Share, target disk.Path) (store.Share, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	info, err := v.disk.Files.Stat(target)
	if err != nil {
		return store.Share{}, err
	}
	switch {
	case info.Kind != disk.KindFile && info.Kind != disk.KindDir:
		return store.Share{}, ErrNotShareable
	case sh.Kind == store.ShareDrop && info.Kind != disk.KindDir:
		return store.Share{}, ErrDropNeedsFolder
	}
	sh.Target = disk.Live(target)
	if err := v.db.CreateShare(ctx, sh); err != nil {
		return store.Share{}, err
	}
	return sh, nil
}

var (
	ErrNotShareable    = errors.New("only a file or a folder can be shared")
	ErrDropNeedsFolder = errors.New("a drop link needs a folder")
)

func (v *Vault) targetExists(l disk.Location) bool {
	p, live := l.LivePath()
	if !live {
		return true
	}
	info, err := v.disk.Files.Stat(p)
	return err == nil && (info.Kind == disk.KindFile || info.Kind == disk.KindDir)
}

// ShareByToken loads a share and stats its target under the read lock. Done apart,
// a rename between the two would make a working link look missing.
func (v *Vault) ShareByToken(ctx context.Context, t store.Token) (store.Share, bool, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	sh, err := v.db.ShareByToken(ctx, t)
	if err != nil {
		return store.Share{}, false, err
	}
	return sh, v.targetExists(sh.Target), nil
}

// Listed is one row of the owner's link list.
type Listed struct {
	Share  store.Share
	Exists bool
}

// Shares is ShareByToken for the whole list.
func (v *Vault) Shares(ctx context.Context) ([]Listed, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	shares, err := v.db.ListShares(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Listed, 0, len(shares))
	for _, sh := range shares {
		out = append(out, Listed{sh, v.targetExists(sh.Target)})
	}
	return out, nil
}

// Opened is a guest's descriptor on a share's target: Dir for a folder, File for
// a file. Exactly one is set. It keeps following what it opened, wherever that
// moves, which is why a stream that started keeps its bytes across a rename.
type Opened struct {
	Dir  *disk.Tree
	File *disk.File
}

func (o Opened) Close() {
	if o.Dir != nil {
		o.Dir.Close()
	}
	if o.File != nil {
		o.File.Close()
	}
}

// OpenShare loads the share's current target and opens it, all under the read
// lock. Without the lock a guest could load target a, the owner could rename a
// to b, a private upload could publish at a, and the guest would open it.
func (v *Vault) OpenShare(ctx context.Context, id store.ShareID) (Opened, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	sh, err := v.db.ShareByID(ctx, id)
	if err != nil {
		return Opened{}, err
	}
	p, live := sh.Target.LivePath()
	if !live {
		return Opened{}, ErrUnavailable
	}
	crash.Pause(crash.GuestAfterLoad)
	f, err := v.disk.Files.Open(p)
	if err == nil {
		return Opened{File: f}, nil
	}
	if !errors.Is(err, disk.ErrNotRegular) {
		return Opened{}, ErrUnavailable
	}
	dir, err := v.disk.Files.Sub(p)
	if err != nil {
		return Opened{}, ErrUnavailable
	}
	return Opened{Dir: dir}, nil
}

// Original gives the path the owner knows a location by. A trashed target shows
// where it came from, or empty when the item's record cannot be read.
func (v *Vault) Original(l disk.Location) string {
	if p, live := l.LivePath(); live {
		return p.String()
	}
	id, rel, _ := l.Trashed()
	_, original, err := v.readMeta(id)
	if err != nil {
		return ""
	}
	return original.Under(rel).String()
}

// Publication is one finished upload leaving the spool.
type Publication struct {
	From disk.Entry // inside the spool
	// Drop names the share to publish into. Empty means the owner, and Path is
	// then relative to the storage root. For a drop, Path is relative to the
	// share's folder as it is now, so the upload follows a moved folder.
	Drop store.ShareID
	Path disk.Path
	// Intent runs before each rename attempt, under the lock, with the chosen path.
	Intent func(disk.Path) error
}

// Publish is the one way an upload enters the namespace. A taken name gets the
// next candidate, so an upload never replaces anything.
func (v *Vault) Publish(ctx context.Context, p Publication) (disk.Path, error) {
	ctx = context.WithoutCancel(ctx)
	v.mu.Lock()
	defer v.mu.Unlock()
	e, ok := p.Path.Entry()
	if !ok {
		return disk.Path{}, disk.ErrInvalidPath
	}
	dir := e.Dir
	if p.Drop == "" {
		if err := v.disk.Files.Mkdir(dir); err != nil {
			return disk.Path{}, err
		}
	} else {
		sh, err := v.db.ShareByID(ctx, p.Drop)
		if errors.Is(err, store.ErrNotFound) {
			return disk.Path{}, ErrShareGone
		}
		if err != nil {
			return disk.Path{}, err
		}
		folder, live := sh.Target.LivePath()
		if !live {
			return disk.Path{}, ErrUnavailable
		}
		if info, err := v.disk.Files.Stat(folder); err != nil || info.Kind != disk.KindDir {
			return disk.Path{}, ErrUnavailable
		}
		dir = folder.Under(dir)
	}
	for name := range disk.Candidates(e.Name) {
		target, err := dir.Child(name)
		if err != nil {
			return disk.Path{}, err
		}
		if _, err := v.disk.Files.Stat(target.Path()); err == nil {
			continue
		} else if !errors.Is(err, disk.ErrNotFound) {
			return disk.Path{}, err
		}
		if err := p.Intent(target.Path()); err != nil {
			return disk.Path{}, err
		}
		renamed, err := disk.Move(v.disk.Spool, p.From, v.disk.Files, target)
		if errors.Is(err, disk.ErrExists) {
			continue
		}
		if renamed && err != nil {
			v.unhealthy.Store(true)
			slog.Error("published without a durable rename", "to", target.Path().String(), "err", err)
		}
		if err != nil {
			return disk.Path{}, err
		}
		return target.Path(), nil
	}
	return disk.Path{}, disk.ErrExists
}

// CheckParents reports whether a file could be published under dir. A missing
// folder is fine, since publish creates it. It lets an upload fail at creation
// instead of after the last byte.
func (v *Vault) CheckParents(dir disk.Path) error {
	if dir.IsRoot() {
		return nil
	}
	info, err := v.disk.Files.Stat(dir)
	switch {
	case errors.Is(err, disk.ErrNotFound):
		e, _ := dir.Entry()
		return v.CheckParents(e.Dir)
	case err != nil:
		return err
	case info.Kind == disk.KindDir:
		return nil
	case info.Kind == disk.KindSymlink:
		return disk.ErrSymlink
	}
	return disk.ErrExists
}

// Recover replays the journal, then deletes any trash directory that lacks
// meta.json or item, along with shares still pointing into it. It returns how
// many things it changed. Running it twice changes nothing.
func (v *Vault) Recover(ctx context.Context) (int, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	moves, err := v.db.PendingMoves(ctx)
	if err != nil {
		return 0, err
	}
	actions := 0
	for _, m := range moves {
		if err := v.recoverMove(ctx, m); err != nil {
			return actions, fmt.Errorf("recover move %d: %w", m.ID, err)
		}
		actions++
	}
	n, err := v.recoverTrash(ctx)
	return actions + n, err
}

func (v *Vault) inodeAt(l disk.Location, inode uint64) (bool, error) {
	tree, p := v.locate(l)
	info, err := tree.Stat(p)
	if errors.Is(err, disk.ErrNotFound) || errors.Is(err, disk.ErrSymlink) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.Inode == inode, nil
}

func (v *Vault) recoverMove(ctx context.Context, m store.PendingMove) error {
	atDst, err := v.inodeAt(m.To, m.Inode)
	if err != nil {
		return err
	}
	if atDst {
		if err := v.syncParents(m); err != nil {
			v.markUnhealthy(m.From, m.To, err)
			return nil
		}
		slog.Info("recovery committed a move", "from", m.From.String(), "to", m.To.String())
		return v.db.CommitMove(ctx, m)
	}
	atSrc, err := v.inodeAt(m.From, m.Inode)
	if err != nil {
		return err
	}
	if atSrc {
		slog.Info("recovery dropped a move that did not happen", "from", m.From.String(), "to", m.To.String())
		return v.db.AbortMove(ctx, m.ID)
	}
	slog.Warn("both paths of a journaled move changed outside the app, deleting its shares",
		"from", m.From.String(), "to", m.To.String())
	return v.db.ForgetMove(ctx, m)
}

// syncParents retries the durability a failed fsync left open. A journal row is
// deleted only after both parents are durable. A source parent that has since
// disappeared has nothing left to sync.
func (v *Vault) syncParents(m store.PendingMove) error {
	for _, l := range []disk.Location{m.From, m.To} {
		tree, p := v.locate(l)
		e, ok := p.Entry()
		if !ok {
			continue
		}
		if err := tree.Sync(e.Dir); err != nil && !errors.Is(err, disk.ErrNotFound) {
			return err
		}
	}
	return nil
}

func (v *Vault) recoverTrash(ctx context.Context) (int, error) {
	entries, err := v.disk.Trash.List(disk.Path{})
	if err != nil {
		return 0, err
	}
	actions := 0
	for _, e := range entries {
		dir, err := disk.ParsePath(e.Name)
		if err != nil {
			slog.Warn("leaving an unreadable name in the trash", "name", e.Name)
			continue
		}
		id := disk.TrashID(e.Name)
		hasMeta, err := v.exists(trashPath(id, metaFile))
		if err != nil {
			return actions, err
		}
		hasItem, err := v.exists(trashPath(id, itemName))
		if err != nil {
			return actions, err
		}
		if hasMeta && hasItem {
			continue
		}
		if !hasMeta {
			if err := v.db.DeleteSharesAt(ctx, disk.InTrash(id, disk.Path{})); err != nil {
				return actions, err
			}
		}
		if err := v.disk.Trash.RemoveAll(dir); err != nil {
			return actions, err
		}
		actions++
	}
	return actions, nil
}

func (v *Vault) exists(p disk.Path) (bool, error) {
	_, err := v.disk.Trash.Stat(p)
	if errors.Is(err, disk.ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}
