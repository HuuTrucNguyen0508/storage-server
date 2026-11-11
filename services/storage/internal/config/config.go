// Package config reads the service configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const GiB = int64(1) << 30

// Config is the whole runtime configuration. Every field comes from one
// environment variable, documented in README.md.
type Config struct {
	ListenAddr  string // LISTEN_ADDR, default ":8080"
	MetricsAddr string // METRICS_ADDR, default ":9464"
	DatabaseURL string // DATABASE_URL, required
	DataDir     string // DATA_DIR, default "/data"
	BackupDir   string // BACKUP_DIR, empty disables dump-aware quarantine retention

	PublicURL     string // PUBLIC_URL, the app's own origin, e.g. https://storage.lab.localhost
	Domain        string // DOMAIN, used for the top bar's app links
	AuthPublicURL string // AUTH_PUBLIC_URL
	HomeURL       string // HOME_URL

	AuthMode   string // AUTH_MODE: header (default) or dev
	AppEnv     string // APP_ENV
	DevUser    string // DEV_USER
	DevGroups  string // DEV_GROUPS
	AdminGroup string // ADMIN_GROUP, default "admins"
	UserGroup  string // USER_GROUP, default "users"

	DefaultQuota   int64         // DEFAULT_QUOTA_BYTES, default 50 GiB
	MaxFileSize    int64         // MAX_FILE_BYTES, default 256 GiB
	MaxChunkSize   int64         // MAX_CHUNK_BYTES, default 256 MiB
	MinFreePercent float64       // MIN_FREE_PERCENT, default 5
	TrashRetention time.Duration // TRASH_RETENTION, default 720h
	UploadTTL      time.Duration // UPLOAD_SESSION_TTL, default 24h
	TextPreviewCap int64         // TEXT_PREVIEW_BYTES, default 1 MiB

	// QuarantineRetention is the minimum time removed blobs stay restorable.
	// With BackupDir set, blobs also stay until older than the oldest kept dump.
	QuarantineRetention time.Duration // BLOB_QUARANTINE_RETENTION, default 192h

	StirlingURL       string        // STIRLING_URL
	OfficeConcurrency int           // OFFICE_CONCURRENCY, default 2
	OfficeTimeout     time.Duration // OFFICE_TIMEOUT, default 120s
	OfficeMaxBytes    int64         // OFFICE_MAX_BYTES, default 100 MiB

	ShutdownTimeout time.Duration // SHUTDOWN_TIMEOUT, default 30s
}

// Load reads and validates the configuration.
func Load() (Config, error) {
	c := Config{
		ListenAddr:    env("LISTEN_ADDR", ":8080"),
		MetricsAddr:   env("METRICS_ADDR", ":9464"),
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		DataDir:       env("DATA_DIR", "/data"),
		BackupDir:     os.Getenv("BACKUP_DIR"),
		PublicURL:     strings.TrimRight(os.Getenv("PUBLIC_URL"), "/"),
		Domain:        os.Getenv("DOMAIN"),
		AuthPublicURL: strings.TrimRight(os.Getenv("AUTH_PUBLIC_URL"), "/"),
		HomeURL:       os.Getenv("HOME_URL"),
		AuthMode:      env("AUTH_MODE", "header"),
		AppEnv:        env("APP_ENV", "production"),
		DevUser:       os.Getenv("DEV_USER"),
		DevGroups:     env("DEV_GROUPS", "users"),
		AdminGroup:    env("ADMIN_GROUP", "admins"),
		UserGroup:     env("USER_GROUP", "users"),
		StirlingURL:   strings.TrimRight(os.Getenv("STIRLING_URL"), "/"),
	}
	var errs []error
	num := func(name string, def int64) int64 {
		v, err := envInt(name, def)
		if err != nil {
			errs = append(errs, err)
		}
		return v
	}
	dur := func(name string, def time.Duration) time.Duration {
		v, err := envDuration(name, def)
		if err != nil {
			errs = append(errs, err)
		}
		return v
	}
	c.DefaultQuota = num("DEFAULT_QUOTA_BYTES", 50*GiB)
	c.MaxFileSize = num("MAX_FILE_BYTES", 256*GiB)
	c.MaxChunkSize = num("MAX_CHUNK_BYTES", 256<<20)
	c.TextPreviewCap = num("TEXT_PREVIEW_BYTES", 1<<20)
	c.OfficeConcurrency = int(num("OFFICE_CONCURRENCY", 2))
	c.OfficeMaxBytes = num("OFFICE_MAX_BYTES", 100<<20)
	c.TrashRetention = dur("TRASH_RETENTION", 30*24*time.Hour)
	c.UploadTTL = dur("UPLOAD_SESSION_TTL", 24*time.Hour)
	c.QuarantineRetention = dur("BLOB_QUARANTINE_RETENTION", 8*24*time.Hour)
	c.OfficeTimeout = dur("OFFICE_TIMEOUT", 120*time.Second)
	c.ShutdownTimeout = dur("SHUTDOWN_TIMEOUT", 30*time.Second)
	mf, err := strconv.ParseFloat(env("MIN_FREE_PERCENT", "5"), 64)
	if err != nil || mf < 0 || mf >= 100 {
		errs = append(errs, fmt.Errorf("MIN_FREE_PERCENT: want a number in [0,100)"))
	}
	c.MinFreePercent = mf

	if c.Domain != "" {
		if c.PublicURL == "" {
			c.PublicURL = "https://storage." + c.Domain
		}
		if c.AuthPublicURL == "" {
			c.AuthPublicURL = "https://auth." + c.Domain
		}
		if c.HomeURL == "" {
			c.HomeURL = "https://home." + c.Domain + "/"
		}
	}
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}
	if c.PublicURL == "" {
		errs = append(errs, errors.New("PUBLIC_URL (or DOMAIN) is required"))
	} else if u, err := url.Parse(c.PublicURL); err != nil || u.Scheme == "" || u.Host == "" || u.Path != "" {
		errs = append(errs, errors.New("PUBLIC_URL must be an origin such as https://storage.example.com"))
	}
	switch c.AuthMode {
	case "header":
	case "dev":
		if c.AppEnv != "development" {
			errs = append(errs, errors.New("AUTH_MODE=dev is refused unless APP_ENV=development"))
		}
		if c.DevUser == "" {
			errs = append(errs, errors.New("AUTH_MODE=dev needs DEV_USER"))
		}
	default:
		errs = append(errs, fmt.Errorf("AUTH_MODE must be header or dev, got %q", c.AuthMode))
	}
	if c.OfficeConcurrency < 1 {
		c.OfficeConcurrency = 1
	}
	return c, errors.Join(errs...)
}

// Origin is the exact value a same-origin browser sends in the Origin header.
func (c Config) Origin() string { return c.PublicURL }

// SecureCookies reports whether cookies get the Secure attribute.
func (c Config) SecureCookies() bool { return strings.HasPrefix(c.PublicURL, "https://") }

func env(name, def string) string {
	if v, ok := os.LookupEnv(name); ok && v != "" {
		return v
	}
	return def
}

func envInt(name string, def int64) (int64, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return def, fmt.Errorf("%s: want a non-negative integer, got %q", name, v)
	}
	return n, nil
}

func envDuration(name string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return def, fmt.Errorf("%s: want a positive Go duration such as 24h, got %q", name, v)
	}
	return d, nil
}
