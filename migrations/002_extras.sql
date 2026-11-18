ALTER TABLE orders ADD COLUMN parent_status TEXT;
ALTER TABLE orders ADD COLUMN last_error TEXT;
ALTER TABLE orders ADD COLUMN submit_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discord_queue ADD COLUMN next_try_at TEXT;
ALTER TABLE parent_refills ADD COLUMN qr_url TEXT;
ALTER TABLE parent_refills ADD COLUMN last_checked_at TEXT;
ALTER TABLE parent_refills ADD COLUMN raw TEXT;
INSERT OR IGNORE INTO discord_settings(id) VALUES(1);
INSERT OR IGNORE INTO support_settings(id) VALUES(1);
INSERT OR IGNORE INTO admin_settings(key,value) VALUES
 ('global_markup_bp','3000'),('panel_name','MrKrishna SMM Child Panel'),('min_deposit_paise','1000'),('max_deposit_paise','5000000'),
 ('deposit_expiry_minutes','30'),('require_dkim','1');
