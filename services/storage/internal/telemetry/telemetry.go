// Package telemetry sets up JSON logs, Prometheus metrics and OpenTelemetry
// tracing with the names the platform contract requires.
package telemetry

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const Service = "storage"

// ---- logs ----

type ctxKey int

const userKey ctxKey = iota

// WithUser stores the signed-in username for log lines.
func WithUser(ctx context.Context, user string) context.Context {
	return context.WithValue(ctx, userKey, user)
}

type ctxHandler struct{ slog.Handler }

func (h ctxHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	if u, ok := ctx.Value(userKey).(string); ok && u != "" {
		r.AddAttrs(slog.String("user", u))
	}
	return h.Handler.Handle(ctx, r)
}

func (h ctxHandler) WithAttrs(a []slog.Attr) slog.Handler { return ctxHandler{h.Handler.WithAttrs(a)} }
func (h ctxHandler) WithGroup(n string) slog.Handler      { return ctxHandler{h.Handler.WithGroup(n)} }

// NewLogger writes one JSON object per line with the contract's keys.
func NewLogger(w io.Writer, level slog.Level) *slog.Logger {
	if w == nil {
		w = os.Stdout
	}
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) == 0 && a.Key == slog.LevelKey {
				return slog.String("level", strings.ToLower(a.Value.Any().(slog.Level).String()))
			}
			return a
		},
	})
	return slog.New(ctxHandler{h}).With("service", Service)
}

// ---- metrics ----

// Metrics are every Prometheus metric the app exports (see METRICS.md).
type Metrics struct {
	Registry        *prometheus.Registry
	RequestDuration *prometheus.HistogramVec
	ActiveRequests  prometheus.Gauge
	UploadBytes     prometheus.Counter
	DownloadBytes   *prometheus.CounterVec
	Uploads         *prometheus.CounterVec
	Files           prometheus.Gauge
	UsedBytes       prometheus.Gauge
	SharesActive    *prometheus.GaugeVec
	VolumeFree      prometheus.Gauge
	VolumeTotal     prometheus.Gauge
	PreviewRequests *prometheus.CounterVec
	ThumbDuration   prometheus.Histogram
	OfficeConvert   *prometheus.CounterVec
	OfficeDuration  prometheus.Histogram
	LinkUnlocks     *prometheus.CounterVec
	ForgeryRefused  *prometheus.CounterVec
	Purged          *prometheus.CounterVec
}

// NewMetrics registers every metric on a fresh registry.
func NewMetrics() *Metrics {
	r := prometheus.NewRegistry()
	r.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	f := func(c prometheus.Collector) { r.MustRegister(c) }
	m := &Metrics{Registry: r}
	m.RequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_server_request_duration_seconds",
		Help:    "Duration of HTTP requests by route template.",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60},
	}, []string{"method", "route", "status_code"})
	f(m.RequestDuration)
	m.ActiveRequests = prometheus.NewGauge(prometheus.GaugeOpts{Name: "http_server_active_requests", Help: "HTTP requests in flight."})
	f(m.ActiveRequests)
	m.UploadBytes = prometheus.NewCounter(prometheus.CounterOpts{Name: "storage_upload_bytes_total", Help: "Bytes received in upload chunks."})
	f(m.UploadBytes)
	m.DownloadBytes = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "storage_download_bytes_total", Help: "File bytes sent, by kind."}, []string{"kind"})
	f(m.DownloadBytes)
	for _, k := range []string{"download", "preview", "public"} {
		m.DownloadBytes.WithLabelValues(k)
	}
	m.Uploads = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "storage_uploads_total", Help: "Finished or refused uploads, by result."}, []string{"result"})
	f(m.Uploads)
	for _, k := range []string{"ok", "error", "quota", "too_large"} {
		m.Uploads.WithLabelValues(k)
	}
	m.Files = prometheus.NewGauge(prometheus.GaugeOpts{Name: "storage_files", Help: "Files stored, all users, including trash."})
	f(m.Files)
	m.UsedBytes = prometheus.NewGauge(prometheus.GaugeOpts{Name: "storage_used_bytes", Help: "Logical bytes stored, all users, including trash."})
	f(m.UsedBytes)
	m.SharesActive = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "storage_shares_active", Help: "Active shares by type."}, []string{"type"})
	f(m.SharesActive)
	m.VolumeFree = prometheus.NewGauge(prometheus.GaugeOpts{Name: "storage_volume_free_bytes", Help: "Free bytes on the storage-data volume."})
	f(m.VolumeFree)
	m.VolumeTotal = prometheus.NewGauge(prometheus.GaugeOpts{Name: "storage_volume_size_bytes", Help: "Total bytes of the storage-data volume."})
	f(m.VolumeTotal)
	m.PreviewRequests = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "storage_preview_requests_total", Help: "Viewer content requests, by file kind."}, []string{"kind"})
	f(m.PreviewRequests)
	for _, k := range []string{"image", "video", "audio", "pdf", "text", "markdown", "office", "other"} {
		m.PreviewRequests.WithLabelValues(k)
	}
	m.ThumbDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "storage_thumbnail_duration_seconds", Help: "Time to generate a thumbnail (cache misses only).",
		Buckets: []float64{0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
	})
	f(m.ThumbDuration)
	m.OfficeConvert = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "storage_office_conversions_total", Help: "Office-to-PDF conversions through Stirling PDF, by result."}, []string{"result"})
	f(m.OfficeConvert)
	for _, k := range []string{"ok", "error", "timeout", "cached", "busy"} {
		m.OfficeConvert.WithLabelValues(k)
	}
	m.OfficeDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "storage_office_conversion_duration_seconds", Help: "Time Stirling PDF took to convert a document.",
		Buckets: []float64{0.5, 1, 2.5, 5, 10, 20, 30, 60, 120},
	})
	f(m.OfficeDuration)
	m.LinkUnlocks = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "storage_link_unlock_attempts_total", Help: "Public link password attempts, by result."}, []string{"result"})
	f(m.LinkUnlocks)
	for _, k := range []string{"ok", "wrong", "limited"} {
		m.LinkUnlocks.WithLabelValues(k)
	}
	m.ForgeryRefused = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "storage_forgery_refused_total", Help: "Mutating requests refused by the request-forgery rules, by reason."}, []string{"reason"})
	f(m.ForgeryRefused)
	m.Purged = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "storage_purged_total", Help: "Items removed by background cleanup, by kind."}, []string{"kind"})
	f(m.Purged)
	for _, k := range []string{"trash", "upload", "blob"} {
		m.Purged.WithLabelValues(k)
	}
	return m
}

// ---- traces ----

// InitTracing installs a tracer provider. With OTEL_EXPORTER_OTLP_ENDPOINT
// set, spans go there over OTLP/HTTP; without it, spans are still created
// (so logs carry trace ids) but not exported.
func InitTracing(ctx context.Context) (func(context.Context) error, error) {
	// Later detectors win, so OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
	// override the default service name.
	res, err := resource.New(ctx, resource.WithAttributes(attribute.String("service.name", Service)),
		resource.WithTelemetrySDK(), resource.WithFromEnv())
	if err != nil {
		return nil, err
	}
	opts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != "" {
		exp, err := otlptracehttp.New(ctx)
		if err != nil {
			return nil, err
		}
		opts = append(opts, sdktrace.WithBatcher(exp))
	}
	tp := sdktrace.NewTracerProvider(opts...)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	return tp.Shutdown, nil
}
