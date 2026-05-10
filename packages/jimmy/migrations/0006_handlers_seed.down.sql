-- Down: revert default handler row seed.
-- Note: this leaves the table empty even if handlers were modified manually.
-- Also drops the unique index that the up-file created (since 0004 doesn't own it).
DROP INDEX IF EXISTS uniq_event_handlers_kind_processor;
DELETE FROM event_handlers;
