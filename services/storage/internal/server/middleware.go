package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/HuuTrucNguyen0508/storage-server/services/storage/internal/telemetry"
)

type ctxKey int

const (
	reqInfoKey ctxKey = iota
	userCtxKey
)

// reqInfo collects what inner handlers learn about a request, for the
// outer telemetry middleware.
type reqInfo struct {
	route string
	user  string
}

func info(ctx context.Context) *reqInfo {
	if ri, ok := ctx.Value(reqInfoKey).(*reqInfo); ok {
		return ri
	}
	return &reqInfo{}
}

// routed records the matched route template of a ServeMux.
func routed(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r)
		if r.Pattern != "" {
			p := r.Pattern
			if i := strings.IndexByte(p, ' '); i >= 0 {
				p = p[i+1:]
			}
			info(r.Context()).route = p
		}
	})
}

// RedactPath replaces the share token in public paths with {token}.
func RedactPath(p string) string {
	for _, prefix := range []string{"/s/", "/api/public/"} {
		if rest, ok := strings.CutPrefix(p, prefix); ok {
			if i := strings.IndexByte(rest, '/'); i >= 0 {
				return prefix + "{token}" + rest[i:]
			}
			return prefix + "{token}"
		}
	}
	return p
}

// statusWriter remembers the status code and counts body bytes.
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := w.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("hijack not supported")
}

// observe is the outermost middleware: tracing, metrics, access logs and
// panic recovery. Span attributes and log lines carry the route template and
// a redacted path, never a share token.
func (s *Server) observe(next http.Handler) http.Handler {
	tracer := otel.Tracer("storage/http")
	prop := otel.GetTextMapPropagator()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ri := &reqInfo{}
		ctx := context.WithValue(prop.Extract(r.Context(), propagation.HeaderCarrier(r.Header)), reqInfoKey, ri)
		// Kubelet probes every few seconds would drown the real traces.
		probe := r.URL.Path == "/healthz" || r.URL.Path == "/readyz"
		var span trace.Span
		startOpts := []trace.SpanStartOption{trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(
			attribute.String("http.request.method", r.Method),
			attribute.String("url.path", RedactPath(r.URL.Path)),
			attribute.String("url.scheme", "http"),
			attribute.String("user_agent.original", r.UserAgent()),
		)}
		if probe {
			span = trace.SpanFromContext(ctx) // a no-op span: nothing recorded
		} else {
			ctx, span = tracer.Start(ctx, r.Method, startOpts...)
		}
		s.m.ActiveRequests.Inc()
		sw := &statusWriter{ResponseWriter: w}
		defer func() {
			abort := false
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					abort = true
					sw.status = 499
				} else {
					s.log.ErrorContext(ctx, "panic", "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
					if sw.status == 0 {
						writeError(sw, http.StatusInternalServerError, "internal", "internal error")
					}
					sw.status = http.StatusInternalServerError
				}
			}
			s.m.ActiveRequests.Dec()
			status := sw.status
			if status == 0 {
				status = http.StatusOK
			}
			route := ri.route
			if route == "" {
				route = "unmatched"
			}
			span.SetName(r.Method + " " + route)
			span.SetAttributes(attribute.String("http.route", route), attribute.Int("http.response.status_code", status))
			if status >= 500 {
				span.SetStatus(codes.Error, http.StatusText(status))
			}
			if ri.user != "" {
				span.SetAttributes(attribute.String("enduser.id", ri.user))
			}
			span.End()
			dur := time.Since(start)
			obs := s.m.RequestDuration.WithLabelValues(r.Method, route, fmt.Sprint(status))
			if sc := span.SpanContext(); sc.IsSampled() {
				obs.(prometheus.ExemplarObserver).ObserveWithExemplar(dur.Seconds(), prometheus.Labels{"trace_id": sc.TraceID().String()})
			} else {
				obs.Observe(dur.Seconds())
			}
			level := slog.LevelInfo
			if route == "/healthz" || route == "/readyz" {
				level = slog.LevelDebug
			}
			lctx := ctx
			if ri.user != "" {
				lctx = telemetry.WithUser(ctx, ri.user)
			}
			s.log.LogAttrs(lctx, level, "request",
				slog.String("method", r.Method), slog.String("route", route), slog.String("path", RedactPath(r.URL.Path)),
				slog.Int("status", status), slog.Float64("duration_ms", float64(dur.Microseconds())/1000), slog.Int64("bytes", sw.bytes))
			if abort {
				panic(http.ErrAbortHandler) // let net/http drop the connection
			}
		}()
		next.ServeHTTP(sw, r.WithContext(ctx))
	})
}

// baseHeaders applies to every response from the app port.
func baseHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		if strings.HasPrefix(r.URL.Path, "/s/") || strings.HasPrefix(r.URL.Path, "/api/public/") {
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("X-Robots-Tag", "noindex, nofollow")
		} else {
			h.Set("Referrer-Policy", "same-origin")
		}
		next.ServeHTTP(w, r)
	})
}

// forgery enforces the contract's request-forgery rules on every mutating
// request, public or private.
func (s *Server) forgery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			next.ServeHTTP(w, r)
			return
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		default:
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
			return
		}
		refuse := func(reason, msg string) {
			s.m.ForgeryRefused.WithLabelValues(reason).Inc()
			writeError(w, http.StatusForbidden, "forbidden_request", msg)
		}
		if r.Header.Get("X-Requested-With") != "fetch" {
			refuse("header", "missing X-Requested-With: fetch")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != s.cfg.Origin() {
			refuse("origin", "cross-origin request refused")
			return
		}
		if r.ContentLength != 0 {
			mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			ok := err == nil && (mt == "application/json" || mt == "multipart/form-data" ||
				(mt == "application/octet-stream" && r.Method == http.MethodPut && isUploadChunkPath(r.URL.Path)))
			if !ok {
				refuse("content_type", "unsupported Content-Type for a state-changing request")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func isUploadChunkPath(p string) bool {
	return strings.HasPrefix(p, "/api/uploads/") || (strings.HasPrefix(p, "/api/public/") && strings.Contains(p, "/uploads/"))
}

// noStore marks identity- or capability-dependent responses as uncacheable.
func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
}

// clientIP is the address Traefik saw. Traefik's entry points do not trust
// client-sent forwarding headers, so X-Real-Ip is its own observation.
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-Ip"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
