'use strict';
const auth = require('./auth');
const oauth = require('../integrations/oauth');
const pc = require('../integrations/parentClient');
const { ValidationError } = auth;

// First-time owner setup. The ONLY way to create the first admin is a completed parent OAuth authorization
// (code + PKCE S256 + state). There is no setup code and no manual claim path.
const complete = (db) => auth.adminExists(db);
const safeUsername = (u) => { const s = String(u || 'admin').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24); return s.length >= 3 ? s : (s + '___').slice(0, 3); };

async function begin(db, data, { name, url, redirectUri }) {
  if (complete(db)) throw new ValidationError('Setup is already complete');
  await oauth.ensureClient(db, { name, url, redirectUri });
  data.setup = { at: Date.now() };
  return oauth.startAuthorization(db, data, redirectUri); // stores state + PKCE verifier in the server-side session only
}

// adminFlow=true: an already-logged-in admin re-authorizing the parent connection from the admin panel.
async function callback(db, data, query, redirectUri, { adminFlow = false } = {}) {
  if (!adminFlow) {
    if (complete(db)) { delete data.oauth; throw new ValidationError('Setup is already complete'); }
    if (!data.setup) { delete data.oauth; throw new ValidationError('Setup was not started from this browser'); }
    delete data.setup;
  }
  const conn = await oauth.handleCallback(db, data, query, redirectUri); // validates state, single use, PKCE exchange, account probe
  if (adminFlow) return { conn };
  const owner = (process.env.OWNER_PARENT_USERNAME || '').trim().toLowerCase(); // optional lock, see README
  if (owner && String(conn.account_username || '').toLowerCase() !== owner) {
    await oauth.disconnect(db);
    throw new ValidationError('This parent account is not allowed to set up this panel');
  }
  data.pendingAdmin = { accountId: conn.account_id, username: safeUsername(conn.account_username) };
  return { conn, pendingAdmin: data.pendingAdmin };
}

function createAdmin(db, data, { email, password, confirm }) {
  const p = data.pendingAdmin;
  if (!p) throw new ValidationError('Connect your parent account first');
  const id = auth.claimFirstAdmin(db, { username: p.username, email, password, confirm, parentAccountId: p.accountId }); // atomic, once only
  delete data.pendingAdmin;
  db.prepare('INSERT INTO activity_logs(actor_id,action,detail) VALUES(?,?,?)').run(id, 'first_admin_created', `via parent oauth account ${p.accountId}`);
  return id;
}
module.exports = { begin, callback, createAdmin, complete, safeUsername };
