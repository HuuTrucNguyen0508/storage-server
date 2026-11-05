package store

import (
	"context"
	"fmt"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/names"
	"github.com/jackc/pgx/v5"
)

// Upload is a resumable upload session. Its declared size is reserved
// against the owner's quota until it finishes, is cancelled, or expires.
type Upload struct {
	ID         string
	OwnerID    int64
	UploaderID *int64
	LinkID     *string
	ParentID   string
	RelDirs    []string
	Name       string
	Size       int64
	Received   int64
	HashState  []byte
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

const uploadCols = `id::text, owner_id, uploader_id, link_id::text, parent_id::text, rel_dirs, name, size, received, hash_state, created_at, updated_at`

func scanUpload(row pgx.Row) (*Upload, error) {
	var u Upload
	err := row.Scan(&u.ID, &u.OwnerID, &u.UploaderID, &u.LinkID, &u.ParentID, &u.RelDirs, &u.Name, &u.Size, &u.Received, &u.HashState, &u.CreatedAt, &u.UpdatedAt)
	return &u, notFound(err)
}

// NewUploadInput describes a file about to be uploaded.
type NewUploadInput struct {
	ParentID     string
	RelativePath string // optional folder path below the parent, e.g. "photos/2024"
	Name         string
	Size         int64
	MaxSize      int64
}

// CreateUpload checks permission, names and quota, then opens a session.
func (s *Store) CreateUpload(ctx context.Context, subj Subject, in NewUploadInput) (*Upload, error) {
	name, err := names.Normalize(in.Name)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	dirs, err := names.SplitPath(in.RelativePath)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if in.Size < 0 {
		return nil, fmt.Errorf("%w: size must not be negative", ErrInvalid)
	}
	if in.MaxSize > 0 && in.Size > in.MaxSize {
		return nil, ErrTooLarge
	}
	var up *Upload
	err = s.Tx(ctx, func(tx pgx.Tx) error {
		parent, _, err := s.Authorize(ctx, tx, subj, in.ParentID, NeedUpload)
		if err != nil {
			return err
		}
		if !parent.IsDir {
			return ErrInvalid
		}
		if err := s.checkQuota(ctx, tx, parent.OwnerID, in.Size); err != nil {
			return err
		}
		var uploader *int64
		var link *string
		if subj.User != nil {
			uploader = &subj.User.ID
		} else {
			link = &subj.Link.ID
		}
		up, err = scanUpload(tx.QueryRow(ctx, `INSERT INTO upload_sessions (owner_id, uploader_id, link_id, parent_id, rel_dirs, name, size)
			VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING `+uploadCols, parent.OwnerID, uploader, link, parent.ID, dirs, name, in.Size))
		return err
	})
	return up, err
}

// GetUpload returns a session that belongs to the subject.
func (s *Store) GetUpload(ctx context.Context, subj Subject, id string) (*Upload, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	up, err := scanUpload(s.Pool.QueryRow(ctx, "SELECT "+uploadCols+" FROM upload_sessions WHERE id = $1", id))
	if err != nil {
		return nil, err
	}
	switch {
	case subj.User != nil && up.UploaderID != nil && *up.UploaderID == subj.User.ID:
	case subj.Link != nil && up.LinkID != nil && *up.LinkID == subj.Link.ID:
	default:
		return nil, ErrNotFound
	}
	return up, nil
}

// AdvanceUpload records how many bytes are safely on disk.
func (s *Store) AdvanceUpload(ctx context.Context, id string, received int64, hashState []byte) error {
	_, err := s.Pool.Exec(ctx, "UPDATE upload_sessions SET received = $2, hash_state = $3, updated_at = now() WHERE id = $1", id, received, hashState)
	return err
}

// FinishUpload turns a complete session into a file node pointing at the
// new blob. Permission is checked again: the folder may have been trashed or
// unshared while the bytes were arriving.
func (s *Store) FinishUpload(ctx context.Context, subj Subject, up *Upload, blobID, sha string) (*Node, error) {
	var id string
	err := s.Tx(ctx, func(tx pgx.Tx) error {
		parent, _, err := s.Authorize(ctx, tx, subj, up.ParentID, NeedUpload)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "INSERT INTO blobs (id, size, sha256) VALUES ($1, $2, $3)", blobID, up.Size, sha); err != nil {
			return err
		}
		actor := ActorOf(subj)
		dir, err := ensureDirs(ctx, tx, parent, up.RelDirs, actor)
		if err != nil {
			return err
		}
		if _, err := withFreeName(ctx, tx, dir, up.Name, func(sp pgx.Tx, name string) error {
			return sp.QueryRow(ctx, `INSERT INTO nodes (owner_id, parent_id, is_dir, name, size, blob_id, created_by)
				VALUES ($1, $2, false, $3, $4, $5, $6) RETURNING id::text`, parent.OwnerID, dir, name, up.Size, blobID, actor.ID).Scan(&id)
		}); err != nil {
			return err
		}
		touch(ctx, tx, dir)
		action := "uploaded"
		if subj.Link != nil {
			action = "uploaded_by_link"
		}
		if err := logActivity(ctx, tx, id, actor, action, ""); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "DELETE FROM upload_sessions WHERE id = $1", up.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.getNode(ctx, s.Pool, id, viewerID(subj))
}

// DeleteUpload removes a session row.
func (s *Store) DeleteUpload(ctx context.Context, id string) error {
	_, err := s.Pool.Exec(ctx, "DELETE FROM upload_sessions WHERE id = $1", id)
	return err
}

// StaleUploads lists sessions untouched since the cutoff.
func (s *Store) StaleUploads(ctx context.Context, cutoff time.Time) ([]string, error) {
	rows, err := s.Pool.Query(ctx, "SELECT id::text FROM upload_sessions WHERE updated_at < $1", cutoff)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// UploadExists reports whether a session row exists.
func (s *Store) UploadExists(ctx context.Context, id string) (bool, error) {
	var ok bool
	err := s.Pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM upload_sessions WHERE id = $1)", id).Scan(&ok)
	return ok, err
}

// BlobInfo returns a blob's checksum.
func (s *Store) BlobSHA(ctx context.Context, id string) (string, error) {
	var sha string
	err := s.Pool.QueryRow(ctx, "SELECT sha256 FROM blobs WHERE id = $1", id).Scan(&sha)
	return sha, notFound(err)
}
