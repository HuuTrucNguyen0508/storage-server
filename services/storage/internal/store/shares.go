package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Share grants another user access to a node.
type Share struct {
	ID         string    `json:"id"`
	NodeID     string    `json:"nodeId"`
	Username   string    `json:"username"`
	Permission string    `json:"permission"`
	CreatedAt  time.Time `json:"createdAt"`
}

// ListShares returns a node's shares; only the owner may list them.
func (s *Store) ListShares(ctx context.Context, u *User, nodeID string) ([]Share, error) {
	if _, _, err := s.Authorize(ctx, s.Pool, Subject{User: u}, nodeID, NeedOwner); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT sh.id::text, sh.node_id::text, g.username, sh.permission, sh.created_at
		FROM shares sh JOIN users g ON g.id = sh.grantee_id WHERE sh.node_id = $1 ORDER BY g.username`, nodeID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Share])
}

// ShareWith grants (or updates) a user's permission on a node. A username
// that has never signed in gets a placeholder account.
func (s *Store) ShareWith(ctx context.Context, u *User, nodeID, username, permission string) (*Share, error) {
	username, ok := NormalizeUsername(username)
	if !ok {
		return nil, fmt.Errorf("%w: not a valid username", ErrInvalid)
	}
	if permission != "read" && permission != "edit" {
		return nil, fmt.Errorf("%w: permission must be read or edit", ErrInvalid)
	}
	var sh Share
	err := s.Tx(ctx, func(tx pgx.Tx) error {
		node, _, err := s.Authorize(ctx, tx, Subject{User: u}, nodeID, NeedOwner)
		if err != nil {
			return err
		}
		if username == u.Username {
			return fmt.Errorf("%w: you already own this", ErrInvalid)
		}
		if node.ParentID == nil {
			return fmt.Errorf("%w: share a folder inside your files, not the whole space", ErrInvalid)
		}
		grantee, err := s.EnsurePlaceholder(ctx, tx, username)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO shares (node_id, grantee_id, permission, created_by) VALUES ($1, $2, $3, $4)
			ON CONFLICT (node_id, grantee_id) DO UPDATE SET permission = EXCLUDED.permission
			RETURNING id::text, node_id::text, $5::text, permission, created_at`, nodeID, grantee.ID, permission, u.ID, grantee.Username).
			Scan(&sh.ID, &sh.NodeID, &sh.Username, &sh.Permission, &sh.CreatedAt); err != nil {
			return err
		}
		return logActivity(ctx, tx, nodeID, ActorOf(Subject{User: u}), "shared", fmt.Sprintf("with %s (%s)", grantee.Username, permission))
	})
	if err != nil {
		return nil, err
	}
	return &sh, nil
}

// RemoveShare deletes a share. The node's owner may remove any share on it;
// the grantee may remove their own (leave the share).
func (s *Store) RemoveShare(ctx context.Context, u *User, shareID string) error {
	if !ValidID(shareID) {
		return ErrNotFound
	}
	return s.Tx(ctx, func(tx pgx.Tx) error {
		var nodeID, grantee string
		var ownerID, granteeID int64
		err := tx.QueryRow(ctx, `SELECT sh.node_id::text, n.owner_id, sh.grantee_id, g.username FROM shares sh
			JOIN nodes n ON n.id = sh.node_id JOIN users g ON g.id = sh.grantee_id WHERE sh.id = $1`, shareID).Scan(&nodeID, &ownerID, &granteeID, &grantee)
		if err != nil {
			return notFound(err)
		}
		if ownerID != u.ID && granteeID != u.ID {
			return ErrNotFound
		}
		if _, err := tx.Exec(ctx, "DELETE FROM shares WHERE id = $1", shareID); err != nil {
			return err
		}
		return logActivity(ctx, tx, nodeID, ActorOf(Subject{User: u}), "unshared", "with "+grantee)
	})
}

// LinkKind is the kind of public link.
type LinkKind string

const (
	LinkView LinkKind = "view"
	LinkDrop LinkKind = "drop"
)

// Link is a public link to a node.
type Link struct {
	ID            string     `json:"id"`
	NodeID        string     `json:"nodeId"`
	NodeName      string     `json:"nodeName"`
	NodeIsDir     bool       `json:"nodeIsDir"`
	OwnerID       int64      `json:"-"`
	Owner         string     `json:"owner"`
	Kind          LinkKind   `json:"kind"`
	HasPassword   bool       `json:"hasPassword"`
	PasswordHash  string     `json:"-"`
	ExpiresAt     *time.Time `json:"expiresAt"`
	MaxDownloads  *int       `json:"maxDownloads"`
	DownloadCount int        `json:"downloadCount"`
	RevokedAt     *time.Time `json:"revokedAt"`
	CreatedAt     time.Time  `json:"createdAt"`
	LastUsedAt    *time.Time `json:"lastUsedAt"`
	tokenHash     []byte
}

