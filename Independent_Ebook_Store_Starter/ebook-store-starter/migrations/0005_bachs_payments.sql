ALTER TABLE orders ADD COLUMN provider TEXT NOT NULL DEFAULT 'flutterwave' CHECK(provider IN ('flutterwave','bachs'));
ALTER TABLE orders ADD COLUMN provider_session TEXT;
CREATE UNIQUE INDEX orders_provider_session_idx ON orders(provider,provider_session) WHERE provider_session IS NOT NULL;
CREATE TABLE bachs_webhook_events (event_id TEXT NOT NULL, mode TEXT NOT NULL, checkout_id TEXT NOT NULL, order_ref TEXT NOT NULL REFERENCES orders(ref) ON DELETE CASCADE, event_type TEXT NOT NULL, payload_hash TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(event_id,mode));
CREATE INDEX bachs_events_order_idx ON bachs_webhook_events(order_ref,mode,checkout_id);
INSERT INTO settings(key,value) VALUES('currencies','["NGN","GHS","KES","MWK","RWF","TZS","UGX","XAF","XOF","ZMW"]') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
DELETE FROM cache WHERE key='fx_refresh_lock';
