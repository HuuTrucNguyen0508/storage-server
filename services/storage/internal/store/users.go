package store

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// User is a person known to the app.
type User struct {
	ID          int64      `json:"id"`
	Username    string     `json:"username"`
	Email       string     `json:"email"`
	DisplayName string     `json:"displayName"`
	IsAdmin     bool       `json:"isAdmin"`
	Placeholder bool       `json:"placeholder"`
	QuotaBytes  int64      `json:"quotaBytes"`
	RootID      string     `json:"rootId"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastSeenAt  *time.Time `json:"lastSeenAt"`
}

var usernameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._@-]{0,63}$`)

// NormalizeUsername lowercases a username and checks its shape.
func NormalizeUsername(u string) (string, bool) {
	u = strings.ToLower(strings.TrimSpace(u))
	return u, usernameRE.MatchString(u)
}

const userCols = `id, username, email, display_name, is_admin, placeholder, quota_bytes, root_id::text, created_at, last_seen_at`

func scanUser(row pgx.Row) (*User, error) {
	var u User
	var root *string
	err := row.Scan(&u.ID, &u.Username, &u.Email, &u.DisplayName, &u.IsAdmin, &u.Placeholder, &u.QuotaBytes, &root, &u.CreatedAt, &u.LastSeenAt)
	if err != nil {
		return nil, notFound(err)
	}
	if root != nil {
		u.RootID = *root
	}
	return &u, nil
}

// Identity is what the SSO proxy tells us about the signed-in person.
type Identity struct {
	Username string
	Email    string
	Name     string
	Admin    bool
}

// UpsertUser creates or refreshes the row for a signed-in user and makes
// sure the user has a root folder.
func (s *Store) UpsertUser(ctx context.Context, id Identity) (*User, error) {
	var u *User
	err := s.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		u, err = scanUser(tx.QueryRow(ctx, `
			INSERT INTO users (username, email, display_name, is_admin, quota_bytes, last_seen_at)
			VALUES ($1, $2, $3, $4, $5, now())
			ON CONFLICT (username) DO UPDATE SET
				email = EXCLUDED.email, display_name = EXCLUDED.display_name,
				is_admin = EXCLUDED.is_admin, placeholder = false, last_seen_at = now()
			RETURNING `+userCols, id.Username, id.Email, id.Name, id.Admin, s.DefaultQuota))
		if err != nil {
			return err
		}
		return ensureRoot(ctx, tx, u)
	})
	return u, err
}

// EnsurePlaceholder returns the user with that username, creating a
// placeholder row for someone who has never signed in. The no-op update must
// target a non-key column so reciprocal shares can check their creator FKs
// without conflicting with each other's grantee locks.
func (s *Store) EnsurePlaceholder(ctx context.Context, q pgx.Tx, username string) (*User, error) {
	u, err := scanUser(q.QueryRow(ctx, `
		INSERT INTO users (username, placeholder, quota_bytes) VALUES ($1, true, $2)
		ON CONFLICT (username) DO UPDATE SET placeholder = users.placeholder
		RETURNING `+userCols, username, s.DefaultQuota))
	if err != nil {
		return nil, err
	}
	return u, ensureRoot(ctx, q, u)
}

