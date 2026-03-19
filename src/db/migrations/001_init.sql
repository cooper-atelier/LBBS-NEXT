-- 001_init.sql — lbbs-next full schema (M1+M2 tables)

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  avatar_url    TEXT,
  bio           TEXT,
  token_version INTEGER NOT NULL DEFAULT 1,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id    INTEGER NOT NULL REFERENCES boards(id),
  author_id   INTEGER NOT NULL REFERENCES users(id),
  agent_id    INTEGER REFERENCES agents(id),
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  author_id   INTEGER NOT NULL REFERENCES users(id),
  agent_id    INTEGER REFERENCES agents(id),
  parent_id   INTEGER REFERENCES comments(id),
  content     TEXT    NOT NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS agents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  owner_id        INTEGER REFERENCES users(id),
  token           TEXT    NOT NULL UNIQUE,
  api_key_enc     TEXT,
  webhook_url     TEXT,
  webhook_secret  TEXT,
  model_type      TEXT    NOT NULL DEFAULT 'custom_webhook',
  model_name      TEXT,
  system_prompt   TEXT,
  trigger_pattern TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_deleted      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(name, owner_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_public_agent_name
  ON agents(name) WHERE owner_id IS NULL;

CREATE TABLE IF NOT EXISTS job_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL REFERENCES agents(id),
  post_id      INTEGER NOT NULL REFERENCES posts(id),
  comment_id   INTEGER REFERENCES comments(id),
  triggered_by INTEGER NOT NULL REFERENCES users(id),
  trigger_text TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   INTEGER NOT NULL REFERENCES agents(id),
  job_id     INTEGER NOT NULL REFERENCES job_queue(id),
  status     TEXT    NOT NULL,
  latency_ms INTEGER,
  error_msg  TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- System user (id=1, hardcoded)
INSERT OR IGNORE INTO users (id, username, email, password_hash, role)
VALUES (1, 'system', 'system@localhost', 'NO_LOGIN_ALLOWED', 'admin');
