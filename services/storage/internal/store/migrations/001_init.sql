-- pg_trgm is a trusted extension, so the database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE settings (
    key   text PRIMARY KEY,
    value bytea NOT NULL
);

CREATE TABLE users (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username     text NOT NULL UNIQUE CHECK (username = lower(username) AND username <> ''),
    email        text NOT NULL DEFAULT '',
    display_name text NOT NULL DEFAULT '',
    is_admin     boolean NOT NULL DEFAULT false,
    placeholder  boolean NOT NULL DEFAULT false,
    quota_bytes  bigint NOT NULL CHECK (quota_bytes >= 0),
    root_id      uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz
);

-- A blob is one immutable file on the storage-data volume, named by id.
-- Copies of a file share its blob; unreferenced blobs are garbage-collected.
CREATE TABLE blobs (
    id         text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
    size       bigint NOT NULL CHECK (size >= 0),
    sha256     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nodes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    parent_id   uuid REFERENCES nodes (id) ON DELETE CASCADE,
    is_dir      boolean NOT NULL,
    name        text NOT NULL,
    size        bigint NOT NULL DEFAULT 0 CHECK (size >= 0),
    blob_id     text REFERENCES blobs (id),
    created_by  bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    modified_at timestamptz NOT NULL DEFAULT now(),
    -- trashed_at is set on the trashed node and every node below it;
    -- trash_root is the node the user trashed, so restore can undo exactly that.
    trashed_at  timestamptz,
    trash_root  uuid,
    CHECK (is_dir = (blob_id IS NULL)),
    CHECK ((parent_id IS NULL) = (name = '')),
    CHECK ((trashed_at IS NULL) = (trash_root IS NULL))
);

CREATE UNIQUE INDEX nodes_one_root ON nodes (owner_id) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX nodes_live_name ON nodes (parent_id, lower(name)) WHERE trashed_at IS NULL AND parent_id IS NOT NULL;
CREATE INDEX nodes_parent ON nodes (parent_id);
CREATE INDEX nodes_owner ON nodes (owner_id);
CREATE INDEX nodes_blob ON nodes (blob_id) WHERE blob_id IS NOT NULL;
CREATE INDEX nodes_trash_root ON nodes (trash_root) WHERE trash_root IS NOT NULL;
CREATE INDEX nodes_recent ON nodes (owner_id, modified_at DESC) WHERE trashed_at IS NULL AND NOT is_dir;
CREATE INDEX nodes_name_trgm ON nodes USING gin (lower(name) gin_trgm_ops);

ALTER TABLE users ADD CONSTRAINT users_root_fk FOREIGN KEY (root_id) REFERENCES nodes (id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE stars (
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id    uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, node_id)
);
CREATE INDEX stars_node ON stars (node_id);

CREATE TABLE shares (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id    uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    grantee_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    permission text NOT NULL CHECK (permission IN ('read', 'edit')),
    created_by bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (node_id, grantee_id)
);
CREATE INDEX shares_grantee ON shares (grantee_id);

CREATE TABLE links (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id        uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    created_by     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind           text NOT NULL CHECK (kind IN ('view', 'drop')),
    token_hash     bytea NOT NULL UNIQUE,
    password_hash  text,
    expires_at     timestamptz,
    max_downloads  integer CHECK (max_downloads > 0),
    download_count integer NOT NULL DEFAULT 0,
    revoked_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_used_at   timestamptz
);
CREATE INDEX links_node ON links (node_id);

CREATE TABLE upload_sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    uploader_id bigint REFERENCES users (id) ON DELETE CASCADE,
    link_id     uuid REFERENCES links (id) ON DELETE CASCADE,
    parent_id   uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    rel_dirs    text[] NOT NULL DEFAULT '{}',
    name        text NOT NULL,
    size        bigint NOT NULL CHECK (size >= 0),
    received    bigint NOT NULL DEFAULT 0 CHECK (received >= 0 AND received <= size),
    hash_state  bytea,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK ((uploader_id IS NULL) <> (link_id IS NULL))
);
CREATE INDEX upload_sessions_owner ON upload_sessions (owner_id);

CREATE TABLE activity (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id    uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    actor_id   bigint REFERENCES users (id) ON DELETE SET NULL,
    actor      text NOT NULL,
    action     text NOT NULL,
    detail     text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_node ON activity (node_id, created_at DESC);
