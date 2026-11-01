package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"storage-server/internal/disk"
)

func open(t testing.TB) *sql.DB {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s.db
}
func addShare(t testing.TB, db *sql.DB, id, target string, max any) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO shares (id, token, kind, target, max_uses, created_at) VALUES (?, ?, 'link', ?, ?, 0)`, id, "tok-"+id, target, max)
	if err != nil {
		t.Fatal(err)
	}
}

func target(t *testing.T, db *sql.DB, id string) string {
	t.Helper()
	var s string
	if err := db.QueryRow(`SELECT target FROM shares WHERE id = ?`, id).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRewriteFollowsFolderAndNothingElse(t *testing.T) {
	db := open(t)
	addShare(t, db, "self", "live:a%b_c", nil)
	addShare(t, db, "child", "live:a%b_c/ü/x.txt", nil)
	addShare(t, db, "sibling", "live:a%b_c2", nil)
	addShare(t, db, "like-trap", "live:aXbYc/x", nil)
	addShare(t, db, "root", "live:", nil)

	if _, err := db.Exec(rewriteTargets, "live:a%b_c", "trash:T1"); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{
		"self": "trash:T1", "child": "trash:T1/ü/x.txt",
		"sibling": "live:a%b_c2", "like-trap": "live:aXbYc/x", "root": "live:",
	} {
		if got := target(t, db, id); got != want {
			t.Errorf("after trash %s = %q, want %q", id, got, want)
		}
	}

	if _, err := db.Exec(rewriteTargets, "trash:T1", "live:restored (1)"); err != nil {
		t.Fatal(err)
	}
	if got := target(t, db, "child"); got != "live:restored (1)/ü/x.txt" {
		t.Errorf("after restore child = %q", got)
	}

	if _, err := db.Exec(rewriteTargets, "live:restored (1)", "live:b"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(rewriteTargets, "live:b", "trash:T2"); err != nil {
		t.Fatal(err)
	}
	res, err := db.Exec(deleteTargets, "trash:T2")
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := res.RowsAffected(); n != 2 {
		t.Errorf("purge deleted %d shares, want 2", n)
	}
}

func TestMaxUsesHoldsUnderRace(t *testing.T) {
	db := open(t)
	st := &Store{db: db}
	addShare(t, db, "s", "live:f", 3)
	const guests = 40
	for i := range guests {
		_, err := db.Exec(`INSERT INTO grants (id, token_hash, share_id, expires_at) VALUES (?, ?, 's', 9999999999)`, fmt.Sprint("g", i), []byte(fmt.Sprint(i)))
		if err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	admitted, failed := 0, 0
	var wg sync.WaitGroup
	for i := range guests {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 3 {
				err := st.TakeItem(context.Background(), GrantID(fmt.Sprint("g", i)), "s", "file")
				mu.Lock()
				switch {
				case errors.Is(err, ErrExhausted):
				case err != nil:
					failed++
				default:
					admitted++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	var uses int
	if err := db.QueryRow(`SELECT uses FROM shares WHERE id = 's'`).Scan(&uses); err != nil {
		t.Fatal(err)
	}
	t.Logf("requests admitted=%d errors=%d uses=%d", admitted, failed, uses)
	if uses != 3 {
		t.Fatalf("uses = %d, want exactly 3 of %d guests", uses, guests)
	}
	if admitted != 9 {
		t.Fatalf("admitted = %d, want 9: the 3 winners each retry their consumed grant for free", admitted)
	}
	if failed != 0 {
		t.Fatalf("%d busy errors despite busy_timeout", failed)
	}
}

func TestEachDistinctItemTakesOneUse(t *testing.T) {
	db := open(t)
	st := &Store{db: db}
	ctx := context.Background()
	addShare(t, db, "s", "live:f", 2)
	if _, err := db.Exec(`INSERT INTO grants (id, token_hash, share_id, expires_at) VALUES ('g', x'01', 's', 9999999999)`); err != nil {
		t.Fatal(err)
	}
	steps := []struct {
		item string
		want error
		uses int
	}{
		{"a.txt", nil, 1},
		{"a.txt", nil, 1},
		{"zip:1", nil, 2},
		{"b.txt", ErrExhausted, 2},
		{"a.txt", nil, 2},
	}
	for _, s := range steps {
		if err := st.TakeItem(ctx, "g", "s", s.item); !errors.Is(err, s.want) {
			t.Fatalf("TakeItem(%s) = %v, want %v", s.item, err, s.want)
		}
		var uses int
		if err := db.QueryRow(`SELECT uses FROM shares WHERE id = 's'`).Scan(&uses); err != nil {
			t.Fatal(err)
		}
		if uses != s.uses {
			t.Fatalf("after %s uses = %d, want %d", s.item, uses, s.uses)
		}
	}
	var refused int
	if err := db.QueryRow(`SELECT count(*) FROM grant_items WHERE item = 'b.txt'`).Scan(&refused); err != nil {
		t.Fatal(err)
	}
	if refused != 0 {
		t.Fatal("a refused item stayed recorded, so a later retry would be free")
	}
	g, err := st.GrantByHash(ctx, []byte{1})
	if err != nil || !g.Consumed {
		t.Fatalf("grant = %+v, %v", g, err)
	}
}

func TestGrantWithNoItemIsNotConsumed(t *testing.T) {
	db := open(t)
	st := &Store{db: db}
	addShare(t, db, "s", "live:f", nil)
	if _, err := db.Exec(`INSERT INTO grants (id, token_hash, share_id, expires_at) VALUES ('g', x'01', 's', 5)`); err != nil {
		t.Fatal(err)
	}
	g, err := st.GrantByHash(context.Background(), []byte{1})
	if err != nil || g.Consumed || g.ShareID != "s" || g.ExpiresAt.Unix() != 5 {
		t.Fatalf("grant = %+v, %v", g, err)
	}
}

func TestChangePasswordKeepsOnlyTheCurrentSession(t *testing.T) {
	db := open(t)
	st := &Store{db: db}
	ctx := context.Background()
	if err := st.CreateOwner(ctx, "old"); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for i, id := range []SessionID{"keep", "other"} {
		sess := Session{ID: id, CreatedAt: now, LastSeenAt: now, ExpiresAt: now.Add(time.Hour)}
		if err := st.CreateSession(ctx, sess, []byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.ChangePassword(ctx, "new", "keep"); err != nil {
		t.Fatal(err)
	}
	if h, ok, err := st.OwnerHash(ctx); err != nil || !ok || h != "new" {
		t.Fatalf("hash = %q %v %v", h, ok, err)
	}
	sessions, err := st.ListSessions(ctx)
	if err != nil || len(sessions) != 1 || sessions[0].ID != "keep" {
		t.Fatalf("sessions = %+v, %v", sessions, err)
	}
}

func TestResetOwnerAllowsSetupAgainAndKeepsShares(t *testing.T) {
	db := open(t)
	st := &Store{db: db}
	ctx := context.Background()
	addShare(t, db, "s", "live:f", nil)
	if err := st.CreateOwner(ctx, "old"); err != nil {
		t.Fatal(err)
	}
	if err := st.ResetOwner(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateOwner(ctx, "new"); err != nil {
		t.Fatalf("setup after reset: %v", err)
	}
	if err := st.CreateOwner(ctx, "third"); !errors.Is(err, ErrExists) {
		t.Fatalf("second owner: %v", err)
	}
	if n, err := st.CountShares(ctx); err != nil || n != 1 {
		t.Fatalf("shares = %d, %v", n, err)
	}
}

func TestSharePersistsItsOptionalFields(t *testing.T) {
	db := open(t)
	st := &Store{db: db}
	ctx := context.Background()
	expires := time.Unix(2000, 0)
	limit := 3
	loc, _ := disk.ParseLocation("trash:T/x")
	in := Share{ID: "a", Token: "t", Kind: ShareDrop, Target: loc, PasswordHash: "h", ExpiresAt: &expires, MaxUses: &limit, CreatedAt: time.Unix(1000, 0)}
	if err := st.CreateShare(ctx, in); err != nil {
		t.Fatal(err)
	}
	got, err := st.ShareByToken(ctx, "t")
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != ShareDrop || got.Target.String() != "trash:T/x" || got.PasswordHash != "h" || got.ExpiresAt.Unix() != 2000 || *got.MaxUses != 3 {
		t.Fatalf("got %+v", got)
	}
	if err := st.CreateShare(ctx, Share{ID: "b", Token: "u", Kind: ShareLink, CreatedAt: time.Unix(1, 0)}); err != nil {
		t.Fatal(err)
	}
	got, err = st.ShareByID(ctx, "b")
	if err != nil || got.ExpiresAt != nil || got.MaxUses != nil || got.PasswordHash != "" || got.Target.String() != "live:" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if _, err := st.ShareByToken(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing token = %v", err)
	}
}

func TestLimiterRoundTrip(t *testing.T) {
	st := &Store{db: open(t)}
	ctx := context.Background()
	if got, err := st.Limiter(ctx, "k"); err != nil || got.Failures != 0 {
		t.Fatalf("empty limiter = %+v, %v", got, err)
	}
	if err := st.SetLimiter(ctx, "k", LimiterState{Failures: 2, LockedUntil: time.Unix(50, 0)}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLimiter(ctx, "k", LimiterState{Failures: 3, LockedUntil: time.Unix(60, 0)}); err != nil {
		t.Fatal(err)
	}
	if got, err := st.Limiter(ctx, "k"); err != nil || got.Failures != 3 || got.LockedUntil.Unix() != 60 {
		t.Fatalf("limiter = %+v, %v", got, err)
	}
	if err := st.ClearLimiter(ctx, "k"); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.Limiter(ctx, "k"); got.Failures != 0 {
		t.Fatalf("cleared limiter = %+v", got)
	}
}

func TestMoveJournalRecordsTheInode(t *testing.T) {
	st := &Store{db: open(t)}
	ctx := context.Background()
	from, _ := disk.ParseLocation("live:a")
	to, _ := disk.ParseLocation("live:b")
	id, err := st.BeginMove(ctx, from, to, 1<<40+7)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := st.PendingMoves(ctx)
	if err != nil || len(rows) != 1 || rows[0].ID != id || rows[0].Inode != 1<<40+7 || rows[0].To.String() != "live:b" {
		t.Fatalf("rows = %+v, %v", rows, err)
	}
}

func TestForgetMoveDeletesTheSharesItCannotTrust(t *testing.T) {
	db := open(t)
	st := &Store{db: db}
	ctx := context.Background()
	addShare(t, db, "self", "live:a", nil)
	addShare(t, db, "child", "live:a/x", nil)
	addShare(t, db, "sibling", "live:ab", nil)
	from, _ := disk.ParseLocation("live:a")
	to, _ := disk.ParseLocation("live:b")
	id, err := st.BeginMove(ctx, from, to, 9)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.ForgetMove(ctx, PendingMove{ID: id, From: from, To: to}); err != nil {
		t.Fatal(err)
	}
	rows, _ := st.PendingMoves(ctx)
	shares, _ := st.ListShares(ctx)
	if len(rows) != 0 || len(shares) != 1 || shares[0].ID != "sibling" {
		t.Fatalf("rows = %+v, shares = %+v", rows, shares)
	}
}

func TestDeletingShareRevokesGrants(t *testing.T) {
	db := open(t)
	addShare(t, db, "s", "live:f", nil)
	if _, err := db.Exec(`INSERT INTO grants (id, token_hash, share_id, expires_at) VALUES ('g', x'00', 's', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM shares WHERE id = 's'`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM grants`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d grants survived revoke", n)
	}
}

