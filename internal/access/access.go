package access

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"

	"storage-server/internal/store"
)

const (
	SessionTTL = 30 * 24 * time.Hour
	GrantTTL   = 12 * time.Hour

	MinPasswordBytes = 8

	freeAttempts = 5
	firstLock    = 30 * time.Second
	longestLock  = time.Hour

	ownerLimiterKey = "owner"
	setupLimiterKey = "setup"
)

var (
	ErrBadCredentials = errors.New("bad credentials")
	ErrBadCode        = errors.New("bad setup code")
	ErrWeakPassword   = errors.New("password is too short")
	ErrRateLimited    = errors.New("too many attempts")
	ErrAlreadySetUp   = errors.New("already set up")
	ErrNoSession      = errors.New("no session")
	ErrNeedsGrant     = errors.New("open the link first")
	ErrWrongKind      = errors.New("this link does not allow that")

	ErrGone        = errors.New("link no longer available")
	ErrExpired     = fmt.Errorf("%w: expired", ErrGone)
	ErrExhausted   = fmt.Errorf("%w: exhausted", ErrGone)
	ErrUnavailable = fmt.Errorf("%w: unavailable", ErrGone)
)

// LockedError is ErrRateLimited with the time the limiter opens again.
type LockedError struct{ Until time.Time }

func (e *LockedError) Error() string        { return ErrRateLimited.Error() }
func (e *LockedError) Is(target error) bool { return target == ErrRateLimited }

// Act is what a guest request wants. Fetch and Upload are consequential: the
// first one of each item on a grant takes one use. Browse is free, so a link
// preview bot, a folder listing or a thumbnail never spends a use.
type Act int

const (
	Browse Act = iota
	Fetch
	Upload
)

type State int

const (
	Active State = iota
	Expired
	Exhausted
	Suspended
	Missing
)

func (s State) String() string {
	return [...]string{"active", "expired", "exhausted", "suspended", "missing"}[s]
}

type Decision int

const (
	Allow Decision = iota
	AllowAndConsume
	DenyNeedsGrant
	DenyGone
	DenyWrongKind
)

// StateOf derives a share's state. targetExists is false for an out-of-band delete.
func StateOf(sh store.Share, now time.Time, targetExists bool) State {
	_, live := sh.Target.LivePath()
	switch {
	case !live:
		return Suspended
	case !targetExists:
		return Missing
	case sh.ExpiresAt != nil && !now.Before(*sh.ExpiresAt):
		return Expired
	case sh.MaxUses != nil && sh.Uses >= *sh.MaxUses:
		return Exhausted
	}
	return Active
}

// Decide is the whole guest policy. A holder of a consumed grant keeps access
// after the share is Exhausted, so a video seek does not die mid-film, and
// AllowAndConsume then spends only on a new item, which the store refuses. A
// drop share allows only Upload and a link share never allows it, so a drop
// guest has no route to a listing.
func Decide(sh store.Share, st State, g *store.Grant, act Act, now time.Time) Decision {
	if (sh.Kind == store.ShareDrop) != (act == Upload) {
		return DenyWrongKind
	}
	if st == Suspended || st == Missing || st == Expired {
		return DenyGone
	}
	live := g != nil && g.ShareID == sh.ID && now.Before(g.ExpiresAt)
	if st == Exhausted && !(live && g.Consumed) {
		return DenyGone
	}
	if !live {
		return DenyNeedsGrant
	}
	if act == Browse {
		return Allow
	}
	return AllowAndConsume
}

func goneError(st State) error {
	switch st {
	case Expired:
		return ErrExpired
	case Exhausted:
		return ErrExhausted
	}
	return ErrUnavailable
}

func lockFor(failures int) time.Duration {
	if failures < freeAttempts {
		return 0
	}
	shift := failures - freeAttempts
	if shift >= 7 {
		return longestLock
	}
	return min(firstLock<<shift, longestLock)
}

type Admission struct {
	Share store.Share
	Grant store.Grant
}

type Shares interface {
	ShareByToken(ctx context.Context, t store.Token) (sh store.Share, targetExists bool, err error)
}

type Service struct {
	db     *store.Store
	shares Shares

	mu       sync.Mutex
	setup    string
	attempts map[string]*attemptLock
}

// New logs a fresh setup code when no owner exists.
func New(ctx context.Context, db *store.Store, shares Shares) (*Service, error) {
	s := &Service{db: db, shares: shares}
	required, err := s.SetupRequired(ctx)
	if err != nil {
		return nil, err
	}
	if required {
		s.setup = newSetupCode()
		slog.Info("setup_code", "code", s.setup)
	}
	return s, nil
}

func newSetupCode() string {
	var b [10]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return base32.StdEncoding.EncodeToString(b[:])
}

func secret() (value string, hash []byte) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	value = base64.RawURLEncoding.EncodeToString(b[:])
	return value, hashSecret(value)
}

