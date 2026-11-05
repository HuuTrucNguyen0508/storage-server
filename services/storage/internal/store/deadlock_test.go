package store

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/testdb"
	"github.com/jackc/pgx/v5"
)

func TestMain(m *testing.M) {
	code := m.Run()
	testdb.Stop()
	os.Exit(code)
}

// A folder/upload INSERT holds a user FK lock until its transaction ends.
// Owner serialization must remain compatible with that lock: otherwise a
// waiting owner lock can obstruct later FK checks while following row versions.
func TestOwnerLockDoesNotBlockForeignKeys(t *testing.T) {
	for _, operation := range []string{"quota", "move"} {
		t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			s, err := Open(ctx, testdb.New(t), 1<<20, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			u, err := s.UpsertUser(ctx, Identity{Username: "alice"})
			if err != nil {
				t.Fatal(err)
			}
			subj := Subject{User: u}
			dest, err := s.CreateFolder(ctx, subj, u.RootID, "dest")
			if err != nil {
				t.Fatal(err)
			}
			source, err := s.CreateFolder(ctx, subj, u.RootID, "source")
			if err != nil {
				t.Fatal(err)
			}
			writer, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Rollback(context.Background()) //nolint:errcheck
			var writerPID uint32
			if err := writer.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&writerPID); err != nil {
				t.Fatal(err)
			}
			// Use the same INSERT/savepoint and activity statements as folder uploads.
			if _, err := ensureDir(ctx, writer, u.ID, u.RootID, "in-flight", ActorOf(subj)); err != nil {
				t.Fatal(err)
			}
			if _, err := s.UpsertUser(ctx, Identity{Username: "alice"}); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				var err error
				if operation == "quota" {
					_, err = s.CreateUpload(ctx, subj, NewUploadInput{ParentID: dest.ID, Name: "reservation", Size: 1})
				} else {
					_, err = s.Move(ctx, subj, []string{source.ID}, dest.ID)
				}
				result <- err
			}()
			completed := false
			for !completed {
				select {
				case err := <-result:
					completed = true
					if err != nil {
						t.Error(err)
					}
				default:
					var blocked bool
					err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT 1 FROM users WHERE%')`, writerPID).Scan(&blocked)
					if err != nil {
						t.Fatal(err)
					}
					if blocked {
						t.Errorf("%s owner lock conflicts with an in-flight INSERT's foreign-key lock", operation)
						// Release the writer so the worker finishes even on the unfixed code.
						if err := writer.Commit(ctx); err != nil {
							t.Fatal(err)
						}
						if err := <-result; err != nil {
							t.Error(err)
						}
						completed = true
					} else {
						select {
						case <-ctx.Done():
							t.Fatal("owner operation did not complete: ", ctx.Err())
						case <-time.After(5 * time.Millisecond):
						}
					}
				}
			}
			if err := writer.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
				t.Fatal(err)
			}
		})
	}
}

// Step through ShareWith up to its INSERT on two connections so reciprocal
// shares both finish EnsurePlaceholder before either checks the creator FK.
func TestReciprocalSharesDoNotDeadlock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := Open(ctx, testdb.New(t), 1<<20, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	alice, err := s.UpsertUser(ctx, Identity{Username: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.UpsertUser(ctx, Identity{Username: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.CreateFolder(ctx, Subject{User: alice}, alice.RootID, "a")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateFolder(ctx, Subject{User: bob}, bob.RootID, "b")
	if err != nil {
		t.Fatal(err)
	}
	txA, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer txA.Rollback(context.Background()) //nolint:errcheck
	txB, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer txB.Rollback(context.Background()) //nolint:errcheck
	if _, err := s.EnsurePlaceholder(ctx, txA, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EnsurePlaceholder(ctx, txB, "alice"); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 2)
	insert := func(tx pgx.Tx, nodeID string, grantee, creator *User) {
		err := func() error {
			if _, err := tx.Exec(ctx, `INSERT INTO shares (node_id, grantee_id, permission, created_by) VALUES ($1, $2, 'edit', $3)`, nodeID, grantee.ID, creator.ID); err != nil {
				return err
			}
			return logActivity(ctx, tx, nodeID, ActorOf(Subject{User: creator}), "shared", "")
		}()
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		result <- err
	}
	go insert(txA, a.ID, bob, alice)
	go insert(txB, b.ID, alice, bob)
	for range 2 {
		if err := <-result; err != nil {
			t.Error(err)
		}
	}
}
