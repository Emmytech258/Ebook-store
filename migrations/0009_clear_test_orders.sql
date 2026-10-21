DELETE FROM bachs_webhook_events WHERE order_ref IN (SELECT ref FROM orders WHERE NOT (mode='live' AND status IN ('paid','underpaid','review')) AND (mode!='live' OR created_at<CAST(strftime('%s','now') AS INTEGER)-3600));
DELETE FROM downloads WHERE order_ref IN (SELECT ref FROM orders WHERE NOT (mode='live' AND status IN ('paid','underpaid','review')) AND (mode!='live' OR created_at<CAST(strftime('%s','now') AS INTEGER)-3600));
DELETE FROM orders WHERE NOT (mode='live' AND status IN ('paid','underpaid','review')) AND (mode!='live' OR created_at<CAST(strftime('%s','now') AS INTEGER)-3600);