func hashSecret(value string) []byte {
	h := sha256.Sum256([]byte(value))
	return h[:]
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func (s *Service) SetupRequired(ctx context.Context) (bool, error) {
	_, ok, err := s.db.OwnerHash(ctx)
	return !ok, err
}

type attemptLock struct {
	mu    sync.Mutex
	users int
}

func (s *Service) lockAttempt(key string) func() {
	s.mu.Lock()
	if s.attempts == nil {
		s.attempts = make(map[string]*attemptLock)
	}
	lock := s.attempts[key]
	if lock == nil {
		lock = &attemptLock{}
		s.attempts[key] = lock
	}
	lock.users++
	s.mu.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		s.mu.Lock()
		lock.users--
		if lock.users == 0 {
			delete(s.attempts, key)
		}
		s.mu.Unlock()
	}
}

func (s *Service) attempt(ctx context.Context, key string, fail error, verify func() (bool, error)) error {
	unlock := s.lockAttempt(key)
	defer unlock()
	st, err := s.db.Limiter(ctx, key)
	if err != nil {
		return err
	}
	now := time.Now()
	if now.Before(st.LockedUntil) {
		return &LockedError{Until: st.LockedUntil}
	}
	ok, err := verify()
	if err != nil {
		return err
	}
	if ok {
		return s.db.ClearLimiter(context.WithoutCancel(ctx), key)
	}
	st.Failures++
	st.LockedUntil = time.Now().Add(lockFor(st.Failures))
	if err := s.db.SetLimiter(context.WithoutCancel(ctx), key, st); err != nil {
		return err
	}
	return fail
}

// Setup claims the server. It compares the code in constant time, goes through
// the limiter, and relies on the owner table's single-row CHECK.
func (s *Service) Setup(ctx context.Context, code, password string, client Client) (Cookie, error) {
	required, err := s.SetupRequired(ctx)
	if err != nil {
		return Cookie{}, err
	}
	if !required {
		return Cookie{}, ErrAlreadySetUp
	}
	err = s.attempt(ctx, setupLimiterKey, ErrBadCode, func() (bool, error) {
		s.mu.Lock()
		want := s.setup
		s.mu.Unlock()
		return want != "" && subtle.ConstantTimeCompare([]byte(code), []byte(want)) == 1, nil
	})
	if err != nil {
		return Cookie{}, err
	}
	if len(password) < MinPasswordBytes {
		return Cookie{}, ErrWeakPassword
	}
	hash, err := HashPassword(ctx, password)
	if err != nil {
		return Cookie{}, err
	}
	if err := s.db.CreateOwner(ctx, hash); err != nil {
		if errors.Is(err, store.ErrExists) {
			return Cookie{}, ErrAlreadySetUp
		}
		return Cookie{}, err
	}
	s.mu.Lock()
	s.setup = ""
	s.mu.Unlock()
	return s.newSession(ctx, client)
}

// Client is the caller's identity as far as the session list shows it.
type Client struct {
	UserAgent string
	IP        string
}

// Cookie is a secret to hand to the browser. api decides the attributes.
type Cookie struct {
	Value   string
	Expires time.Time
}

func (s *Service) newSession(ctx context.Context, c Client) (Cookie, error) {
	value, hash := secret()
	now := time.Now()
	sess := store.Session{
		ID: store.SessionID(newID()), CreatedAt: now, LastSeenAt: now, ExpiresAt: now.Add(SessionTTL),
		UserAgent: c.UserAgent, ClientIP: c.IP,
	}
	if err := s.db.CreateSession(ctx, sess, hash); err != nil {
		return Cookie{}, err
	}
	return Cookie{Value: value, Expires: sess.ExpiresAt}, nil
}

func (s *Service) checkOwnerPassword(ctx context.Context, password string) error {
	return s.attempt(ctx, ownerLimiterKey, ErrBadCredentials, func() (bool, error) {
		hash, ok, err := s.db.OwnerHash(ctx)
		if err != nil || !ok {
			return false, err
		}
		return VerifyPassword(ctx, hash, password)
	})
}

func (s *Service) Login(ctx context.Context, password string, c Client) (Cookie, error) {
	if err := s.checkOwnerPassword(ctx, password); err != nil {
		return Cookie{}, err
	}
	return s.newSession(ctx, c)
}

func (s *Service) Logout(ctx context.Context, cookie string) error {
	return s.db.DeleteSessionByHash(ctx, hashSecret(cookie))
}

// ChangePassword needs the current password and revokes every other session.
func (s *Service) ChangePassword(ctx context.Context, keep store.SessionID, current, next string) error {
	if err := s.checkOwnerPassword(ctx, current); err != nil {
		return err
	}
	if len(next) < MinPasswordBytes {
		return ErrWeakPassword
	}
	hash, err := HashPassword(ctx, next)
	if err != nil {
		return err
	}
	return s.db.ChangePassword(ctx, hash, keep)
}

// Authenticate turns a session cookie into a session or ErrNoSession.
func (s *Service) Authenticate(ctx context.Context, cookie string) (store.Session, error) {
	sess, err := s.db.TouchSession(ctx, hashSecret(cookie), time.Now())
	if errors.Is(err, store.ErrNotFound) {
		return store.Session{}, ErrNoSession
	}
	return sess, err
}

