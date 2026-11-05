package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/names"
	"github.com/jackc/pgx/v5"
)

// Node is a file or folder.
type Node struct {
	ID         string
	OwnerID    int64
	Owner      string
	ParentID   *string
	IsDir      bool
	Name       string
	Size       int64
	BlobID     string
	CreatedAt  time.Time
	ModifiedAt time.Time
	TrashedAt  *time.Time
	Starred    bool
	// Permission is set on "shared with me" rows.
	Permission string
}

// nodeSelect selects a node with its owner's username and whether user $X
// starred it; callers append the WHERE clause and pass the viewer id.
const nodeCols = `n.id::text, n.owner_id, o.username, n.parent_id::text, n.is_dir, n.name, n.size, coalesce(n.blob_id, ''), n.created_at, n.modified_at, n.trashed_at`

func nodeSelect(viewerArg string) string {
	return `SELECT ` + nodeCols + `, EXISTS (SELECT 1 FROM stars st WHERE st.node_id = n.id AND st.user_id = ` + viewerArg + `)
		FROM nodes n JOIN users o ON o.id = n.owner_id `
}

func scanNode(row pgx.Row, extra ...any) (*Node, error) {
	var n Node
	dst := []any{&n.ID, &n.OwnerID, &n.Owner, &n.ParentID, &n.IsDir, &n.Name, &n.Size, &n.BlobID, &n.CreatedAt, &n.ModifiedAt, &n.TrashedAt, &n.Starred}
	if err := row.Scan(append(dst, extra...)...); err != nil {
		return nil, notFound(err)
	}
	return &n, nil
}

func collectNodes(rows pgx.Rows, err error) ([]*Node, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Node{}
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Store) getNode(ctx context.Context, q Querier, id string, viewer int64) (*Node, error) {
	return scanNode(q.QueryRow(ctx, nodeSelect("$2")+"WHERE n.id = $1", id, viewer))
}

func viewerID(subj Subject) int64 {
	if subj.User != nil {
		return subj.User.ID
	}
	return 0
}

// Children lists the live children of a folder the subject may read.
func (s *Store) Children(ctx context.Context, subj Subject, folderID string) (*Node, *Access, []*Node, error) {
	folder, acc, err := s.Authorize(ctx, s.Pool, subj, folderID, NeedRead)
	if err != nil {
		return nil, nil, nil, err
	}
	if !folder.IsDir {
		return nil, nil, nil, ErrInvalid
	}
	kids, err := collectNodes(s.Pool.Query(ctx, nodeSelect("$2")+`WHERE n.parent_id = $1 AND n.trashed_at IS NULL ORDER BY n.is_dir DESC, lower(n.name)`, folderID, viewerID(subj)))
	return folder, acc, kids, err
}

// Actor names who did something, for the activity log.
type Actor struct {
	ID    *int64
	Label string
}

// ActorOf builds the activity actor for a subject.
func ActorOf(subj Subject) Actor {
	if subj.User != nil {
		id := subj.User.ID
		return Actor{ID: &id, Label: subj.User.Username}
	}
	return Actor{Label: "link guest"}
}

func logActivity(ctx context.Context, q Querier, nodeID string, a Actor, action, detail string) error {
	_, err := q.Exec(ctx, `INSERT INTO activity (node_id, actor_id, actor, action, detail) VALUES ($1, $2, $3, $4, $5)`, nodeID, a.ID, a.Label, action, detail)
	return err
}

// freeName returns name, or "name (n).ext" with the smallest n that is not
// taken in the folder.
func freeName(ctx context.Context, q Querier, parentID, name string) (string, error) {
	base := name
	if dot := strings.LastIndexByte(name, '.'); dot > 0 {
		base = name[:dot]
	}
	rows, err := q.Query(ctx, `SELECT lower(name) FROM nodes WHERE parent_id = $1 AND trashed_at IS NULL AND lower(name) LIKE $2 || '%'`, parentID, likeEscape(strings.ToLower(base)))
	if err != nil {
		return "", err
	}
	taken, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	set := make(map[string]bool, len(taken))
	for _, t := range taken {
		set[t] = true
	}
	for i := 0; i < 100000; i++ {
		cand := name
		if i > 0 {
			cand = names.Numbered(name, i)
		}
		if !set[strings.ToLower(cand)] {
			return cand, nil
		}
	}
	return "", ErrConflict
}

