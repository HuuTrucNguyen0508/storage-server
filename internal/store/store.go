// Package store owns the SQLite file: account, sessions, shares, grants, the
// move journal and the limiter. SQL and rows stay private to this package.
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"time"

	"storage-server/internal/disk"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

// rewriteTargets moves every share at or under ?1 to the same place under ?2.
// It compares with substr, not LIKE, because a real path can contain % and _.
const rewriteTargets = `
UPDATE shares SET target = ?2 || substr(target, length(?1) + 1)
WHERE target = ?1 OR substr(target, 1, length(?1) + 1) = ?1 || '/'`

// deleteTargets removes every share at or under ?1, for a purged trash item.
const deleteTargets = `
DELETE FROM shares
WHERE target = ?1 OR substr(target, 1, length(?1) + 1) = ?1 || '/'`

// takeUse admits one more guest session. Zero rows changed means exhausted.
const takeUse = `
UPDATE shares SET uses = uses + 1
WHERE id = ?1 AND (max_uses IS NULL OR uses < max_uses)`

// consumeGrant marks a grant used. Zero rows changed means it was already used.
const consumeGrant = `
UPDATE grants SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL`

var (
	ErrNotFound  = errors.New("not found")
	ErrExists    = errors.New("already exists")
	ErrExhausted = errors.New("share exhausted")
)

type (
	SessionID string
	ShareID   string
	GrantID   string
	Token     string
	MoveID    int64
)

type ShareKind string

const (
	ShareLink ShareKind = "link"
	ShareDrop ShareKind = "drop"
)

type Share struct {
	ID           ShareID
	Token        Token
	Kind         ShareKind
	Target       disk.Location
	PasswordHash string
	ExpiresAt    *time.Time
	MaxUses      *int
	Uses         int
	CreatedAt    time.Time
}

type Session struct {
	ID         SessionID
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time
	UserAgent  string
	ClientIP   string
}

type Grant struct {
	ID        GrantID
	ShareID   ShareID
	ExpiresAt time.Time
	Consumed  bool
}

type PendingMove struct {
	ID       MoveID
	From, To disk.Location
}

type LimiterState struct {
	Failures    int
	LockedUntil time.Time
}

type Store struct{ db *sql.DB }

// Open creates or opens the database and applies the schema when user_version is 0.
func Open(ctx context.Context, path string) (*Store, error) { panic("not implemented") }

func (s *Store) Close() error { return s.db.Close() }

// Ping backs /healthz.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *Store) OwnerHash(ctx context.Context) (hash string, ok bool, err error) {
	panic("not implemented")
}

// CreateOwner returns ErrExists after the first success, so setup can happen once.
func (s *Store) CreateOwner(ctx context.Context, hash string) error { panic("not implemented") }

func (s *Store) CreateSession(ctx context.Context, sess Session, tokenHash []byte) error {
	panic("not implemented")
}

// TouchSession finds a live session and advances last_seen_at at most once a minute.
func (s *Store) TouchSession(ctx context.Context, tokenHash []byte, now time.Time) (Session, error) {
	panic("not implemented")
}
func (s *Store) ListSessions(ctx context.Context) ([]Session, error) { panic("not implemented") }
func (s *Store) DeleteSession(ctx context.Context, id SessionID) error {
	panic("not implemented")
}

func (s *Store) CreateShare(ctx context.Context, sh Share) error { panic("not implemented") }
func (s *Store) ShareByToken(ctx context.Context, t Token) (Share, error) {
	panic("not implemented")
}
func (s *Store) ShareByID(ctx context.Context, id ShareID) (Share, error) {
	panic("not implemented")
}
func (s *Store) ListShares(ctx context.Context) ([]Share, error)   { panic("not implemented") }
func (s *Store) DeleteShare(ctx context.Context, id ShareID) error { panic("not implemented") }

// DeleteSharesAt drops shares at or under a location, for a purged trash item.
func (s *Store) DeleteSharesAt(ctx context.Context, at disk.Location) error {
	panic("not implemented")
}

func (s *Store) CreateGrant(ctx context.Context, g Grant, tokenHash []byte) error {
	panic("not implemented")
}
func (s *Store) GrantByHash(ctx context.Context, tokenHash []byte) (Grant, error) {
	panic("not implemented")
}

// ConsumeGrant runs consumeGrant and takeUse in one transaction. It is
// idempotent per grant and returns ErrExhausted when no use remains.
func (s *Store) ConsumeGrant(ctx context.Context, g GrantID, sh ShareID, now time.Time) error {
	panic("not implemented")
}

// BeginMove records intent before the rename.
func (s *Store) BeginMove(ctx context.Context, from, to disk.Location) (MoveID, error) {
	panic("not implemented")
}

// CommitMove runs rewriteTargets and deletes the journal row in one transaction.
func (s *Store) CommitMove(ctx context.Context, m PendingMove) error { panic("not implemented") }

// AbortMove deletes the journal row after the rename did not happen.
func (s *Store) AbortMove(ctx context.Context, id MoveID) error { panic("not implemented") }

func (s *Store) PendingMoves(ctx context.Context) ([]PendingMove, error) {
	panic("not implemented")
}

func (s *Store) Limiter(ctx context.Context, key string) (LimiterState, error) {
	panic("not implemented")
}
func (s *Store) SetLimiter(ctx context.Context, key string, st LimiterState) error {
	panic("not implemented")
}

// Prune deletes expired sessions and grants.
func (s *Store) Prune(ctx context.Context, now time.Time) error { panic("not implemented") }
