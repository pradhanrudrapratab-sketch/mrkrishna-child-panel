# Architecture
- `src/database` SQLite (better-sqlite3, falls back to node:sqlite only for tests), migrations in `migrations/`, `DbHolder` reopens after restore.
- `src/services` wallet, allocation, deposits, catalog, orders, refills, support, auth, backup, settings.
- `src/integrations` parent client, OAuth+PKCE, Gmail IMAP parsing, Discord.
- `src/jobs` 30s tick, timestamp-driven catch-up. `src/app.js` Express routes. `public/` SPA (no inline scripts or styles; strict CSP).
- Security: scrypt passwords, hashed session ids in DB, HttpOnly SameSite cookies, CSRF header, in-memory rate limits, AES-GCM secrets, parameterized SQL, escaped output, unique ledger keys for exactly-once credits and refunds.
- Two wallets never mix: `customer_*` tables vs `parent_*` tables; customer APIs never select wholesale columns.

## Frontend
Server-rendered HTML shells in `views/` (panel name, logo, favicon injected; no inline script or style, strict CSP) plus static `public/css` and `public/js`. The design follows the MrKrishna parent panel (same tokens: base #0c1015, amber accent, cards, service cards, wallet hero, bottom-sheet order modal). `/theme.css` overrides only the accent colour from Settings.

## First-time setup
`src/services/setupFlow.js` wraps `src/integrations/oauth.js`: begin (register client, PKCE S256 + state in session), callback (state check, single use, token exchange, account probe, optional owner lock), createAdmin (atomic, once). No other route can create an admin.
