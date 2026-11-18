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

## First-time setup (no setup code, no logs)
1. Open your deployed site. While no admin exists, every page redirects to the welcome page.
2. Click **Connect parent account**. You are sent to the MrKrishna parent panel's consent screen (OAuth authorization code + PKCE S256 + random state, all verifier/state kept in your server-side session).
3. Confirm on the parent site (the code is valid for 2 minutes). You return to your panel automatically; the token exchange happens only on the server and is stored AES-256-GCM encrypted.
4. Choose your admin email and password. The admin username comes from the authorized parent account. Setup is then permanently closed: the start, callback and create-admin steps all refuse once an admin exists, and the admin insert is a single atomic transaction.
5. In Admin, Settings, fill in Payments (FamPay UPI ID, Gmail address, Gmail app password, FamPay sender address), then Services, Sync now.

Security note: the first parent account to finish setup becomes the owner. Complete it right after the service goes live. To lock it to your parent account, add the optional variable `OWNER_PARENT_USERNAME` (your MrKrishna username); any other parent account is then rejected and its token is discarded.

## Deploy on Render
1. Push this repo to GitHub.
2. Render, New, Web Service, pick the repo. Runtime Node, Build `npm install`, Start `npm start`, Plan Free (or use `render.yaml`). Health check path `/health`.
3. No environment variables are required. Open the URL Render gives you and follow First-time setup.

Environment variables (all optional): `OWNER_PARENT_USERNAME` (lock first-admin setup to one parent username), `DATABASE_PATH` (default `/tmp/mrkrishna-child-panel/database.sqlite`), `PARENT_OAUTH_REGISTER_PATH` / `PARENT_OAUTH_AUTHORIZE_PATH` / `PARENT_OAUTH_TOKEN_PATH` / `PARENT_OAUTH_CLIENT_ID` / `PARENT_ENDPOINTS_JSON` (only if the parent API changes). `PORT` is set by Render. The public HTTPS address, redirect URI and OAuth client are detected and stored automatically (Settings, General shows and can change the address).

Nothing secret is in the repo. The encryption key is generated on first start and stored next to the database in `/tmp`.

Free-tier reality: `/tmp` is wiped on restart, redeploy and spin-down, and the key goes with it. After a wipe there are no admin or customer accounts until you restore a backup; if there is no backup the panel returns to the welcome page and you repeat setup. After restoring on a fresh instance, the Gmail app password, Discord token and parent connection are cleared (the key changed) and must be entered or connected again. Each fresh setup registers a new OAuth client at the parent (the old ones stay as unused records there). Download backups often. Jobs cannot run while the service sleeps; on wake, overdue work runs after about 5 seconds, and a deposit email that arrives during sleep is still matched if it is inside the deposit's expiry window plus 5 minutes.

## Pages
Public: landing (`/`), platform service lists (`/services/instagram|telegram|facebook|whatsapp`, retail prices only), login, register. Customer app (`/app`): dashboard, new order, add funds with persistent QR, order history, deposit history, transactions, support, profile. Admin (`/admin`): overview, customers and wallet adjustments, services and markups, orders, deposits, transactions, parent connection, parent refills, settings, activity logs, backup/restore, profile. Password reset by email is not offered because the panel has no outgoing email; an admin can suspend/restore accounts, and customers can change their password while logged in.

## Rules implemented
- Money is integer paise. Retail rate = wholesale x (1 + markup) rounded up. Default markup 30%.
- Deposit credits the **requested** amount; the customer pays the payable amount (up to a few paise more).
- Deposit lifecycle: pending (default 30 min expiry), first automatic check at 10 minutes, retries every 90 seconds, final check after expiry plus 5 minutes, then expired. Manual Check Payment is rate limited to once per 60 seconds per deposit. `review` = ambiguous, admin decides. Paid/expired/failed/canceled are never credited again.
- A payment email is accepted only if: sender is in the allowlist, DKIM/SPF passed (default on), amount equals the payable amount exactly, received within the deposit window, message id not already used, no conflicting MKP reference, and exactly one candidate.
- Orders: wallet debit and order row (unique reference) commit before the parent call. Timeouts trigger a lookup by reference before any retry. Parent low balance sets Awaiting Admin Action with funds held. Parent failure never auto-refunds. Partial refunds proportionally to remains. Canceled refunds only when the parent confirms a refund. One refund per order, enforced by a unique ledger key.
- Customers never receive wholesale rates, parent service IDs or parent wallet data.
