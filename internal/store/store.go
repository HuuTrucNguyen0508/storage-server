// Package store owns the SQLite file: account, sessions, shares, grants, the
// move journal and the limiter. SQL and rows stay private to this package.
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"storage-server/internal/disk"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

const schemaVersion = 1

// rewriteTargets moves every share at or under ?1 to the same place under ?2.
// It compares with substr, not LIKE, because a real path can contain % and _.
const rewriteTargets = `
UPDATE shares SET target = ?2 || substr(target, length(?1) + 1)
WHERE target = ?1 OR substr(target, 1, length(?1) + 1) = ?1 || '/'`

// deleteTargets removes every share at or under ?1, for a purged trash item.
const deleteTargets = `
DELETE FROM shares
WHERE target = ?1 OR substr(target, 1, length(?1) + 1) = ?1 || '/'`

// takeUse admits one more use. Zero rows changed means exhausted.
const takeUse = `
UPDATE shares SET uses = uses + 1
WHERE id = ?1 AND (max_uses IS NULL OR uses < max_uses)`

// recordItem marks an item fetched. Zero rows changed means the grant holds it.
const recordItem = `
INSERT INTO grant_items (grant_id, item) VALUES (?1, ?2) ON CONFLICT DO NOTHING`

const shareColumns = `id, token, kind, target, password_hash, expires_at, max_uses, uses, created_at`

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

// Grant is a guest's admission to one share. Consumed reports whether it holds
// any item, which is what lets it outlive the share becoming Exhausted.
type Grant struct {
	ID        GrantID
	ShareID   ShareID
	ExpiresAt time.Time
	Consumed  bool
}

// PendingMove is one journaled rename. Inode is the source's, read before the
// rename, so recovery can tell the moved file from a stranger at either path.
type PendingMove struct {
	ID       MoveID
	From, To disk.Location
	Inode    uint64
}

type LimiterState struct {
	Failures    int
	LockedUntil time.Time
}

type Store struct{ db *sql.DB }

