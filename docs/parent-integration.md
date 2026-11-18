# Parent integration (verified against the official Developer API page)

| Concept | Value |
|---|---|
| Parent website | https://mrkrishna-smm-panel.onrender.com/ |
| Docs URL | https://mrkrishna.site/developers (where the owner found the docs) |
| API base URL | https://mrkrishna-smm-panel.onrender.com/api/v1 (HTTPS only, server-to-server only, no CORS) |

Configured in `src/config/parent.js`. Responses are `{ok:true,data}` or `{ok:false,error:{code,message}}`; the client unwraps `data` and maps HTTP status to error kinds (400 invalid, 401 reauth, 402 insufficient, 403 forbidden, 404 notfound, 409 conflict, 410 expired, 429 ratelimit, 5xx upstream) and keeps `error.code`.

## Authorization (OAuth code + PKCE S256)
1. `POST /api/v1/connect/register` `{name,url,redirect_uri}` once per redirect URI; stores `client_id`. Redirect must be HTTPS on the same origin as `url` (we use `<public address>/oauth/callback`).
2. Browser goes to `/authorize` (not under /api/v1) with response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method=S256. State and verifier live only in the server-side session and are deleted on first use.
3. `POST /api/v1/connect/token` JSON `{grant_type,code,client_id,redirect_uri,code_verifier}` returns the token plus the account. The code is single use and valid 2 minutes. The token is stored AES-256-GCM encrypted and the connection turns on only after `GET /account` succeeds.
4. Disconnect calls `POST /api/v1/connect/revoke`, then clears the token locally even if revocation fails.

## Used endpoints
account, wallet, wallet/transactions (client method present), services (synced at most every 12h, matches the parent's 24h cache; only `type: Default` is imported), orders (create, by id, by reference, list), wallet/refill, wallet/refill/verify, wallet/refill/:id (client method present).

## Behaviour that follows the docs
- `reference` is the idempotency key, so repeating a create with the same reference is safe and returns `duplicate:true`. Order references are saved before the request. A timeout triggers a lookup by reference, then a resubmit with the same reference.
- 402 means nothing happened: the order stays, customer funds stay held, status becomes Awaiting Admin Action, retry after refilling.
- Status `failed` keeps the charge until the parent admin resolves it, so it is never auto-refunded to customers. `canceled` is "not refunded", so also manual. `refunded` and any `refund_amount` on partial/canceled are the only automatic refund triggers.
- Refill: create returns payment_url/qr_url and the exact payable_amount; verify is polled by a job at most once a minute per refill (limit 20/min). 410 expired and 409 failed are recorded; 502 leaves it pending.
- Rates arrive with 4 decimals and are rounded UP to the paisa; retail is computed from that, so customers are never undercharged. The parent's real charge (`order.charge`) is saved as the wholesale cost when returned.
- Limits respected: orders 60/min, calls 120/min, refills 10 per 10 min (the child panel's own limits are lower).
