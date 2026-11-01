package access

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"storage-server/internal/disk"
	"storage-server/internal/store"
)

var (
	now     = time.Unix(1_000_000, 0)
	past    = now.Add(-time.Second)
	future  = now.Add(time.Hour)
	limit3  = 3
	live, _ = disk.ParseLocation("live:a")
	gone, _ = disk.ParseLocation("trash:T/a")
)

func TestStateOf(t *testing.T) {
	for _, c := range []struct {
		name   string
		share  store.Share
		exists bool
		want   State
	}{
		{"plain", store.Share{Target: live}, true, Active},
		{"future expiry", store.Share{Target: live, ExpiresAt: &future}, true, Active},
		{"past expiry", store.Share{Target: live, ExpiresAt: &past}, true, Expired},
		{"expiry is exact", store.Share{Target: live, ExpiresAt: &now}, true, Expired},
		{"under limit", store.Share{Target: live, MaxUses: &limit3, Uses: 2}, true, Active},
		{"at limit", store.Share{Target: live, MaxUses: &limit3, Uses: 3}, true, Exhausted},
		{"trashed outranks expiry", store.Share{Target: gone, ExpiresAt: &past}, true, Suspended},
		{"missing outranks expiry", store.Share{Target: live, ExpiresAt: &past}, false, Missing},
		{"trash ignores the stat", store.Share{Target: gone}, false, Suspended},
		{"expired outranks exhausted", store.Share{Target: live, ExpiresAt: &past, MaxUses: &limit3, Uses: 3}, true, Expired},
	} {
		if got := StateOf(c.share, now, c.exists); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestDecide(t *testing.T) {
	link := store.Share{ID: "s", Kind: store.ShareLink}
	drop := store.Share{ID: "s", Kind: store.ShareDrop}
	fresh := &store.Grant{ShareID: "s", ExpiresAt: future}
	consumed := &store.Grant{ShareID: "s", ExpiresAt: future, Consumed: true}
	stale := &store.Grant{ShareID: "s", ExpiresAt: past, Consumed: true}
	foreign := &store.Grant{ShareID: "other", ExpiresAt: future, Consumed: true}
	for _, c := range []struct {
		name  string
		share store.Share
		state State
		grant *store.Grant
		act   Act
		want  Decision
	}{
		{"browse a link", link, Active, fresh, Browse, Allow},
		{"fetch a link", link, Active, fresh, Fetch, AllowAndConsume},
		{"no grant", link, Active, nil, Fetch, DenyNeedsGrant},
		{"expired grant", link, Active, stale, Fetch, DenyNeedsGrant},
		{"another share's grant", link, Active, foreign, Fetch, DenyNeedsGrant},
		{"expired share", link, Expired, consumed, Fetch, DenyGone},
		{"suspended share", link, Suspended, consumed, Browse, DenyGone},
		{"missing target", link, Missing, consumed, Browse, DenyGone},
		{"exhausted, new guest", link, Exhausted, fresh, Fetch, DenyGone},
		{"exhausted, no grant", link, Exhausted, nil, Browse, DenyGone},
		{"exhausted, holder fetches", link, Exhausted, consumed, Fetch, AllowAndConsume},
		{"exhausted, holder browses", link, Exhausted, consumed, Browse, Allow},
		{"exhausted, holder's grant expired", link, Exhausted, stale, Fetch, DenyGone},
		{"upload to a link", link, Active, fresh, Upload, DenyWrongKind},
		{"upload to a drop", drop, Active, fresh, Upload, AllowAndConsume},
		{"browse a drop", drop, Active, fresh, Browse, DenyWrongKind},
		{"fetch from a drop", drop, Active, fresh, Fetch, DenyWrongKind},
		{"drop without a grant", drop, Active, nil, Upload, DenyNeedsGrant},
		{"suspended drop", drop, Suspended, fresh, Upload, DenyGone},
	} {
		if got := Decide(c.share, c.state, c.grant, c.act, now); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestLockFor(t *testing.T) {
	for failures, want := range map[int]time.Duration{
		0: 0, 4: 0, 5: 30 * time.Second, 6: time.Minute, 7: 2 * time.Minute,
		11: 32 * time.Minute, 12: time.Hour, 500: time.Hour,
	} {
		if got := lockFor(failures); got != want {
			t.Errorf("lockFor(%d) = %v, want %v", failures, got, want)
		}
	}
}

type env struct {
	s    *Service
	db   *store.Store
	root string
}

func setup(t *testing.T) env {
	t.Helper()
	root := filepath.Join(t.TempDir(), "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	d, err := disk.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	log := slog.Default()
	slog.SetDefault(slog.New(slog.DiscardHandler))
	s, err := New(context.Background(), db, d.Files)
	slog.SetDefault(log)
	if err != nil {
		t.Fatal(err)
	}
	return env{s, db, root}
}

const password = "correct horse"

func (e env) claim(t *testing.T) Cookie {
	t.Helper()
	c, err := e.s.Setup(context.Background(), e.s.setup, password, Client{UserAgent: "ua", IP: "1.2.3.4"})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSetupClaimsOnce(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	if len(e.s.setup) != 16 {
		t.Fatalf("setup code = %q", e.s.setup)
	}
	if _, err := e.s.Setup(ctx, "wrong", password, Client{}); !errors.Is(err, ErrBadCode) {
		t.Fatalf("wrong code = %v", err)
	}
	code := e.s.setup
	if _, err := e.s.Setup(ctx, code, "short", Client{}); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("weak password = %v", err)
	}
	if _, err := e.s.Login(ctx, password, Client{}); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("login before setup = %v", err)
	}
	cookie, err := e.s.Setup(ctx, code, password, Client{UserAgent: "ua"})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := e.s.Authenticate(ctx, cookie.Value)
	if err != nil || sess.UserAgent != "ua" {
		t.Fatalf("Authenticate = %+v, %v", sess, err)
	}
	if _, err := e.s.Setup(ctx, code, password, Client{}); !errors.Is(err, ErrAlreadySetUp) {
		t.Fatalf("second claim = %v", err)
	}
}

func TestLoginLockoutSkipsVerification(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.claim(t)
	for i := range freeAttempts {
		if _, err := e.s.Login(ctx, "wrong password", Client{}); !errors.Is(err, ErrBadCredentials) {
			t.Fatalf("attempt %d = %v", i, err)
		}
	}
	_, err := e.s.Login(ctx, password, Client{})
	var locked *LockedError
	if !errors.As(err, &locked) || !errors.Is(err, ErrRateLimited) {
		t.Fatalf("right password while locked = %v", err)
	}
	if left := time.Until(locked.Until); left <= 0 || left > firstLock {
		t.Fatalf("locked for %v", left)
	}
	if err := e.db.SetLimiter(ctx, ownerLimiterKey, store.LimiterState{Failures: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Login(ctx, password, Client{}); err != nil {
		t.Fatalf("login after the lock opened = %v", err)
	}
	if st, _ := e.db.Limiter(ctx, ownerLimiterKey); st.Failures != 0 {
		t.Fatalf("success left %d failures", st.Failures)
	}
}

func TestChangePasswordRevokesOthers(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	first := e.claim(t)
	second, err := e.s.Login(ctx, password, Client{})
	if err != nil {
		t.Fatal(err)
	}
	me, err := e.s.Authenticate(ctx, first.Value)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.s.ChangePassword(ctx, me.ID, "wrong password", "a new password"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("wrong current = %v", err)
	}
	if err := e.s.ChangePassword(ctx, me.ID, password, "short"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("weak next = %v", err)
	}
	if err := e.s.ChangePassword(ctx, me.ID, password, "a new password"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Authenticate(ctx, second.Value); !errors.Is(err, ErrNoSession) {
		t.Fatalf("other session = %v", err)
	}
	if _, err := e.s.Authenticate(ctx, first.Value); err != nil {
		t.Fatalf("current session = %v", err)
	}
	if _, err := e.s.Login(ctx, password, Client{}); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("old password = %v", err)
	}
	if _, err := e.s.Login(ctx, "a new password", Client{}); err != nil {
		t.Fatalf("new password = %v", err)
	}
}

func (e env) share(t *testing.T, sh store.Share) store.Share {
	t.Helper()
	if err := os.WriteFile(filepath.Join(e.root, "a"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	sh.Target = live
	sh.CreatedAt = time.Now()
	if err := e.db.CreateShare(context.Background(), sh); err != nil {
		t.Fatal(err)
	}
	return sh
}

func TestGuestAdmissionAndSpending(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	limit := 1
	e.share(t, store.Share{ID: "s", Token: "tok", Kind: store.ShareLink, MaxUses: &limit})

	if _, err := e.s.Admit(ctx, "tok", "", Fetch); !errors.Is(err, ErrNeedsGrant) {
		t.Fatalf("no grant = %v", err)
	}
	if _, err := e.s.Admit(ctx, "nope", "", Fetch); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown token = %v", err)
	}
	holder, err := e.s.Open(ctx, "tok", "")
	if err != nil {
		t.Fatal(err)
	}
	late, err := e.s.Open(ctx, "tok", "")
	if err != nil {
		t.Fatal(err)
	}
	a, err := e.s.Admit(ctx, "tok", holder.Value, Fetch)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.s.Consume(ctx, a, "file"); err != nil {
		t.Fatal(err)
	}
	if err := e.s.Consume(ctx, a, "file"); err != nil {
		t.Fatalf("a repeat fetch must be free: %v", err)
	}
	b, err := e.s.Admit(ctx, "tok", holder.Value, Fetch)
	if err != nil {
		t.Fatalf("holder after exhaustion: %v", err)
	}
	if err := e.s.Consume(ctx, b, "another"); !errors.Is(err, ErrExhausted) {
		t.Fatalf("second item past the limit = %v", err)
	}
	if _, err := e.s.Admit(ctx, "tok", late.Value, Browse); !errors.Is(err, ErrExhausted) {
		t.Fatalf("late guest = %v", err)
	}
	if _, err := e.s.Open(ctx, "tok", ""); !errors.Is(err, ErrExhausted) {
		t.Fatalf("open after exhaustion = %v", err)
	}
	if _, _, err := e.s.Describe(ctx, "tok", ""); !errors.Is(err, ErrExhausted) {
		t.Fatalf("Describe for a stranger = %v", err)
	}
	if _, st, err := e.s.Describe(ctx, "tok", holder.Value); err != nil || st != Exhausted {
		t.Fatalf("Describe for a holder = %v, %v", st, err)
	}
}

func TestSharePasswordGoesThroughTheLimiter(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	hash, err := HashPassword(ctx, "guest password")
	if err != nil {
		t.Fatal(err)
	}
	e.share(t, store.Share{ID: "s", Token: "tok", Kind: store.ShareLink, PasswordHash: hash})
	for range freeAttempts {
		if _, err := e.s.Open(ctx, "tok", "nope"); !errors.Is(err, ErrBadCredentials) {
			t.Fatalf("wrong password = %v", err)
		}
	}
	if _, err := e.s.Open(ctx, "tok", "guest password"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("locked = %v", err)
	}
	if err := e.db.ClearLimiter(ctx, "share:s"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Open(ctx, "tok", "guest password"); err != nil {
		t.Fatalf("right password = %v", err)
	}
}

func TestPasswordHashRoundTrip(t *testing.T) {
	ctx := context.Background()
	hash, err := HashPassword(ctx, "pw-one-two")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=47104,t=1,p=1$") {
		t.Fatalf("hash = %q", hash)
	}
	if ok, err := VerifyPassword(ctx, hash, "pw-one-two"); err != nil || !ok {
		t.Fatalf("right password = %v, %v", ok, err)
	}
	if ok, err := VerifyPassword(ctx, hash, "pw-one-twO"); err != nil || ok {
		t.Fatalf("wrong password = %v, %v", ok, err)
	}
	if _, err := VerifyPassword(ctx, "not a hash", "x"); err == nil {
		t.Fatal("accepted a malformed hash")
	}
}
