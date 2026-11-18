'use strict';
const cfg = require('../config/parent');
const { encrypt, decrypt } = require('../utils/crypto');
const { fmt } = require('../utils/time');

let doFetch = (...a) => fetch(...a);
const setFetch = (f) => { doFetch = f; };

class ParentError extends Error {
  constructor(kind, status, message, retryAfter, code) { super(message); this.kind = kind; this.status = status; this.retryAfter = retryAfter; this.code = code; }
}
const KIND = { 400: 'invalid', 401: 'reauth', 402: 'insufficient', 403: 'forbidden', 404: 'notfound', 409: 'conflict', 410: 'expired', 429: 'ratelimit' };
const kindOf = (s) => KIND[s] || (s >= 500 ? 'upstream' : 'unknown');

const getConn = (db) => db.prepare('SELECT * FROM parent_connection WHERE id=1').get();
function setConn(db, f) {
  const keys = Object.keys(f);
  db.prepare(`UPDATE parent_connection SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=1`).run(...keys.map((k) => f[k]));
}
const storeToken = (db, token) => setConn(db, { access_token_enc: encrypt(token) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(db, name, { params = {}, query, body, skipGate = false, timeoutMs = 20000, retries = 2 } = {}) {
  const conn = getConn(db);
  if (!skipGate && !(conn.api_verified && conn.state === 'connected')) throw new ParentError('disabled', 0, 'Parent connection is not active');
  if (!conn.access_token_enc) throw new ParentError('disabled', 0, 'No parent access token');
  const ep = cfg.endpoints[name];
  if (!ep) throw new ParentError('disabled', 0, `Unknown endpoint ${name}`);
  const [method, tpl] = ep;
  const path = tpl.replace(/:(\w+)/g, (_, k) => encodeURIComponent(params[k] ?? ''));
  const url = new URL(cfg.apiBaseUrl + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const token = decrypt(conn.access_token_enc);
  const maxTries = method === 'GET' ? 1 + retries : 1; // financial writes are never auto-retried here
  let last;
  for (let i = 0; i < maxTries; i++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(url.toString(), {
        method, redirect: 'error', signal: ac.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null; const txt = await res.text();
      try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
      if (res.ok) {
        if (data === null || typeof data !== 'object') throw new ParentError('upstream', res.status, 'Parent returned a non-JSON response');
        if (data.ok === false) throw new ParentError('upstream', res.status, String(data.error?.message || 'Parent reported an error').slice(0, 200), undefined, data.error?.code);
        return data.ok === true && 'data' in data ? data.data : data; // documented envelope: {ok:true,data}
      }
      const msg = (data && (data.error?.message || data.message || (typeof data.error === 'string' ? data.error : null))) || `Parent HTTP ${res.status}`;
      const ra = parseInt(res.headers?.get?.('retry-after') || '', 10);
      last = new ParentError(kindOf(res.status), res.status, String(msg).slice(0, 200), Number.isFinite(ra) ? ra : undefined, data && data.error && data.error.code);
      if (res.status === 401 && !skipGate) setConn(db, { state: 'reauth_required', last_error: 'Parent rejected the token (401)' });
      if (!['ratelimit', 'upstream'].includes(last.kind) || [500].includes(res.status)) throw last;
      if (i < maxTries - 1) await sleep(Math.min((last.retryAfter || 1) * 1000, 5000));
    } catch (e) {
      if (e instanceof ParentError) { last = e; if (!['ratelimit', 'upstream'].includes(e.kind) || i >= maxTries - 1) throw e; }
      else {
        last = new ParentError(e.name === 'AbortError' ? 'timeout' : 'network', 0, e.name === 'AbortError' ? 'Parent request timed out' : 'Parent unreachable');
        if (i >= maxTries - 1) throw last;
        await sleep(500 * (i + 1));
      }
    } finally { clearTimeout(t); }
  }
  throw last;
}

const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? undefined : a[p]), o); if (v !== undefined && v !== null) return v; } return undefined; };

// Marks the connection active ONLY if an authenticated account call returns a JSON object.
async function probe(db) {
  try {
    const data = await call(db, 'account', { skipGate: true, retries: 0 });
    if (!data || typeof data !== 'object' || !data.account || data.account.id === undefined) throw new ParentError('upstream', 200, 'Unexpected account response');
    if (data.connection && data.connection.status && data.connection.status !== 'connected') throw new ParentError('reauth', 200, `Connection status is ${data.connection.status}`);
    setConn(db, { api_verified: 1, state: 'connected', last_probe_at: fmt(), last_error: null,
      account_id: String(data.account.id), account_username: String(data.account.username ?? '') });
    return { ok: true };
  } catch (e) {
    setConn(db, { api_verified: 0, last_probe_at: fmt(), last_error: `${e.kind}: ${e.message}`, ...(e.kind === 'reauth' ? { state: 'reauth_required' } : {}) });
    return { ok: false, kind: e.kind, error: e.message };
  }
}

const api = (db) => ({
  account: () => call(db, 'account'),
  wallet: () => call(db, 'wallet'),
  walletTransactions: (q) => call(db, 'walletTransactions', { query: q }),
  services: () => call(db, 'services'),
  createOrder: (body) => call(db, 'createOrder', { body }),
  getOrder: (id) => call(db, 'order', { params: { id } }),
  findOrderByReference: (reference) => call(db, 'orders', { query: { reference } }),
  listOrders: (q) => call(db, 'orders', { query: q }),
  refillCreate: (body) => call(db, 'refillCreate', { body }),
  refillVerify: (body) => call(db, 'refillVerify', { body }),
  refillStatus: (transaction_id) => call(db, 'refillStatus', { params: { transaction_id } }),
  revoke: () => call(db, 'revoke', { body: {} }),
});
module.exports = { ParentError, call, probe, api, getConn, setConn, storeToken, pick, setFetch };