// withFreeName runs insert with a free name inside a savepoint, retrying when
// a concurrent request takes the same name first.
func withFreeName(ctx context.Context, tx pgx.Tx, parentID, name string, insert func(tx pgx.Tx, name string) error) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		cand, err := freeName(ctx, tx, parentID, name)
		if err != nil {
			return "", err
		}
		err = pgx.BeginFunc(ctx, tx, func(sp pgx.Tx) error { return insert(sp, cand) })
		if err == nil {
			return cand, nil
		}
		if !isUniqueViolation(err) {
			return "", err
		}
	}
	return "", ErrConflict
}

// CreateFolder makes a folder. An existing folder of the same name is an
// ErrConflict.
func (s *Store) CreateFolder(ctx context.Context, subj Subject, parentID, rawName string) (*Node, error) {
	name, err := names.Normalize(rawName)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	var id string
	err = s.Tx(ctx, func(tx pgx.Tx) error {
		parent, _, err := s.Authorize(ctx, tx, subj, parentID, NeedEdit)
		if err != nil {
			return err
		}
		if !parent.IsDir {
			return ErrInvalid
		}
		err = tx.QueryRow(ctx, `INSERT INTO nodes (owner_id, parent_id, is_dir, name, created_by) VALUES ($1, $2, true, $3, $4) RETURNING id::text`,
			parent.OwnerID, parent.ID, name, ActorOf(subj).ID).Scan(&id)
		if isUniqueViolation(err) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		touch(ctx, tx, parent.ID)
		return logActivity(ctx, tx, id, ActorOf(subj), "created", "")
	})
	if err != nil {
		return nil, err
	}
	return s.getNode(ctx, s.Pool, id, viewerID(subj))
}

// ensureDirs walks (and creates where missing) a relative folder path below
// parent and returns the deepest folder's id. Parallel uploads of one dropped
// folder race to create the same folders; the loser reuses the winner's.
func ensureDirs(ctx context.Context, tx pgx.Tx, parent *Node, dirs []string, actor Actor) (string, error) {
	cur := parent.ID
	for _, d := range dirs {
		id, err := ensureDir(ctx, tx, parent.OwnerID, cur, d, actor)
		if err != nil {
			return "", err
		}
		cur = id
	}
	return cur, nil
}

func ensureDir(ctx context.Context, tx pgx.Tx, ownerID int64, parentID, name string, actor Actor) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		var id string
		var isDir bool
		err := tx.QueryRow(ctx, `SELECT id::text, is_dir FROM nodes WHERE parent_id = $1 AND lower(name) = lower($2) AND trashed_at IS NULL`, parentID, name).Scan(&id, &isDir)
		switch {
		case err == nil && isDir:
			return id, nil
		case err == nil:
			// A file holds the name: put the folder next to it with a number.
			_, err = withFreeName(ctx, tx, parentID, name, func(sp pgx.Tx, n string) error {
				return sp.QueryRow(ctx, `INSERT INTO nodes (owner_id, parent_id, is_dir, name, created_by) VALUES ($1, $2, true, $3, $4) RETURNING id::text`,
					ownerID, parentID, n, actor.ID).Scan(&id)
			})
		case errors.Is(err, pgx.ErrNoRows):
			err = pgx.BeginFunc(ctx, tx, func(sp pgx.Tx) error {
				return sp.QueryRow(ctx, `INSERT INTO nodes (owner_id, parent_id, is_dir, name, created_by) VALUES ($1, $2, true, $3, $4) RETURNING id::text`,
					ownerID, parentID, name, actor.ID).Scan(&id)
			})
			if isUniqueViolation(err) {
				continue // someone else just created it; look again
			}
		}
		if err != nil {
			return "", err
		}
		return id, logActivity(ctx, tx, id, actor, "created", "")
	}
	return "", ErrConflict
}

