package store

import (
	"context"
	"regexp"
	"time"
)

// Perm is what a subject may do with a node.
type Perm int

const (
	PermNone  Perm = iota
	PermDrop       // upload into the folder only, without seeing it (drop links)
	PermRead       // view, list, download, preview
	PermEdit       // read plus upload, create, rename, move, copy into, trash
	PermOwner      // edit plus share, links, activity
)

// Need is the capability an operation requires.
type Need int

const (
	NeedRead Need = iota
	NeedUpload
	NeedEdit
	NeedOwner
)

func (p Perm) String() string {
	switch p {
	case PermDrop:
		return "drop"
	case PermRead:
		return "read"
	case PermEdit:
		return "edit"
	case PermOwner:
		return "owner"
	}
	return "none"
}

// Allows reports whether p satisfies need.
func (p Perm) Allows(need Need) bool {
	switch need {
	case NeedRead:
		return p >= PermRead
	case NeedUpload:
		return p == PermDrop || p >= PermEdit
	case NeedEdit:
		return p >= PermEdit
	case NeedOwner:
		return p == PermOwner
	}
	return false
}

// Subject is who is asking: a signed-in user or a guest holding a public link
// (already validated and unlocked by the caller). Exactly one is set.
type Subject struct {
	User *User
	Link *Link
}

// Crumb is one step of a breadcrumb trail.
type Crumb struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Access is the result of an authorization check.
type Access struct {
	Perm Perm
	// RootID is the highest node the subject can see on the way up: the
	// user's own root, the outermost shared folder, or the link's node.
	RootID string
	// Crumbs runs from RootID down to the node itself.
	Crumbs []Crumb
	// ViaShare is true when a user reaches the node through a share.
	ViaShare bool
}

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ValidID reports whether id looks like a node id.
func ValidID(id string) bool { return uuidRE.MatchString(id) }

// Authorize is the single authorization decision for a node. Every handler
// that touches a node calls it (directly or through a store method that does).
// Nodes the subject cannot see give ErrNotFound, so their existence does not
// leak; nodes the subject can see but not change give ErrForbidden.
func (s *Store) Authorize(ctx context.Context, q Querier, subj Subject, nodeID string, need Need) (*Node, *Access, error) {
	if !ValidID(nodeID) || (subj.User == nil) == (subj.Link == nil) {
		return nil, nil, ErrNotFound
	}
	var grantee int64
	if subj.User != nil {
		grantee = subj.User.ID
	}
	rows, err := q.Query(ctx, `
		WITH RECURSIVE anc AS (
			SELECT id, parent_id, name, 0 AS depth FROM nodes WHERE id = $1
			UNION ALL
			SELECT n.id, n.parent_id, n.name, anc.depth + 1 FROM nodes n JOIN anc ON n.id = anc.parent_id WHERE anc.depth < 512
		)
		SELECT anc.id::text, anc.name, s.permission FROM anc
		LEFT JOIN shares s ON s.node_id = anc.id AND s.grantee_id = $2
		ORDER BY anc.depth`, nodeID, grantee)
	if err != nil {
		return nil, nil, err
	}
	type anc struct {
		id, name string
		perm     *string
	}
	var chain []anc // chain[0] is the node, the last element is the owner's root
	for rows.Next() {
		var a anc
		if err := rows.Scan(&a.id, &a.name, &a.perm); err != nil {
			rows.Close()
			return nil, nil, err
		}
		chain = append(chain, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if len(chain) == 0 {
		return nil, nil, ErrNotFound
	}
	node, err := s.getNode(ctx, q, nodeID, grantee)
	if err != nil {
		return nil, nil, err
	}
	if node.TrashedAt != nil {
		return nil, nil, ErrNotFound
	}

	acc := &Access{}
	rootIdx := -1
	switch {
	case subj.User != nil && node.OwnerID == subj.User.ID:
		acc.Perm, rootIdx = PermOwner, len(chain)-1
	case subj.User != nil:
		for i, a := range chain {
			if a.perm == nil {
				continue
			}
			p := PermRead
			if *a.perm == "edit" {
				p = PermEdit
			}
			acc.Perm = max(acc.Perm, p)
			rootIdx = i // keep the outermost share as the visible root
		}
		acc.ViaShare = rootIdx >= 0
	case subj.Link != nil:
		for i, a := range chain {
			if a.id == subj.Link.NodeID {
				rootIdx = i
				break
			}
		}
		if rootIdx >= 0 {
			acc.Perm = PermRead
			if subj.Link.Kind == LinkDrop {
				if rootIdx != 0 {
					return nil, nil, ErrNotFound // nothing below a drop folder is visible
				}
				acc.Perm = PermDrop
			}
		}
	}
	if rootIdx < 0 || acc.Perm == PermNone {
		return nil, nil, ErrNotFound
	}
	acc.RootID = chain[rootIdx].id
	for i := rootIdx; i >= 0; i-- {
		acc.Crumbs = append(acc.Crumbs, Crumb{ID: chain[i].id, Name: chain[i].name})
	}
	if !acc.Perm.Allows(need) {
		if acc.Perm == PermDrop {
			return nil, nil, ErrNotFound
		}
		return nil, nil, ErrForbidden
	}
	return node, acc, nil
}

// requireMutable refuses changes to a user's root and, for people reaching a
// node through a share, to the shared folder itself (it belongs to its owner).
func requireMutable(node *Node, acc *Access) error {
	if node.ParentID == nil {
		return ErrForbidden
	}
	if acc.Perm != PermOwner && node.ID == acc.RootID {
		return ErrForbidden
	}
	return nil
}

// LinkState says why a link does or does not work.
func (l *Link) State(now time.Time) error {
	switch {
	case l.RevokedAt != nil:
		return ErrNotFound
	case l.ExpiresAt != nil && !now.Before(*l.ExpiresAt):
		return ErrGone
	case l.MaxDownloads != nil && l.DownloadCount >= *l.MaxDownloads:
		return ErrGone
	}
	return nil
}