// Open creates or opens the database and applies the schema when user_version is 0.
func Open(ctx context.Context, path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	q := url.Values{
		"_pragma": {"journal_mode(WAL)", "synchronous(FULL)", "foreign_keys(ON)", "busy_timeout(5000)"},
		"_txlock": {"immediate"},
	}
	dsn := (&url.URL{Scheme: "file", OmitHost: true, Path: path, RawQuery: q.Encode()}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	var version int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		db.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	switch version {
	case 0:
		if _, err := db.ExecContext(ctx, schema); err != nil {
			db.Close()
			return nil, fmt.Errorf("apply schema: %w", err)
		}
	case schemaVersion:
	default:
		db.Close()
		return nil, fmt.Errorf("%s has schema version %d, this binary knows %d", path, version, schemaVersion)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Ping backs /healthz. It reads a row because PingContext alone can pass on a
// pooled connection after the file has gone.
func (s *Store) Ping(ctx context.Context) error {
	var n int
	return s.db.QueryRowContext(ctx, `SELECT count(*) FROM owner`).Scan(&n)
}

func changed(res sql.Result, err error) (bool, error) {
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func one(res sql.Result, err error) error {
	ok, err := changed(res, err)
	if err == nil && !ok {
		return ErrNotFound
	}
	return err
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func (s *Store) inTx(ctx context.Context, f func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := f(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) OwnerHash(ctx context.Context) (hash string, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT password_hash FROM owner WHERE id = 1`).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return hash, err == nil, err
}

// CreateOwner returns ErrExists after the first success, so setup can happen once.
func (s *Store) CreateOwner(ctx context.Context, hash string) error {
	ok, err := changed(s.db.ExecContext(ctx,
		`INSERT INTO owner (id, password_hash, created_at) VALUES (1, ?, ?) ON CONFLICT DO NOTHING`,
		hash, time.Now().Unix()))
	if err == nil && !ok {
		return ErrExists
	}
	return err
}

// ChangePassword replaces the hash and revokes every session but keep, together.
func (s *Store) ChangePassword(ctx context.Context, hash string, keep SessionID) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if err := one(tx.ExecContext(ctx, `UPDATE owner SET password_hash = ? WHERE id = 1`, hash)); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE id <> ?`, keep)
		return err
	})
}

// ResetOwner removes the owner, every session and the limiter, so the setup-code
// flow runs at the next boot. Shares and files stay.
func (s *Store) ResetOwner(ctx context.Context) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		for _, q := range []string{`DELETE FROM owner`, `DELETE FROM sessions`, `DELETE FROM limiter`} {
			if _, err := tx.ExecContext(ctx, q); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) CreateSession(ctx context.Context, sess Session, tokenHash []byte) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (id, token_hash, created_at, last_seen_at, expires_at, user_agent, client_ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sess.ID, tokenHash, sess.CreatedAt.Unix(), sess.LastSeenAt.Unix(), sess.ExpiresAt.Unix(), sess.UserAgent, sess.ClientIP)
	return err
}

func scanSession(row interface{ Scan(...any) error }) (Session, error) {
	var sess Session
	var created, seen, expires int64
	err := row.Scan(&sess.ID, &created, &seen, &expires, &sess.UserAgent, &sess.ClientIP)
	sess.CreatedAt, sess.LastSeenAt, sess.ExpiresAt = time.Unix(created, 0), time.Unix(seen, 0), time.Unix(expires, 0)
	return sess, err
}

const sessionColumns = `id, created_at, last_seen_at, expires_at, user_agent, client_ip`

// TouchSession finds a live session and advances last_seen_at at most once a minute.
func (s *Store) TouchSession(ctx context.Context, tokenHash []byte, now time.Time) (Session, error) {
	sess, err := scanSession(s.db.QueryRowContext(ctx,
		`SELECT `+sessionColumns+` FROM sessions WHERE token_hash = ? AND expires_at > ?`, tokenHash, now.Unix()))
	if err != nil {
		return Session{}, notFound(err)
	}
	if now.Sub(sess.LastSeenAt) >= time.Minute {
		if _, err := s.db.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ? WHERE id = ?`, now.Unix(), sess.ID); err != nil {
			return Session{}, err
		}
		sess.LastSeenAt = now
	}
	return sess, nil
}

func (s *Store) ListSessions(ctx context.Context) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+sessionColumns+` FROM sessions ORDER BY last_seen_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSession(ctx context.Context, id SessionID) error {
	return one(s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id))
}

func (s *Store) DeleteSessionByHash(ctx context.Context, tokenHash []byte) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

func nullable[T any](p *T, f func(T) any) any {
	if p == nil {
		return nil
	}
	return f(*p)
}

func (s *Store) CreateShare(ctx context.Context, sh Share) error {
	var password any
	if sh.PasswordHash != "" {
		password = sh.PasswordHash
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO shares (`+shareColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		sh.ID, sh.Token, sh.Kind, sh.Target.String(), password,
		nullable(sh.ExpiresAt, func(t time.Time) any { return t.Unix() }),
		nullable(sh.MaxUses, func(n int) any { return n }),
		sh.CreatedAt.Unix())
	return err
}

func scanShare(row interface{ Scan(...any) error }) (Share, error) {
	var sh Share
	var target string
	var password sql.NullString
	var expires, maxUses sql.NullInt64
	var created int64
	if err := row.Scan(&sh.ID, &sh.Token, &sh.Kind, &target, &password, &expires, &maxUses, &sh.Uses, &created); err != nil {
		return Share{}, err
	}
	loc, err := disk.ParseLocation(target)
	if err != nil {
		return Share{}, err
	}
	sh.Target, sh.PasswordHash, sh.CreatedAt = loc, password.String, time.Unix(created, 0)
	if expires.Valid {
		t := time.Unix(expires.Int64, 0)
		sh.ExpiresAt = &t
	}
	if maxUses.Valid {
		n := int(maxUses.Int64)
		sh.MaxUses = &n
	}
	return sh, nil
}

func (s *Store) ShareByToken(ctx context.Context, t Token) (Share, error) {
	sh, err := scanShare(s.db.QueryRowContext(ctx, `SELECT `+shareColumns+` FROM shares WHERE token = ?`, t))
	return sh, notFound(err)
}

func (s *Store) ShareByID(ctx context.Context, id ShareID) (Share, error) {
	sh, err := scanShare(s.db.QueryRowContext(ctx, `SELECT `+shareColumns+` FROM shares WHERE id = ?`, id))
	return sh, notFound(err)
}

func (s *Store) ListShares(ctx context.Context) ([]Share, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+shareColumns+` FROM shares ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Share
	for rows.Next() {
		sh, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

func (s *Store) CountShares(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM shares`).Scan(&n)
	return n, err
}

func (s *Store) DeleteShare(ctx context.Context, id ShareID) error {
	return one(s.db.ExecContext(ctx, `DELETE FROM shares WHERE id = ?`, id))
}

// DeleteSharesAt drops shares at or under a location, for a purged trash item.
func (s *Store) DeleteSharesAt(ctx context.Context, at disk.Location) error {
	_, err := s.db.ExecContext(ctx, deleteTargets, at.String())
	return err
}

func (s *Store) CreateGrant(ctx context.Context, g Grant, tokenHash []byte) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO grants (id, token_hash, share_id, expires_at) VALUES (?, ?, ?, ?)`,
		g.ID, tokenHash, g.ShareID, g.ExpiresAt.Unix())
	return err
}

func (s *Store) GrantByHash(ctx context.Context, tokenHash []byte) (Grant, error) {
	var g Grant
	var expires int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, share_id, expires_at, EXISTS (SELECT 1 FROM grant_items i WHERE i.grant_id = grants.id)
		FROM grants WHERE token_hash = ?`, tokenHash).Scan(&g.ID, &g.ShareID, &expires, &g.Consumed)
	if err != nil {
		return Grant{}, notFound(err)
	}
	g.ExpiresAt = time.Unix(expires, 0)
	return g, nil
}

// TakeItem records that a grant fetched an item, and takes one use the first
// time. Repeating an item is free. It returns ErrExhausted when no use remains.
func (s *Store) TakeItem(ctx context.Context, g GrantID, sh ShareID, item string) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		first, err := changed(tx.ExecContext(ctx, recordItem, g, item))
		if err != nil || !first {
			return err
		}
		took, err := changed(tx.ExecContext(ctx, takeUse, sh))
		if err == nil && !took {
			return ErrExhausted
		}
		return err
	})
}

// BeginMove records intent before the rename.
func (s *Store) BeginMove(ctx context.Context, from, to disk.Location, inode uint64) (MoveID, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO pending_moves (from_loc, to_loc, src_inode, started_at) VALUES (?, ?, ?, ?)`,
		from.String(), to.String(), int64(inode), time.Now().Unix())
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	return MoveID(id), err
}

// CommitMove runs rewriteTargets and deletes the journal row in one transaction.
func (s *Store) CommitMove(ctx context.Context, m PendingMove) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, rewriteTargets, m.From.String(), m.To.String()); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM pending_moves WHERE id = ?`, m.ID)
		return err
	})
}

// AbortMove deletes the journal row after the rename did not happen.
func (s *Store) AbortMove(ctx context.Context, id MoveID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pending_moves WHERE id = ?`, id)
	return err
}

// ForgetMove handles a row whose paths both changed outside the app. The shares
// that pointed at the source can no longer be trusted, so they go with the row.
func (s *Store) ForgetMove(ctx context.Context, m PendingMove) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, deleteTargets, m.From.String()); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM pending_moves WHERE id = ?`, m.ID)
		return err
	})
}

func (s *Store) PendingMoves(ctx context.Context) ([]PendingMove, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, from_loc, to_loc, src_inode FROM pending_moves ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingMove
	for rows.Next() {
		var m PendingMove
		var from, to string
		var inode int64
		if err := rows.Scan(&m.ID, &from, &to, &inode); err != nil {
			return nil, err
		}
		if m.From, err = disk.ParseLocation(from); err != nil {
			return nil, err
		}
		if m.To, err = disk.ParseLocation(to); err != nil {
			return nil, err
		}
		m.Inode = uint64(inode)
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) Limiter(ctx context.Context, key string) (LimiterState, error) {
	var st LimiterState
	var until int64
	err := s.db.QueryRowContext(ctx, `SELECT failures, locked_until FROM limiter WHERE key = ?`, key).Scan(&st.Failures, &until)
	if errors.Is(err, sql.ErrNoRows) {
		return LimiterState{}, nil
	}
	st.LockedUntil = time.Unix(until, 0)
	return st, err
}

func (s *Store) SetLimiter(ctx context.Context, key string, st LimiterState) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO limiter (key, failures, locked_until) VALUES (?1, ?2, ?3)
		ON CONFLICT (key) DO UPDATE SET failures = ?2, locked_until = ?3`,
		key, st.Failures, st.LockedUntil.Unix())
	return err
}

func (s *Store) ClearLimiter(ctx context.Context, key string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM limiter WHERE key = ?`, key)
	return err
}

// Prune deletes expired sessions and grants.
func (s *Store) Prune(ctx context.Context, now time.Time) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		for _, q := range []string{`DELETE FROM sessions WHERE expires_at <= ?`, `DELETE FROM grants WHERE expires_at <= ?`} {
			if _, err := tx.ExecContext(ctx, q, now.Unix()); err != nil {
				return err
			}
		}
		return nil
	})
}
