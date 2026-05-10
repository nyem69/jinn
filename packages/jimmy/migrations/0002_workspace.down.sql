-- Down: drop workspace tables
DROP INDEX IF EXISTS idx_ec_pending;
DROP TABLE IF EXISTS episode_candidates;
DROP TABLE IF EXISTS budget_events;
DROP TABLE IF EXISTS goals;
DROP INDEX IF EXISTS idx_queue_session;
DROP TABLE IF EXISTS queue_items;
