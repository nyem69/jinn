-- 0006_handlers_seed: T1A.PR2.D — default event handler rows.
-- Mirrors initHandlerRegistry() in src/events/handlers.ts: seven (kind, processor) pairs
-- in the order DEFAULT_HANDLERS exports them. The unique index is what lets the
-- runtime's `INSERT OR IGNORE` dedupe across boots; without it the seed would double up.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_event_handlers_kind_processor
  ON event_handlers (kind_filter, processor);

INSERT OR IGNORE INTO event_handlers (kind_filter, processor, status) VALUES
  ('subagent_completed',      'performance_archive', 'active'),
  ('subagent_completed',      'episode_capture',     'active'),
  ('session_completed',       'cost_log',            'active'),
  ('session_completed',       'report_archive',      'active'),
  ('subagent_completed',      'kg_extraction',       'active'),
  ('subagent_completed',      'watchpoint_extract',  'active'),
  ('dlq_threshold_exceeded',  'dlq_alert',           'active');
