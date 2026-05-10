-- 0002_workspace: queue_items, goals, budget_events, episode_candidates

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_session
  ON queue_items (session_key, status, position);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  level TEXT NOT NULL DEFAULT 'company',
  parent_id TEXT,
  department TEXT,
  owner TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES goals(id)
);

CREATE TABLE IF NOT EXISTS budget_events (
  id TEXT PRIMARY KEY,
  employee TEXT NOT NULL,
  event_type TEXT NOT NULL,
  amount REAL NOT NULL,
  limit_amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episode_candidates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  employee TEXT,
  trigger_type TEXT,
  trigger_ref TEXT,
  cost_usd REAL,
  num_turns INTEGER,
  num_children INTEGER,
  prompt_excerpt TEXT,
  result_excerpt TEXT,
  promoted_episode_id TEXT,
  promoted_at TEXT,
  rejected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ec_pending
  ON episode_candidates (created_at)
  WHERE promoted_at IS NULL AND rejected_at IS NULL;
