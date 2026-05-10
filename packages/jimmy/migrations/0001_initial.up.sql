-- 0001_initial: pre-T1A baseline (sessions, messages, files)

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  status TEXT DEFAULT 'idle',
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  last_error TEXT,
  employee TEXT,
  model TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, timestamp);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mimetype TEXT,
  path TEXT,
  created_at TEXT NOT NULL
);
