PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  repo TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'blocked')
  ),
  request_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  log_path TEXT NOT NULL,
  artifacts_dir TEXT,
  summary_text TEXT
);

INSERT INTO tasks_new (
  id,
  session_id,
  repo,
  agent,
  status,
  request_text,
  created_at,
  started_at,
  finished_at,
  exit_code,
  log_path,
  artifacts_dir,
  summary_text
)
SELECT
  id,
  session_id,
  repo,
  agent,
  status,
  request_text,
  created_at,
  started_at,
  finished_at,
  exit_code,
  log_path,
  artifacts_dir,
  summary_text
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

COMMIT;

PRAGMA foreign_keys = ON;

