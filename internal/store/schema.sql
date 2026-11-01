-- Times are Unix seconds. Secrets that a client presents are stored as SHA-256.

CREATE TABLE owner (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  token_hash   BLOB    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT    NOT NULL,
  client_ip    TEXT    NOT NULL
) STRICT;

CREATE TABLE shares (
  id            TEXT    PRIMARY KEY,
  token         TEXT    NOT NULL UNIQUE,
  kind          TEXT    NOT NULL CHECK (kind IN ('link', 'drop')),
  target        TEXT    NOT NULL,
  password_hash TEXT,
  expires_at    INTEGER,
  max_uses      INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses          INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  created_at    INTEGER NOT NULL,
  CHECK (max_uses IS NULL OR uses <= max_uses)
) STRICT;

CREATE TABLE grants (
  id         TEXT    PRIMARY KEY,
  token_hash BLOB    NOT NULL UNIQUE,
  share_id   TEXT    NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX grants_by_share ON grants (share_id);

CREATE TABLE grant_items (
  grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  item     TEXT NOT NULL,
  PRIMARY KEY (grant_id, item)
) STRICT, WITHOUT ROWID;

CREATE TABLE pending_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_loc   TEXT    NOT NULL,
  to_loc     TEXT    NOT NULL,
  src_inode  INTEGER NOT NULL, -- never st_dev: btrfs assigns it at mount
  src_handle TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL
) STRICT;

CREATE TABLE limiter (
  key          TEXT    PRIMARY KEY,
  failures     INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
) STRICT;

PRAGMA user_version = 1;
