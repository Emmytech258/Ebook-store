ALTER TABLE orders ADD COLUMN meta_user_data TEXT;
CREATE TABLE IF NOT EXISTS meta_events ( id TEXT PRIMARY KEY, pixel_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lock_at INTEGER NOT NULL DEFAULT 0, sent_at INTEGER, error TEXT );
CREATE INDEX IF NOT EXISTS meta_events_pending_idx ON meta_events(sent_at,next_attempt_at);
CREATE INDEX IF NOT EXISTS meta_events_created_idx ON meta_events(created_at);
INSERT OR IGNORE INTO settings(key,value) VALUES('meta_enabled','0'),('meta_access_token',''),('meta_test_code',''),('typography','classic');
