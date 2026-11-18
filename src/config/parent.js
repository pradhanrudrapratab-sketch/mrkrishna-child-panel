'use strict';
// Three SEPARATE concepts. Never substitute one for another.
const env = process.env;
let endpointOverrides = {};
try { if (env.PARENT_ENDPOINTS_JSON) endpointOverrides = JSON.parse(env.PARENT_ENDPOINTS_JSON); } catch { /* ignored, defaults used */ }

module.exports = Object.freeze({
  websiteUrl: 'https://mrkrishna-smm-panel.onrender.com/',
  docsUrl: 'https://mrkrishna.site/developers', // where the owner found the docs; the page itself states the API base below
  apiBaseUrl: 'https://mrkrishna-smm-panel.onrender.com', // per the official Developer API page: <this>/api/v1, HTTPS only
  docsVerified: true, // endpoint list below matches the Developer API page supplied by the owner (Nov 2026)
  // Live use is still gated per connection: it turns on only after an authenticated account probe succeeds.
  // Override with PARENT_ENDPOINTS_JSON if the parent changes its API.
  endpoints: Object.freeze({
    account: ['GET', '/api/v1/account'],
    wallet: ['GET', '/api/v1/wallet'],
    walletTransactions: ['GET', '/api/v1/wallet/transactions'],
    services: ['GET', '/api/v1/services'],
    service: ['GET', '/api/v1/services/:id'],
    createOrder: ['POST', '/api/v1/orders'],
    order: ['GET', '/api/v1/orders/:id'],
    orders: ['GET', '/api/v1/orders'],
    refillCreate: ['POST', '/api/v1/wallet/refill'],
    refillVerify: ['POST', '/api/v1/wallet/refill/verify'],
    refillStatus: ['GET', '/api/v1/wallet/refill/:transaction_id'],
    revoke: ['POST', '/api/v1/connect/revoke'],
    ...endpointOverrides,
  }),
  oauth: Object.freeze({
    registerPath: env.PARENT_OAUTH_REGISTER_PATH || '/api/v1/connect/register',
    authorizePath: env.PARENT_OAUTH_AUTHORIZE_PATH || '/authorize', // note: not under /api/v1
    tokenPath: env.PARENT_OAUTH_TOKEN_PATH || '/api/v1/connect/token',
    clientId: env.PARENT_OAUTH_CLIENT_ID || null,
  }),
});