func touch(ctx context.Context, q Querier, id string) {
	q.Exec(ctx, "UPDATE nodes SET modified_at = now() WHERE id = $1", id) //nolint:errcheck
}

// Rename gives a node a new name in the same folder.
func (s *Store) Rename(ctx context.Context, subj Subject, id, rawName string) (*Node, error) {
	name, err := names.Normalize(rawName)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	err = s.Tx(ctx, func(tx pgx.Tx) error {
		node, acc, err := s.Authorize(ctx, tx, subj, id, NeedEdit)
		if err != nil {
			return err
		}
		if err := requireMutable(node, acc); err != nil {
			return err
		}
		if node.Name == name {
			return nil
		}
		_, err = tx.Exec(ctx, "UPDATE nodes SET name = $2, modified_at = now() WHERE id = $1", id, name)
		if isUniqueViolation(err) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		return logActivity(ctx, tx, id, ActorOf(subj), "renamed", node.Name+" → "+name)
	})
	if err != nil {
		return nil, err
	}
	return s.getNode(ctx, s.Pool, id, viewerID(subj))
}

// Move puts nodes into another folder of the same space. Name clashes get a
// numbered name. Moving between different owners' spaces is refused (copy).
func (s *Store) Move(ctx context.Context, subj Subject, ids []string, targetID string) ([]*Node, error) {
	var out []string
	err := s.Tx(ctx, func(tx pgx.Tx) error {
		target, _, err := s.Authorize(ctx, tx, subj, targetID, NeedEdit)
		if err != nil {
			return err
		}
		if !target.IsDir {
			return ErrInvalid
		}
		for _, id := range ids {
			node, acc, err := s.Authorize(ctx, tx, subj, id, NeedEdit)
			if err != nil {
				return err
			}
			if err := requireMutable(node, acc); err != nil {
				return err
			}
			if node.OwnerID != target.OwnerID {
				return fmt.Errorf("%w: moving between different people's files is not possible; copy instead", ErrInvalid)
			}
			if node.ParentID != nil && *node.ParentID == target.ID {
				out = append(out, id)
				continue
			}
			var cycle bool
			if err := tx.QueryRow(ctx, `
				WITH RECURSIVE anc AS (SELECT id, parent_id FROM nodes WHERE id = $1
					UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN anc ON n.id = anc.parent_id)
				SELECT EXISTS (SELECT 1 FROM anc WHERE id = $2)`, target.ID, node.ID).Scan(&cycle); err != nil {
				return err
			}
			if cycle {
				return fmt.Errorf("%w: cannot move a folder into itself", ErrInvalid)
			}
			newName, err := withFreeName(ctx, tx, target.ID, node.Name, func(sp pgx.Tx, name string) error {
				_, err := sp.Exec(ctx, "UPDATE nodes SET parent_id = $2, name = $3 WHERE id = $1", node.ID, target.ID, name)
				return err
			})
			if err != nil {
				return err
			}
			detail := "to " + displayName(target)
			if newName != node.Name {
				detail += " as " + newName
			}
			if err := logActivity(ctx, tx, node.ID, ActorOf(subj), "moved", detail); err != nil {
				return err
			}
			out = append(out, id)
		}
		touch(ctx, tx, target.ID)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.nodesByID(ctx, out, viewerID(subj))
}

func displayName(n *Node) string {
	if n.ParentID == nil {
		return "My files"
	}
	return n.Name
}

func (s *Store) nodesByID(ctx context.Context, ids []string, viewer int64) ([]*Node, error) {
	return collectNodes(s.Pool.Query(ctx, nodeSelect("$2")+"WHERE n.id = ANY($1::uuid[]) ORDER BY lower(n.name)", ids, viewer))
}

// QuotaCheck is called with the owner and the extra bytes about to be
// stored; it refuses with ErrQuota or ErrVolumeFull. Callers hold the owner's
// row lock while it runs.
func (s *Store) checkQuota(ctx context.Context, tx pgx.Tx, ownerID, extra int64) error {
	if _, err := tx.Exec(ctx, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", ownerID); err != nil {
		return err
	}
	u, err := s.Usage(ctx, tx, ownerID)
	if err != nil {
		return err
	}
	if u.UsedBytes+u.ReservedBytes+extra > u.QuotaBytes {
		return ErrQuota
	}
	if s.SpaceCheck != nil {
		return s.SpaceCheck(extra)
	}
	return nil
}

// Copy duplicates nodes (folders recursively) into a folder. Copies share
// blobs with their source, but count fully against the target owner's quota.
func (s *Store) Copy(ctx context.Context, subj Subject, ids []string, targetID string) ([]*Node, error) {
	var out []string
	err := s.Tx(ctx, func(tx pgx.Tx) error {
		target, _, err := s.Authorize(ctx, tx, subj, targetID, NeedEdit)
		if err != nil {
			return err
		}
		if !target.IsDir {
			return ErrInvalid
		}
		type row struct {
			id, parent string
			isDir      bool
			name, blob string
			size       int64
		}
		var plan [][]row
		var total int64
		for _, id := range ids {
			node, _, err := s.Authorize(ctx, tx, subj, id, NeedRead)
			if err != nil {
				return err
			}
			if node.ParentID == nil {
				return fmt.Errorf("%w: cannot copy a whole space", ErrInvalid)
			}
			if node.IsDir {
				var inside bool
				if err := tx.QueryRow(ctx, `
					WITH RECURSIVE anc AS (SELECT id, parent_id FROM nodes WHERE id = $1
						UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN anc ON n.id = anc.parent_id)
					SELECT EXISTS (SELECT 1 FROM anc WHERE id = $2)`, target.ID, node.ID).Scan(&inside); err != nil {
					return err
				}
				if inside {
					return fmt.Errorf("%w: cannot copy a folder into itself", ErrInvalid)
				}
			}
			rows, err := tx.Query(ctx, `
				WITH RECURSIVE t AS (
					SELECT id, parent_id, is_dir, name, coalesce(blob_id, '') AS blob, size, 0 AS depth FROM nodes WHERE id = $1
					UNION ALL
					SELECT n.id, n.parent_id, n.is_dir, n.name, coalesce(n.blob_id, ''), n.size, t.depth + 1
					FROM nodes n JOIN t ON n.parent_id = t.id WHERE n.trashed_at IS NULL
				) SELECT id::text, coalesce(parent_id::text, ''), is_dir, name, blob, size FROM t ORDER BY depth`, node.ID)
			if err != nil {
				return err
			}
			var tree []row
			for rows.Next() {
				var r row
				if err := rows.Scan(&r.id, &r.parent, &r.isDir, &r.name, &r.blob, &r.size); err != nil {
					rows.Close()
					return err
				}
				total += r.size
				tree = append(tree, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
			plan = append(plan, tree)
		}
		if err := s.checkQuota(ctx, tx, target.OwnerID, total); err != nil {
			return err
		}
		actor := ActorOf(subj)
		for _, tree := range plan {
			newID := map[string]string{}
			for i, r := range tree {
				parent := newID[r.parent]
				var blob *string
				if !r.isDir {
					blob = &r.blob
				}
				insert := func(q pgx.Tx, name string) error {
					return q.QueryRow(ctx, `INSERT INTO nodes (owner_id, parent_id, is_dir, name, size, blob_id, created_by)
						VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`, target.OwnerID, parent, r.isDir, name, r.size, blob, actor.ID).Scan(&parent)
				}
				var id string
				if i == 0 {
					parent = target.ID
					if _, err := withFreeName(ctx, tx, target.ID, r.name, func(sp pgx.Tx, name string) error {
						err := insert(sp, name)
						id = parent
						return err
					}); err != nil {
						return err
					}
					out = append(out, id)
					if err := logActivity(ctx, tx, id, actor, "copied", "from "+r.name); err != nil {
						return err
					}
				} else {
					if err := insert(tx, r.name); err != nil {
						return err
					}
					id = parent
				}
				newID[r.id] = id
			}
		}
		touch(ctx, tx, target.ID)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.nodesByID(ctx, out, viewerID(subj))
}

// Trash moves nodes and everything below them to their owner's trash.
func (s *Store) Trash(ctx context.Context, subj Subject, ids []string) error {
	return s.Tx(ctx, func(tx pgx.Tx) error {
		for _, id := range ids {
			node, acc, err := s.Authorize(ctx, tx, subj, id, NeedEdit)
			if err != nil {
				return err
			}
			if err := requireMutable(node, acc); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				WITH RECURSIVE sub AS (
					SELECT id FROM nodes WHERE id = $1
					UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.trashed_at IS NULL
				)
				UPDATE nodes SET trashed_at = now(), trash_root = $1 WHERE id IN (SELECT id FROM sub) AND trashed_at IS NULL`, id); err != nil {
				return err
			}
			if err := logActivity(ctx, tx, id, ActorOf(subj), "trashed", ""); err != nil {
				return err
			}
		}
		return nil
	})
}

// TrashItem is one entry in a user's trash.
type TrashItem struct {
	*Node
	TrashedAt  time.Time
	FromFolder string
}

// ListTrash returns what the user trashed (top-level items only).
func (s *Store) ListTrash(ctx context.Context, u *User) ([]TrashItem, error) {
	rows, err := s.Pool.Query(ctx, nodeSelect("$1")+`
		WHERE n.owner_id = $1 AND n.trash_root = n.id ORDER BY n.trashed_at DESC`, u.ID)
	if err != nil {
		return nil, err
	}
	nodes, err := collectNodes(rows, nil)
	if err != nil {
		return nil, err
	}
	out := make([]TrashItem, 0, len(nodes))
	for _, n := range nodes {
		item := TrashItem{Node: n, TrashedAt: *n.TrashedAt}
		if n.ParentID != nil {
			var pname string
			if err := s.Pool.QueryRow(ctx, "SELECT name FROM nodes WHERE id = $1", *n.ParentID).Scan(&pname); err == nil {
				item.FromFolder = pname
			}
		}
		out = append(out, item)
	}
	return out, nil
}

func (s *Store) ownTrashRoot(ctx context.Context, q Querier, u *User, id string) (*Node, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	var n *Node
	n, err := scanNode(q.QueryRow(ctx, nodeSelect("$2")+"WHERE n.id = $1 AND n.owner_id = $2 AND n.trash_root = n.id", id, u.ID))
	return n, err
}

// Restore brings a trashed item back to its folder, or to the root when that
// folder is gone or trashed. A clashing name gets a number.
func (s *Store) Restore(ctx context.Context, u *User, id string) (*Node, error) {
	err := s.Tx(ctx, func(tx pgx.Tx) error {
		n, err := s.ownTrashRoot(ctx, tx, u, id)
		if err != nil {
			return err
		}
		parent := u.RootID
		if n.ParentID != nil {
			var live bool
			if err := tx.QueryRow(ctx, "SELECT trashed_at IS NULL FROM nodes WHERE id = $1", *n.ParentID).Scan(&live); err == nil && live {
				parent = *n.ParentID
			}
		}
		if _, err := tx.Exec(ctx, "UPDATE nodes SET trashed_at = NULL, trash_root = NULL WHERE trash_root = $1 AND id <> $1", id); err != nil {
			return err
		}
		if _, err := withFreeName(ctx, tx, parent, n.Name, func(sp pgx.Tx, name string) error {
			_, err := sp.Exec(ctx, "UPDATE nodes SET trashed_at = NULL, trash_root = NULL, parent_id = $2, name = $3 WHERE id = $1", id, parent, name)
			return err
		}); err != nil {
			return err
		}
		return logActivity(ctx, tx, id, ActorOf(Subject{User: u}), "restored", "")
	})
	if err != nil {
		return nil, err
	}
	return s.getNode(ctx, s.Pool, id, u.ID)
}

// DeleteForever removes one trashed item and everything below it.
func (s *Store) DeleteForever(ctx context.Context, u *User, id string) error {
	return s.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := s.ownTrashRoot(ctx, tx, u, id); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "DELETE FROM nodes WHERE id = $1", id)
		return err
	})
}

// EmptyTrash removes everything in the user's trash.
func (s *Store) EmptyTrash(ctx context.Context, u *User) (int64, error) {
	tag, err := s.Pool.Exec(ctx, "DELETE FROM nodes WHERE owner_id = $1 AND trash_root = id", u.ID)
	return tag.RowsAffected(), err
}

// PurgeTrash removes trash older than the cutoff, for every user.
func (s *Store) PurgeTrash(ctx context.Context, cutoff time.Time) (int64, error) {
	tag, err := s.Pool.Exec(ctx, "DELETE FROM nodes WHERE trash_root = id AND trashed_at < $1", cutoff)
	return tag.RowsAffected(), err
}

// UnreferencedBlobs lists blobs no node points to any more.
func (s *Store) UnreferencedBlobs(ctx context.Context) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT b.id FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.blob_id = b.id) LIMIT 10000`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// DeleteBlobRow removes a blob's row if nothing references it. It returns
// false when the blob is in use again (a copy raced the collector).
func (s *Store) DeleteBlobRow(ctx context.Context, id string) (bool, error) {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM blobs b WHERE b.id = $1 AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.blob_id = b.id)`, id)
	if isFKViolation(err) {
		return false, nil
	}
	return tag.RowsAffected() == 1, err
}

// BlobExists reports whether a blob id has a row.
func (s *Store) BlobExists(ctx context.Context, id string) (bool, error) {
	var ok bool
	err := s.Pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM blobs WHERE id = $1)", id).Scan(&ok)
	return ok, err
}

// Search finds live nodes in the user's own space whose name contains q.
func (s *Store) Search(ctx context.Context, u *User, q string) ([]*Node, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return []*Node{}, nil
	}
	return collectNodes(s.Pool.Query(ctx, nodeSelect("$1")+`
		WHERE n.owner_id = $1 AND n.trashed_at IS NULL AND n.parent_id IS NOT NULL
		  AND lower(n.name) LIKE '%' || $2 || '%'
		ORDER BY similarity(lower(n.name), $3) DESC, lower(n.name) LIMIT 200`, u.ID, likeEscape(strings.ToLower(q)), strings.ToLower(q)))
}

// Recent lists the user's most recently changed files.
func (s *Store) Recent(ctx context.Context, u *User) ([]*Node, error) {
	return collectNodes(s.Pool.Query(ctx, nodeSelect("$1")+`
		WHERE n.owner_id = $1 AND n.trashed_at IS NULL AND NOT n.is_dir ORDER BY n.modified_at DESC LIMIT 50`, u.ID))
}

// Starred lists what the user starred and can still see.
func (s *Store) Starred(ctx context.Context, u *User) ([]*Node, error) {
	nodes, err := collectNodes(s.Pool.Query(ctx, nodeSelect("$1")+`
		JOIN stars sr ON sr.node_id = n.id AND sr.user_id = $1
		WHERE n.trashed_at IS NULL ORDER BY sr.created_at DESC`, u.ID))
	if err != nil {
		return nil, err
	}
	out := nodes[:0]
	for _, n := range nodes {
		if _, _, err := s.Authorize(ctx, s.Pool, Subject{User: u}, n.ID, NeedRead); err == nil {
			out = append(out, n)
		}
	}
	return out, nil
}

// SetStar stars or unstars a node the user can read.
func (s *Store) SetStar(ctx context.Context, u *User, id string, on bool) error {
	if _, _, err := s.Authorize(ctx, s.Pool, Subject{User: u}, id, NeedRead); err != nil {
		return err
	}
	var err error
	if on {
		_, err = s.Pool.Exec(ctx, "INSERT INTO stars (user_id, node_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", u.ID, id)
	} else {
		_, err = s.Pool.Exec(ctx, "DELETE FROM stars WHERE user_id = $1 AND node_id = $2", u.ID, id)
	}
	return err
}

// SharedWithMe lists nodes other people shared with the user.
func (s *Store) SharedWithMe(ctx context.Context, u *User) ([]*Node, error) {
	rows, err := s.Pool.Query(ctx, nodeSelect("$1")+`
		JOIN shares sh ON sh.node_id = n.id AND sh.grantee_id = $1
		WHERE n.trashed_at IS NULL ORDER BY sh.created_at DESC`, u.ID)
	if err != nil {
		return nil, err
	}
	return collectNodes(rows, nil)
}

// TreeEntry is one node below a folder, for ZIP downloads.
type TreeEntry struct {
	Path     string
	IsDir    bool
	BlobID   string
	Size     int64
	Modified time.Time
}

// Tree lists a node and everything live below it, with slash-separated paths
// starting at the node's own name (or at its children for a user's root).
func (s *Store) Tree(ctx context.Context, nodeID string) ([]TreeEntry, error) {
	rows, err := s.Pool.Query(ctx, `
		WITH RECURSIVE t AS (
			SELECT id, is_dir, coalesce(blob_id, '') AS blob, size, modified_at, name::text AS path FROM nodes WHERE id = $1
			UNION ALL
			SELECT n.id, n.is_dir, coalesce(n.blob_id, ''), n.size, n.modified_at,
				CASE WHEN t.path = '' THEN n.name ELSE t.path || '/' || n.name END
			FROM nodes n JOIN t ON n.parent_id = t.id WHERE n.trashed_at IS NULL
		) SELECT path, is_dir, blob, size, modified_at FROM t WHERE path <> '' ORDER BY path`, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TreeEntry
	for rows.Next() {
		var e TreeEntry
		if err := rows.Scan(&e.Path, &e.IsDir, &e.BlobID, &e.Size, &e.Modified); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ActivityEntry is one line of a node's history.
type ActivityEntry struct {
	Actor     string    `json:"actor"`
	Action    string    `json:"action"`
	Detail    string    `json:"detail"`
	CreatedAt time.Time `json:"createdAt"`
}

// Activity returns a node's history; only its owner may read it.
func (s *Store) Activity(ctx context.Context, u *User, id string) ([]ActivityEntry, error) {
	if _, _, err := s.Authorize(ctx, s.Pool, Subject{User: u}, id, NeedOwner); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT actor, action, detail, created_at FROM activity WHERE node_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[ActivityEntry])
}

// LogActivity records an event that happened outside a store transaction
// (for example a download through a public link).
func (s *Store) LogActivity(ctx context.Context, nodeID string, a Actor, action, detail string) error {
	return logActivity(ctx, s.Pool, nodeID, a, action, detail)
}

// Totals feeds the storage gauges.
type Totals struct {
	Files      int64
	UsedBytes  int64
	UserShares int64
	LinkShares int64
}

// Totals counts files, bytes and active shares across all users.
func (s *Store) Totals(ctx context.Context) (Totals, error) {
	var t Totals
	err := s.Pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM nodes WHERE NOT is_dir),
		(SELECT coalesce(sum(size), 0) FROM nodes WHERE NOT is_dir),
		(SELECT count(*) FROM shares sh JOIN nodes n ON n.id = sh.node_id WHERE n.trashed_at IS NULL),
		(SELECT count(*) FROM links l WHERE l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
			AND (l.max_downloads IS NULL OR l.download_count < l.max_downloads))`).Scan(&t.Files, &t.UsedBytes, &t.UserShares, &t.LinkShares)
	return t, err
}
