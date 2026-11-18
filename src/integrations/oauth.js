'use strict';
const crypto = require('crypto');
const cfg = require('../config/parent');
const pc = require('./parentClient');
const { b64url, safeEqual, sha256 } = require('../utils/crypto');
const settings = require('../services/settings');

let doFetch = (...a) => fetch(...a);
const setFetch = (f) => { doFetch = f; };

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}
function requirePaths(...k) { for (const x of k) if (!cfg.oauth[x]) throw new Error(`OAuth is not configured (${x} is unknown). Set it from the verified parent documentation.`); }
const clientId = (db) => pc.getConn(db).client_id || cfg.oauth.clientId;

async function registerClient(db, { name, url, redirectUri }) {
  requirePaths('registerPath');
  if (!redirectUri.startsWith('https://')) throw new Error('Redirect URI must be HTTPS');
  const res = await doFetch(cfg.apiBaseUrl + cfg.oauth.registerPath, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name, url, redirect_uri: redirectUri }), redirect: 'error' });
  const data = await res.json().catch(() => null);
  const id = data && (data.client_id || data.data?.client_id);
  if (!res.ok || !id) throw new Error('Parent did not return a client_id');
  pc.setConn(db, { client_id: String(id) });
  return { clientId: String(id) };
}

// Registers once per redirect URI (the parent matches redirect_uri exactly). Re-registers if the public address changed.
async function ensureClient(db, { name, url, redirectUri }) {
  const known = clientId(db);
  if (known && (cfg.oauth.clientId || settings.get(db, 'oauth_registered_redirect') === redirectUri)) return known;
  const r = await registerClient(db, { name, url, redirectUri });
  settings.set(db, 'oauth_registered_redirect', redirectUri);
  return r.clientId;
}

function startAuthorization(db, session, redirectUri) {
  requirePaths('authorizePath');
  const cid = clientId(db); if (!cid) throw new Error('No OAuth client registered');
  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(24));
  session.oauth = { state, verifier, at: Date.now() };
  const u = new URL(cfg.apiBaseUrl + cfg.oauth.authorizePath);
  u.search = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return u.toString();
}

// One-time: oauth data is removed from the session before any network call, so a code/state can never be replayed.
async function handleCallback(db, session, query, redirectUri) {
  const o = session.oauth; delete session.oauth;
  if (!o) throw new Error('No authorization in progress');
  if (Date.now() - o.at > 10 * 60000) throw new Error('Authorization expired, start again');
  if (query.error) throw new Error('Parent denied the authorization');
  if (!query.state || !safeEqual(query.state, o.state)) throw new Error('Invalid state');
  if (!query.code) throw new Error('Missing authorization code');
  requirePaths('tokenPath');
  const res = await doFetch(cfg.apiBaseUrl + cfg.oauth.tokenPath, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: String(query.code), client_id: clientId(db), redirect_uri: redirectUri, code_verifier: o.verifier }) });
  const body = await res.json().catch(() => null);
  const data = body && (body.data || body);
  if (!res.ok || !data || typeof data.access_token !== 'string' || !data.access_token) throw new Error(`Token exchange failed${body && body.error && body.error.message ? `: ${String(body.error.message).slice(0, 120)}` : ''}`);
  pc.storeToken(db, data.access_token);
  pc.setConn(db, { state: 'pending_probe' });
  const p = await pc.probe(db);
  if (!p.ok) throw new Error(`Connected token could not be verified: ${p.error}`);
  return pc.getConn(db);
}

async function disconnect(db) {
  let revoked = false;
  try { await pc.api(db).revoke(); revoked = true; } catch { /* still clear locally */ }
  pc.setConn(db, { access_token_enc: null, api_verified: 0, state: 'disconnected', last_error: null });
  return { revoked };
}
module.exports = { pkcePair, registerClient, ensureClient, startAuthorization, handleCallback, disconnect, setFetch, sha256 };