func TestSecondOwnerRefused(t *testing.T) {
	db := open(t)
	if _, err := db.Exec(`INSERT INTO owner (id, password_hash, created_at) VALUES (1, 'x', 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO owner (id, password_hash, created_at) VALUES (1, 'y', 0)`); err == nil {
		t.Fatal("second owner accepted")
	}
	if _, err := db.Exec(`INSERT INTO owner (id, password_hash, created_at) VALUES (2, 'y', 0)`); err == nil {
		t.Fatal("owner id 2 accepted")
	}
}

func BenchmarkJournaledMoveTx(b *testing.B) {
	db := open(b)
	addShare(b, db, "s", "live:a", nil)
	for b.Loop() {
		res, err := db.Exec(`INSERT INTO pending_moves (from_loc, to_loc, src_inode, started_at) VALUES ('live:a', 'live:a', 1, 0)`)
		if err != nil {
			b.Fatal(err)
		}
		id, _ := res.LastInsertId()
		tx, err := db.Begin()
		if err != nil {
			b.Fatal(err)
		}
		tx.Exec(rewriteTargets, "live:a", "live:a")
		tx.Exec(`DELETE FROM pending_moves WHERE id = ?`, id)
		if err := tx.Commit(); err != nil {
			b.Fatal(err)
		}
	}
}
