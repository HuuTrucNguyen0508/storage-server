package store

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func open(t testing.TB) *sql.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "s.db") +
		"?_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
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

func consume(db *sql.DB, grant, share string) (bool, error) {
	tx, err := db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(consumeGrant, grant, time.Now().Unix())
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return true, tx.Commit()
	}
	res, err = tx.Exec(takeUse, share)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, nil
	}
	return true, tx.Commit()
}

func TestMaxUsesHoldsUnderRace(t *testing.T) {
	db := open(t)
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
				ok, err := consume(db, fmt.Sprint("g", i), "s")
				mu.Lock()
				switch {
				case err != nil:
					failed++
				case ok:
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
		res, err := db.Exec(`INSERT INTO pending_moves (from_loc, to_loc, started_at) VALUES ('live:a', 'live:a', 0)`)
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