const linkSelect = `SELECT l.id::text, l.node_id::text, n.name, n.is_dir, n.owner_id, o.username, l.kind, coalesce(l.password_hash, ''),
	l.expires_at, l.max_downloads, l.download_count, l.revoked_at, l.created_at, l.last_used_at, l.token_hash
	FROM links l JOIN nodes n ON n.id = l.node_id JOIN users o ON o.id = n.owner_id `

func scanLink(row pgx.Row) (*Link, error) {
	var l Link
	err := row.Scan(&l.ID, &l.NodeID, &l.NodeName, &l.NodeIsDir, &l.OwnerID, &l.Owner, &l.Kind, &l.PasswordHash,
		&l.ExpiresAt, &l.MaxDownloads, &l.DownloadCount, &l.RevokedAt, &l.CreatedAt, &l.LastUsedAt, &l.tokenHash)
	if err != nil {
		return nil, notFound(err)
	}
	l.HasPassword = l.PasswordHash != ""
	return &l, nil
}

func collectLinks(rows pgx.Rows, err error) ([]*Link, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Link{}
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// NewLinkInput describes a link to create.
type NewLinkInput struct {
	Kind         LinkKind
	PasswordHash string // argon2id, empty for none
	ExpiresAt    *time.Time
	MaxDownloads *int
}

// HashToken is how tokens are stored: SHA-256 of the token string.
func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// CreateLink makes a public link and returns it with its token. The token is
// 256 random bits; only its hash is stored, so it is shown exactly once.
func (s *Store) CreateLink(ctx context.Context, u *User, nodeID string, in NewLinkInput) (*Link, string, error) {
	if in.Kind != LinkView && in.Kind != LinkDrop {
		return nil, "", fmt.Errorf("%w: kind must be view or drop", ErrInvalid)
	}
	if in.MaxDownloads != nil && *in.MaxDownloads <= 0 {
		return nil, "", fmt.Errorf("%w: download limit must be positive", ErrInvalid)
	}
	if in.ExpiresAt != nil && !in.ExpiresAt.After(time.Now()) {
		return nil, "", fmt.Errorf("%w: expiry must be in the future", ErrInvalid)
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, "", err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	var id string
	err := s.Tx(ctx, func(tx pgx.Tx) error {
		node, _, err := s.Authorize(ctx, tx, Subject{User: u}, nodeID, NeedOwner)
		if err != nil {
			return err
		}
		if node.ParentID == nil {
			return fmt.Errorf("%w: link a folder inside your files, not the whole space", ErrInvalid)
		}
		if in.Kind == LinkDrop && !node.IsDir {
			return fmt.Errorf("%w: an upload-only link needs a folder", ErrInvalid)
		}
		var pw *string
		if in.PasswordHash != "" {
			pw = &in.PasswordHash
		}
		if err := tx.QueryRow(ctx, `INSERT INTO links (node_id, created_by, kind, token_hash, password_hash, expires_at, max_downloads)
			VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`, nodeID, u.ID, in.Kind, HashToken(token), pw, in.ExpiresAt, in.MaxDownloads).Scan(&id); err != nil {
			return err
		}
		return logActivity(ctx, tx, nodeID, ActorOf(Subject{User: u}), "link_created", string(in.Kind))
	})
	if err != nil {
		return nil, "", err
	}
	l, err := scanLink(s.Pool.QueryRow(ctx, linkSelect+"WHERE l.id = $1", id))
	return l, token, err
}

// LinkByToken finds a link by its token. It returns the link whatever its
// state; callers check State. The hash comparison runs in constant time.
func (s *Store) LinkByToken(ctx context.Context, token string) (*Link, error) {
	if len(token) < 22 || len(token) > 128 {
		return nil, ErrNotFound
	}
	want := HashToken(token)
	l, err := scanLink(s.Pool.QueryRow(ctx, linkSelect+"WHERE l.token_hash = $1", want))
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare(l.tokenHash, want) != 1 {
		return nil, ErrNotFound
	}
	return l, nil
}

// LinksForNode lists a node's links for its owner.
func (s *Store) LinksForNode(ctx context.Context, u *User, nodeID string) ([]*Link, error) {
	if _, _, err := s.Authorize(ctx, s.Pool, Subject{User: u}, nodeID, NeedOwner); err != nil {
		return nil, err
	}
	return collectLinks(s.Pool.Query(ctx, linkSelect+"WHERE l.node_id = $1 ORDER BY l.created_at DESC", nodeID))
}

// LinksByOwner lists every link on the user's files.
func (s *Store) LinksByOwner(ctx context.Context, u *User) ([]*Link, error) {
	return collectLinks(s.Pool.Query(ctx, linkSelect+"WHERE n.owner_id = $1 ORDER BY l.created_at DESC", u.ID))
}

// AllLinks lists every link (admin).
func (s *Store) AllLinks(ctx context.Context) ([]*Link, error) {
	return collectLinks(s.Pool.Query(ctx, linkSelect+"ORDER BY l.created_at DESC LIMIT 1000"))
}

// RevokeLink revokes a link; asAdmin lets an admin revoke anyone's link.
func (s *Store) RevokeLink(ctx context.Context, u *User, linkID string, asAdmin bool) error {
	if !ValidID(linkID) {
		return ErrNotFound
	}
	return s.Tx(ctx, func(tx pgx.Tx) error {
		l, err := scanLink(tx.QueryRow(ctx, linkSelect+"WHERE l.id = $1", linkID))
		if err != nil {
			return err
		}
		if l.OwnerID != u.ID && !(asAdmin && u.IsAdmin) {
			return ErrNotFound
		}
		if l.RevokedAt != nil {
			return nil
		}
		if _, err := tx.Exec(ctx, "UPDATE links SET revoked_at = now() WHERE id = $1", linkID); err != nil {
			return err
		}
		detail := ""
		if l.OwnerID != u.ID {
			detail = "by admin " + u.Username
		}
		return logActivity(ctx, tx, l.NodeID, ActorOf(Subject{User: u}), "link_revoked", detail)
	})
}

// CountLinkDownload records one download through a link and refuses it when
// the link's limit is already used up.
func (s *Store) CountLinkDownload(ctx context.Context, l *Link, nodeID string) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE links SET download_count = download_count + 1, last_used_at = now()
		WHERE id = $1 AND revoked_at IS NULL AND (max_downloads IS NULL OR download_count < max_downloads)
		AND (expires_at IS NULL OR expires_at > now())`, l.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrGone
	}
	l.DownloadCount++
	return s.LogActivity(ctx, nodeID, Actor{Label: "link guest"}, "downloaded_by_link", "")
}

// SharePerson is one grantee in a sharing summary.
type SharePerson struct {
	Username   string `json:"username"`
	Permission string `json:"permission"`
}

// Sharing summarizes who can reach a node, for the "Shared" column.
type Sharing struct {
	People        []SharePerson `json:"people"`
	Links         int           `json:"links"`
	LinkExpiresAt *time.Time    `json:"linkExpiresAt"`
}

// SharingFor returns the sharing summary of the given nodes owned by u.
// Nodes that are not shared are absent from the map.
func (s *Store) SharingFor(ctx context.Context, u *User, ids []string) (map[string]*Sharing, error) {
	out := map[string]*Sharing{}
	if len(ids) == 0 {
		return out, nil
	}
	get := func(id string) *Sharing {
		if out[id] == nil {
			out[id] = &Sharing{People: []SharePerson{}}
		}
		return out[id]
	}
	rows, err := s.Pool.Query(ctx, `SELECT sh.node_id::text, g.username, sh.permission FROM shares sh
		JOIN nodes n ON n.id = sh.node_id JOIN users g ON g.id = sh.grantee_id
		WHERE sh.node_id = ANY($1::uuid[]) AND n.owner_id = $2 ORDER BY sh.created_at`, ids, u.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var p SharePerson
		if err := rows.Scan(&id, &p.Username, &p.Permission); err != nil {
			rows.Close()
			return nil, err
		}
		get(id).People = append(get(id).People, p)
	}
	rows.Close()
	rows, err = s.Pool.Query(ctx, `SELECT l.node_id::text, count(*), min(l.expires_at) FROM links l JOIN nodes n ON n.id = l.node_id
		WHERE l.node_id = ANY($1::uuid[]) AND n.owner_id = $2 AND l.revoked_at IS NULL
		AND (l.expires_at IS NULL OR l.expires_at > now()) AND (l.max_downloads IS NULL OR l.download_count < l.max_downloads)
		GROUP BY l.node_id`, ids, u.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		var exp *time.Time
		if err := rows.Scan(&id, &n, &exp); err != nil {
			return nil, err
		}
		sh := get(id)
		sh.Links, sh.LinkExpiresAt = n, exp
	}
	return out, rows.Err()
}