func ensureRoot(ctx context.Context, tx pgx.Tx, u *User) error {
	if u.RootID != "" {
		return nil
	}
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO nodes (owner_id, is_dir, name) VALUES ($1, true, '')
			ON CONFLICT DO NOTHING RETURNING id
		)
		SELECT id::text FROM ins
		UNION ALL SELECT id::text FROM nodes WHERE owner_id = $1 AND parent_id IS NULL
		LIMIT 1`, u.ID).Scan(&u.RootID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE users SET root_id = $2 WHERE id = $1", u.ID, u.RootID)
	return err
}

// UserByName looks a user up by username.
func (s *Store) UserByName(ctx context.Context, username string) (*User, error) {
	return scanUser(s.Pool.QueryRow(ctx, "SELECT "+userCols+" FROM users WHERE username = $1", username))
}

// UserByID looks a user up by id.
func (s *Store) UserByID(ctx context.Context, id int64) (*User, error) {
	return scanUser(s.Pool.QueryRow(ctx, "SELECT "+userCols+" FROM users WHERE id = $1", id))
}

// SearchUsers returns usernames that start with prefix, for the share dialog.
func (s *Store) SearchUsers(ctx context.Context, prefix string, exclude int64) ([]string, error) {
	prefix = strings.ToLower(prefix)
	rows, err := s.Pool.Query(ctx, `SELECT username FROM users WHERE username LIKE $1 || '%' AND id <> $2 ORDER BY username LIMIT 10`, likeEscape(prefix), exclude)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// Usage is the quota picture for one user.
type Usage struct {
	UsedBytes     int64 `json:"usedBytes"`
	ReservedBytes int64 `json:"reservedBytes"`
	QuotaBytes    int64 `json:"quotaBytes"`
	Files         int64 `json:"files"`
}

// Usage sums the bytes a user owns, including trash, plus bytes reserved by
// unfinished uploads into the user's space.
func (s *Store) Usage(ctx context.Context, q Querier, userID int64) (Usage, error) {
	var u Usage
	err := q.QueryRow(ctx, `
		SELECT
			(SELECT coalesce(sum(size), 0) FROM nodes WHERE owner_id = $1 AND NOT is_dir),
			(SELECT count(*) FROM nodes WHERE owner_id = $1 AND NOT is_dir),
			(SELECT coalesce(sum(size), 0) FROM upload_sessions WHERE owner_id = $1),
			(SELECT quota_bytes FROM users WHERE id = $1)`, userID).Scan(&u.UsedBytes, &u.Files, &u.ReservedBytes, &u.QuotaBytes)
	return u, err
}

// AdminUser is one row of the admin user list.
type AdminUser struct {
	User
	UsedBytes     int64 `json:"usedBytes"`
	ReservedBytes int64 `json:"reservedBytes"`
	Files         int64 `json:"files"`
	Shares        int64 `json:"shares"`
	Links         int64 `json:"links"`
}

// ListUsersForAdmin returns every user with usage numbers.
func (s *Store) ListUsersForAdmin(ctx context.Context) ([]AdminUser, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT u.id, u.username, u.email, u.display_name, u.is_admin, u.placeholder, u.quota_bytes, u.root_id::text, u.created_at, u.last_seen_at,
			coalesce(n.used, 0), coalesce(n.files, 0), coalesce(up.reserved, 0),
			(SELECT count(*) FROM shares sh JOIN nodes sn ON sn.id = sh.node_id WHERE sn.owner_id = u.id),
			(SELECT count(*) FROM links l WHERE l.created_by = u.id AND l.revoked_at IS NULL)
		FROM users u
		LEFT JOIN (SELECT owner_id, sum(size) used, count(*) files FROM nodes WHERE NOT is_dir GROUP BY owner_id) n ON n.owner_id = u.id
		LEFT JOIN (SELECT owner_id, sum(size) reserved FROM upload_sessions GROUP BY owner_id) up ON up.owner_id = u.id
		ORDER BY u.username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminUser
	for rows.Next() {
		var a AdminUser
		var root *string
		if err := rows.Scan(&a.ID, &a.Username, &a.Email, &a.DisplayName, &a.IsAdmin, &a.Placeholder, &a.QuotaBytes, &root, &a.CreatedAt, &a.LastSeenAt,
			&a.UsedBytes, &a.Files, &a.ReservedBytes, &a.Shares, &a.Links); err != nil {
			return nil, err
		}
		if root != nil {
			a.RootID = *root
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// SetQuota changes a user's quota.
func (s *Store) SetQuota(ctx context.Context, userID, quota int64) error {
	if quota < 0 {
		return ErrInvalid
	}
	tag, err := s.Pool.Exec(ctx, "UPDATE users SET quota_bytes = $2 WHERE id = $1", userID, quota)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
