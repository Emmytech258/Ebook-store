ALTER TABLE sessions ADD COLUMN pending_totp TEXT;
ALTER TABLE sessions ADD COLUMN pending_totp_expires INTEGER;
CREATE TABLE IF NOT EXISTS author_recovery_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO settings(key,value) VALUES('author_totp',''),('mfa_last_counter','-1');
DELETE FROM sessions;
