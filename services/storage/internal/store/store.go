// Package store holds all metadata in PostgreSQL and is the one place that
// decides who may do what with a file (see authz.go).
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Errors returned by the store. Handlers map them to HTTP status codes.
var (
	ErrNotFound   = errors.New("not found")
	ErrForbidden  = errors.New("forbidden")
	ErrConflict   = errors.New("conflict")
	ErrInvalid    = errors.New("invalid request")
	ErrQuota      = errors.New("quota exceeded")
	ErrVolumeFull = errors.New("storage volume nearly full")
	ErrTooLarge   = errors.New("file too large")
	ErrGone       = errors.New("gone")
	ErrUploadBusy = errors.New("upload busy")
	ErrBadOffset  = errors.New("upload offset mismatch")
)

// Store wraps the connection pool.
type Store struct {
	Pool         *pgxpool.Pool
	DefaultQuota int64
	// SpaceCheck refuses a write of n more bytes when the volume would get
	// too full. It is optional (nil in unit tests that do not care).
	SpaceCheck func(n int64) error
	log        *slog.Logger
}

// Open connects to PostgreSQL, retrying until it answers or ctx ends, then
// applies migrations under an advisory lock.
func Open(ctx context.Context, url string, defaultQuota int64, log *slog.Logger) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.ConnConfig.Tracer = otelpgx.NewTracer()
	if cfg.MaxConns < 10 {
		cfg.MaxConns = 10
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	delay := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = pool.Ping(pctx)
		cancel()
		if err == nil {
			break
		}
		log.Warn("database not reachable yet", "attempt", attempt, "err", err)
		select {
		case <-ctx.Done():
			pool.Close()
			return nil, fmt.Errorf("database never became reachable: %w", err)
		case <-time.After(delay):
		}
		delay = min(delay*2, 10*time.Second)
	}
	s := &Store{Pool: pool, DefaultQuota: defaultQuota, log: log}
	if err := s.migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() { s.Pool.Close() }

// Ping checks that the database answers.
func (s *Store) Ping(ctx context.Context) error { return s.Pool.Ping(ctx) }

const migrationLockKey = 0x5354_4f52_4147_45 // "STORAGE"

func (s *Store) migrate(ctx context.Context) error {
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLockKey); err != nil {
		return fmt.Errorf("take migration lock: %w", err)
	}
	defer conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", migrationLockKey) //nolint:errcheck
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, f := range files {
		base := strings.TrimPrefix(f, "migrations/")
		version, err := strconv.Atoi(strings.SplitN(base, "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: bad name", f)
		}
		var done bool
		if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)", version).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, err := migrations.ReadFile(f)
		if err != nil {
			return err
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return fmt.Errorf("migration %s: %w", base, err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", version); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		s.log.Info("applied migration", "version", version, "file", base)
	}
	return nil
}

// Querier is satisfied by the pool and by transactions.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Tx runs fn in a transaction.
func (s *Store) Tx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, s.Pool, fn)
}

// Setting returns a stored value, creating it with gen() on first use.
func (s *Store) Setting(ctx context.Context, key string, gen func() []byte) ([]byte, error) {
	if _, err := s.Pool.Exec(ctx, "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", key, gen()); err != nil {
		return nil, err
	}
	var v []byte
	err := s.Pool.QueryRow(ctx, "SELECT value FROM settings WHERE key = $1", key).Scan(&v)
	return v, err
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

func isFKViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23503"
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
