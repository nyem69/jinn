-- 0005_checkpoints: T1A.PR5 — frozen COO state captured before each delegation

CREATE TABLE IF NOT EXISTS session_checkpoints (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  step_seq     INTEGER NOT NULL,
  branch       TEXT NOT NULL DEFAULT 'main',
  state        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, branch, step_seq)
);

CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session ON session_checkpoints(session_id, step_seq);
CREATE INDEX IF NOT EXISTS idx_session_checkpoints_branch ON session_checkpoints(session_id, branch, step_seq);
