PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  title TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  repo TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')
  ),
  request_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  log_path TEXT NOT NULL,
  artifacts_dir TEXT,
  summary_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'user', 'system')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_task_ts ON audit_events(task_id, ts);

CREATE TABLE IF NOT EXISTS repo_memory_index (
  repo TEXT PRIMARY KEY,
  memory_path TEXT NOT NULL,
  updated_at TEXT,
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  is_revoked INTEGER NOT NULL DEFAULT 0 CHECK (is_revoked IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_is_revoked ON api_tokens(is_revoked);

