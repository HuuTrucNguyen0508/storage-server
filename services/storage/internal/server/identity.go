package server

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/store"
)

// userCache remembers upserted users briefly so every request does not
// write to the database.
type userCache struct {
	mu sync.Mutex
	m  map[store.Identity]cachedUser
}

type cachedUser struct {
	u       *store.User
	expires time.Time
}

const userCacheTTL = time.Minute

func (c *userCache) get(id store.Identity) *store.User {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[id]; ok && time.Now().Before(e.expires) {
		return e.u
	}
	return nil
}

func (c *userCache) put(id store.Identity, u *store.User) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil || len(c.m) > 10000 {
		c.m = map[store.Identity]cachedUser{}
	}
	c.m[id] = cachedUser{u: u, expires: time.Now().Add(userCacheTTL)}
}

// forget drops cached rows (quota changes take effect immediately).
func (c *userCache) forget() {
	c.mu.Lock()
	c.m = nil
	c.mu.Unlock()
}

// identify reads the identity the SSO proxy put in Remote-* headers (or the
// dev user), refuses requests without one, and loads the user's row.
func (s *Server) identify(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw, email, name, groups string
		if s.cfg.AuthMode == "dev" {
			raw, groups = s.cfg.DevUser, s.cfg.DevGroups
		} else {
			raw = r.Header.Get("Remote-User")
			email, name, groups = r.Header.Get("Remote-Email"), r.Header.Get("Remote-Name"), r.Header.Get("Remote-Groups")
		}
		if raw == "" {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in first")
			return
		}
		username, ok := store.NormalizeUsername(raw)
		if !ok {
			writeError(w, http.StatusForbidden, "forbidden", "unsupported username")
			return
		}
		isAdmin, isUser := false, false
		for _, g := range strings.Split(groups, ",") {
			switch strings.TrimSpace(g) {
			case s.cfg.AdminGroup:
				isAdmin = true
			case s.cfg.UserGroup:
				isUser = true
			}
		}
		if !isAdmin && !isUser {
			writeError(w, http.StatusForbidden, "forbidden", "your account is not in the users group")
			return
		}
		id := store.Identity{Username: username, Email: email, Name: name, Admin: isAdmin}
		u := s.users.get(id)
		if u == nil {
			var err error
			u, err = s.store.UpsertUser(r.Context(), id)
			if err != nil {
				s.fail(w, r, err)
				return
			}
			s.users.put(id, u)
		}
		info(r.Context()).user = u.Username
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, u)))
	})
}

// user returns the signed-in user. Only private handlers call it.
func user(r *http.Request) *store.User {
	return r.Context().Value(userCtxKey).(*store.User)
}

func userSubject(r *http.Request) store.Subject { return store.Subject{User: user(r)} }

// limiter counts failures in fixed windows per key.
type limiter struct {
	mu sync.Mutex
	m  map[string]*window
}

type window struct {
	start time.Time
	n     int
}

func newLimiter() *limiter { return &limiter{m: map[string]*window{}} }

// blocked reports whether key has used max failures in the last period.
func (l *limiter) blocked(key string, max int, period time.Duration) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.m[key]
	if !ok || time.Since(w.start) > period {
		return false, 0
	}
	if w.n >= max {
		return true, period - time.Since(w.start)
	}
	return false, 0
}

// fail records one failure for key.
func (l *limiter) fail(key string, period time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.m) > 100000 {
		for k, w := range l.m {
			if time.Since(w.start) > period {
				delete(l.m, k)
			}
		}
	}
	w, ok := l.m[key]
	if !ok || time.Since(w.start) > period {
		l.m[key] = &window{start: time.Now(), n: 1}
		return
	}
	w.n++
}
