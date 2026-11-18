# Architecture
- `src/database` SQLite (better-sqlite3, falls back to node:sqlite only for tests), migrations in `migrations/`, `DbHolder` reopens after restore.
- `src/services` wallet, allocation, deposits, catalog, orders, refills, support, auth, backup, settings.
- `src/integrations` parent client, OAuth+PKCE, Gmail IMAP parsing, Discord.
- `src/jobs` 30s tick, timestamp-driven catch-up. `src/app.js` Express routes. `public/` SPA (no inline scripts or styles; strict CSP).
- Security: scrypt passwords, hashed session ids in DB, HttpOnly SameSite cookies, CSRF header, in-memory rate limits, AES-GCM secrets, parameterized SQL, escaped output, unique ledger keys for exactly-once credits and refunds.
- Two wallets never mix: `customer_*` tables vs `parent_*` tables; customer APIs never select wholesale columns.