func (s *Service) Sessions(ctx context.Context) ([]store.Session, error) {
	return s.db.ListSessions(ctx)
}

func (s *Service) RevokeSession(ctx context.Context, id store.SessionID) error {
	return s.db.DeleteSession(ctx, id)
}

// Open checks the password through the limiter and mints a grant. It spends no use.
func (s *Service) Open(ctx context.Context, t store.Token, password string) (Cookie, error) {
	sh, exists, err := s.shares.ShareByToken(ctx, t)
	if err != nil {
		return Cookie{}, err
	}
	now := time.Now()
	if st := StateOf(sh, now, exists); st != Active {
		return Cookie{}, goneError(st)
	}
	if sh.PasswordHash != "" {
		err := s.attempt(ctx, "share:"+string(sh.ID), ErrBadCredentials, func() (bool, error) {
			return VerifyPassword(ctx, sh.PasswordHash, password)
		})
		if err != nil {
			return Cookie{}, err
		}
	}
	value, hash := secret()
	g := store.Grant{ID: store.GrantID(newID()), ShareID: sh.ID, ExpiresAt: now.Add(GrantTTL)}
	if err := s.db.CreateGrant(ctx, g, hash); err != nil {
		return Cookie{}, err
	}
	return Cookie{Value: value, Expires: g.ExpiresAt}, nil
}

func (s *Service) grant(ctx context.Context, cookie string) (*store.Grant, error) {
	if cookie == "" {
		return nil, nil
	}
	g, err := s.db.GrantByHash(ctx, hashSecret(cookie))
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// Admit is the only entrance to a share. It loads the share and grant, derives
// the state and applies Decide. Spending waits for Consume, because only the
// handler knows which item was asked for and whether it exists.
func (s *Service) Admit(ctx context.Context, t store.Token, grantCookie string, act Act) (Admission, error) {
	sh, exists, err := s.shares.ShareByToken(ctx, t)
	if err != nil {
		return Admission{}, err
	}
	g, err := s.grant(ctx, grantCookie)
	if err != nil {
		return Admission{}, err
	}
	now := time.Now()
	st := StateOf(sh, now, exists)
	switch Decide(sh, st, g, act, now) {
	case Allow, AllowAndConsume:
		return Admission{Share: sh, Grant: *g}, nil
	case DenyNeedsGrant:
		return Admission{}, ErrNeedsGrant
	case DenyGone:
		return Admission{}, goneError(st)
	}
	return Admission{}, ErrWrongKind
}

// Consume records that the grant fetched an item, taking one use the first time.
func (s *Service) Consume(ctx context.Context, a Admission, item string) error {
	err := s.db.TakeItem(ctx, a.Grant.ID, a.Share.ID, item)
	if errors.Is(err, store.ErrExhausted) {
		return ErrExhausted
	}
	return err
}

// Describe gives the public facts about a link without a grant. A guest holding
// a consumed grant can still reload an Exhausted link it may finish.
func (s *Service) Describe(ctx context.Context, t store.Token, grantCookie string) (store.Share, State, error) {
	sh, exists, err := s.shares.ShareByToken(ctx, t)
	if err != nil {
		return store.Share{}, 0, err
	}
	now := time.Now()
	st := StateOf(sh, now, exists)
	if st == Exhausted {
		g, err := s.grant(ctx, grantCookie)
		if err != nil {
			return store.Share{}, 0, err
		}
		act := Fetch
		if sh.Kind == store.ShareDrop {
			act = Upload
		}
		if Decide(sh, st, g, act, now) == AllowAndConsume {
			return sh, st, nil
		}
	}
	if st != Active {
		return store.Share{}, st, goneError(st)
	}
	return sh, st, nil
}

const (
	argonTime    = 1
	argonMemory  = 46 * 1024
	argonThreads = 1
	argonKeyLen  = 32
)

var hashSlots = make(chan struct{}, 2)

func derive(ctx context.Context, password string, salt []byte, t, m uint32, p uint8, n uint32) ([]byte, error) {
	select {
	case hashSlots <- struct{}{}:
		defer func() { <-hashSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return argon2.IDKey([]byte(password), salt, t, m, p, n), nil
}

// HashPassword uses argon2id behind a two-slot semaphore.
func HashPassword(ctx context.Context, password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := derive(ctx, password, salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	if err != nil {
		return "", err
	}
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// VerifyPassword checks against the parameters stored in the hash, so a future
// change of cost still accepts old hashes.
func VerifyPassword(ctx context.Context, encoded, password string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("unknown password hash format")
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, fmt.Errorf("password hash: %w", err)
	}
	enc := base64.RawStdEncoding
	salt, err := enc.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("password hash: %w", err)
	}
	want, err := enc.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("password hash: %w", err)
	}
	got, err := derive(ctx, password, salt, t, m, p, uint32(len(want)))
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
