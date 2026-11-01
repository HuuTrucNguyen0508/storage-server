package api

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"storage-server/internal/access"
	"storage-server/internal/store"
)

func clientOf(r *http.Request) access.Client {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	// The sidecar appends the real client, so the last hop is the one it saw.
	// This only labels the owner's own session list.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		ip = strings.TrimSpace(parts[len(parts)-1])
	}
	return access.Client{UserAgent: r.UserAgent(), IP: ip}
}

func (a *API) session(w http.ResponseWriter, r *http.Request, c *call) {
	required, err := a.access.SetupRequired(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	_, err = a.access.Authenticate(r.Context(), cookieValue(r, sessionCookie))
	if err != nil && !errors.Is(err, access.ErrNoSession) {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"setupRequired": required, "authenticated": err == nil})
}

func (a *API) setup(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{ Code, Password string }
	if err := decode(r, &in, false); err != nil {
		a.fail(w, r, err)
		return
	}
	cookie, err := a.access.Setup(r.Context(), in.Code, in.Password, clientOf(r))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.setCookie(w, sessionCookie, "/", cookie, a.secure(a.cfg.PublicURL))
	w.WriteHeader(http.StatusCreated)
}

func (a *API) login(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{ Password string }
	if err := decode(r, &in, false); err != nil {
		a.fail(w, r, err)
		return
	}
	cookie, err := a.access.Login(r.Context(), in.Password, clientOf(r))
	if err != nil {
		if errors.Is(err, access.ErrBadCredentials) {
			a.metrics.LoginFailure()
		}
		a.fail(w, r, err)
		return
	}
	a.setCookie(w, sessionCookie, "/", cookie, a.secure(a.cfg.PublicURL))
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) logout(w http.ResponseWriter, r *http.Request, c *call) {
	if err := a.access.Logout(r.Context(), cookieValue(r, sessionCookie)); err != nil {
		a.fail(w, r, err)
		return
	}
	a.setCookie(w, sessionCookie, "/", access.Cookie{Expires: time.Unix(1, 0)}, a.secure(a.cfg.PublicURL))
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) changePassword(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{ Current, New string }
	if err := decode(r, &in, false); err != nil {
		a.fail(w, r, err)
		return
	}
	if err := a.access.ChangePassword(r.Context(), c.session.ID, in.Current, in.New); err != nil {
		if errors.Is(err, access.ErrBadCredentials) {
			a.metrics.LoginFailure()
		}
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type sessionJSON struct {
	ID         string    `json:"id"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	UserAgent  string    `json:"userAgent"`
	IP         string    `json:"ip"`
	Current    bool      `json:"current"`
}

func (a *API) sessions(w http.ResponseWriter, r *http.Request, c *call) {
	list, err := a.access.Sessions(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := make([]sessionJSON, 0, len(list))
	for _, s := range list {
		out = append(out, sessionJSON{string(s.ID), s.CreatedAt, s.LastSeenAt, s.UserAgent, s.ClientIP, s.ID == c.session.ID})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) revokeSession(w http.ResponseWriter, r *http.Request, c *call) {
	if err := a.access.RevokeSession(r.Context(), store.SessionID(r.PathValue("id"))); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) healthz(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	err := a.db.Ping(ctx)
	if err == nil {
		_, _, err = a.disk.Usage()
	}
	if err == nil && !a.vault.Healthy() {
		err = errors.New("a move is waiting for recovery")
	}
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]string{"code": "unhealthy", "message": err.Error()},
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
