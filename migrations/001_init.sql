PRAGMA foreign_keys=ON;
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN('super_admin','customer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended')), parent_account_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions(sid TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, data TEXT, expires_at TEXT NOT NULL);
CREATE TABLE admin_settings(key TEXT PRIMARY KEY, value TEXT, is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE customer_wallets(user_id INTEGER PRIMARY KEY REFERENCES users(id), balance_paise INTEGER NOT NULL DEFAULT 0 CHECK(balance_paise>=0),
  reserved_paise INTEGER NOT NULL DEFAULT 0 CHECK(reserved_paise>=0));
CREATE TABLE customer_transactions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN('deposit','order_debit','refund','admin_adjust')), amount_paise INTEGER NOT NULL,
  balance_after_paise INTEGER NOT NULL, ref_type TEXT, ref_id TEXT, reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type,ref_type,ref_id));
CREATE TABLE deposits(id INTEGER PRIMARY KEY, transaction_id TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id),
  requested_paise INTEGER NOT NULL CHECK(requested_paise>0), payable_paise INTEGER NOT NULL, owner_upi_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','paid','expired','failed','canceled','review')),
  verification_attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, notification_uid TEXT UNIQUE,
  verification_result TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, credited_at TEXT);
CREATE UNIQUE INDEX uq_active_payable ON deposits(payable_paise) WHERE status='pending';
CREATE INDEX ix_deposits_user ON deposits(user_id,created_at);
CREATE TABLE deposit_notifications(id INTEGER PRIMARY KEY, message_uid TEXT NOT NULL UNIQUE, sender TEXT, amount_paise INTEGER,
  received_at TEXT, outcome TEXT NOT NULL DEFAULT 'unmatched', deposit_id INTEGER REFERENCES deposits(id));
CREATE TABLE payment_verifications(id INTEGER PRIMARY KEY, deposit_id INTEGER REFERENCES deposits(id), result TEXT, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE service_categories(id INTEGER PRIMARY KEY, platform TEXT, name TEXT NOT NULL, UNIQUE(platform,name));
CREATE TABLE services(id INTEGER PRIMARY KEY, parent_service_id TEXT NOT NULL UNIQUE, category_id INTEGER REFERENCES service_categories(id),
  name TEXT NOT NULL, type TEXT DEFAULT 'default', min_qty INTEGER, max_qty INTEGER, wholesale_paise_per_1000 INTEGER NOT NULL,
  currency TEXT DEFAULT 'INR', description TEXT, markup_bp INTEGER, custom_rate_paise INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1, synced_at TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL REFERENCES services(id), link TEXT NOT NULL, quantity INTEGER NOT NULL,
  retail_paise INTEGER NOT NULL, wholesale_paise INTEGER, parent_order_id TEXT, refunded_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_progress','completed','partial','canceled','failed','refunded','awaiting_admin')),
  next_poll_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE INDEX ix_orders_user ON orders(user_id,created_at);
CREATE TABLE order_events(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), event TEXT NOT NULL, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE parent_connection(id INTEGER PRIMARY KEY CHECK(id=1), api_verified INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'disconnected',
  client_id TEXT, access_token_enc TEXT, account_id TEXT, account_username TEXT, last_probe_at TEXT, last_error TEXT);
INSERT INTO parent_connection(id) VALUES(1);
CREATE TABLE parent_wallet_transactions(id INTEGER PRIMARY KEY, parent_txn_id TEXT UNIQUE, amount_paise INTEGER, kind TEXT, raw TEXT, created_at TEXT);
CREATE TABLE parent_refills(id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE, parent_txn_id TEXT UNIQUE, amount_paise INTEGER NOT NULL,
  payment_url TEXT, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE discord_settings(id INTEGER PRIMARY KEY CHECK(id=1), bot_token_enc TEXT, channel_id TEXT);
CREATE TABLE discord_queue(id INTEGER PRIMARY KEY, deposit_id INTEGER UNIQUE REFERENCES deposits(id), attempts INTEGER DEFAULT 0, sent_at TEXT, last_error TEXT);
CREATE TABLE support_settings(id INTEGER PRIMARY KEY CHECK(id=1), url TEXT, display_name TEXT, enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE activity_logs(id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE api_keys(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), key_hash TEXT NOT NULL UNIQUE, revoked_at TEXT);
