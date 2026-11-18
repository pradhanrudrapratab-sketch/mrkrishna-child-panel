# MrKrishna SMM Child Panel

Independent reseller panel: own customers and wallets, FamPay UPI deposits verified through the owner's Gmail, wholesale fulfilment through the parent panel at https://mrkrishna-smm-panel.onrender.com/.

## Honest status
Built and covered by 57 automated tests (money, deposits, Gmail parsing, orders, refunds, parent client, OAuth/PKCE guards, auth, backup/restore, jobs):
customer registration/login, wallets and ledger, unique payable-amount allocation, persistent QR deposits, exactly-once credit, order lifecycle with refunds, service sync and markup, parent refills, Discord log queue, support URL, admin dashboard, backup/restore, background jobs with catch-up.

Parent API: implemented against the official Developer API page supplied by the owner (base `https://mrkrishna-smm-panel.onrender.com/api/v1`, `{ok,data}` envelope, OAuth + PKCE, idempotent `reference`, wallet refill with verify). Endpoints, OAuth paths, error codes and status names match that page. See docs/parent-integration.md.

Still NOT verified, so read this before going live:
1. **Never exercised against the live parent.** All parent behaviour was tested with mocks that follow the documentation. Do one end-to-end run (connect, sync, one small order, one small refill) before real customers.
2. **FamPay email format is unverified.** Parsing is generic. Use Settings, then Test Gmail, on a real payment email before enabling deposits.
3. **The Express routes and the browser UI were not executed** in the build environment (no network, so `npm install` could not run). Business logic ran against SQLite through `node:sqlite`; production uses `better-sqlite3`. Run `npm install && npm test` and click through every screen once before real money moves.
4. **Not built:** customer API keys (optional in the spec), exact visual matching of the parent theme (its CSS could not be inspected; the UI uses a dark `#0c1015` base with a configurable accent), and HTTP-level tests of CSRF and route authorization.
5. `/tmp` is ephemeral. Download backups regularly.

## Deploy on Render (no environment variables)
1. Push this repo to GitHub.
2. Render, New, Web Service, pick the repo. Runtime Node, Build `npm install`, Start `npm start`, Plan Free. (Or use the included `render.yaml` as a Blueprint.) Leave Environment empty.
3. When it is live, open the Logs tab and copy the line `SETUP CODE: ...`.
4. Open your site, click **First-time admin setup**, enter the code, and connect your parent account (or use manual setup). You confirm on the parent's consent screen within 2 minutes.
5. Admin, Settings: Payments (FamPay UPI ID, Gmail address, Gmail app password, FamPay sender address), then Discord and Support if wanted. Gmail app password: Google Account, Security, 2-Step Verification on, App passwords, create one for Mail. IMAP must be enabled in Gmail.
6. Admin, Parent connection: Connect, then Sync services in Admin, Services.

Nothing secret is in the repo. On first start the app generates its own encryption key (stored next to the database in `/tmp`) and a one-time setup code (printed in the logs while no admin exists). The panel's public address is detected from the request and can be changed in Settings, General. The only optional overrides are `DATABASE_PATH` and the `PARENT_*` variables in docs/parent-integration.md; you do not need them.

Free-tier reality: `/tmp` is wiped on restart, redeploy and spin-down, and the key goes with it. After a wipe: log in again is impossible (accounts are gone) until you restore a backup; after restoring, the Gmail app password, Discord token and parent connection are cleared (their key changed) and must be entered again. Download backups often. Jobs cannot run while the service sleeps; on wake, overdue work runs after about 5 seconds, and a deposit email that arrives during sleep is still matched if it is inside the deposit's expiry window plus 5 minutes.

## Rules implemented
- Money is integer paise. Retail rate = wholesale x (1 + markup) rounded up. Default markup 30%.
- Deposit credits the **requested** amount; the customer pays the payable amount (up to a few paise more).
- Deposit lifecycle: pending (default 30 min expiry), first automatic check at 10 minutes, retries every 90 seconds, final check after expiry plus 5 minutes, then expired. Manual Check Payment is rate limited to once per 60 seconds per deposit. `review` = ambiguous, admin decides. Paid/expired/failed/canceled are never credited again.
- A payment email is accepted only if: sender is in the allowlist, DKIM/SPF passed (default on), amount equals the payable amount exactly, received within the deposit window, message id not already used, no conflicting MKP reference, and exactly one candidate.
- Orders: wallet debit and order row (unique reference) commit before the parent call. Timeouts trigger a lookup by reference before any retry. Parent low balance sets Awaiting Admin Action with funds held. Parent failure never auto-refunds. Partial refunds proportionally to remains. Canceled refunds only when the parent confirms a refund. One refund per order, enforced by a unique ledger key.
- Customers never receive wholesale rates, parent service IDs or parent wallet data.
