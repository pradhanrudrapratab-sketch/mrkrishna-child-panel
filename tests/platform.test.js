'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const h = require('./helpers');
const pc = require('../src/integrations/parentClient');
const oauth = require('../src/integrations/oauth');
const cfg = require('../src/config/parent');
const support = require('../src/services/support');
const backup = require('../src/services/backup');
const auth = require('../src/services/auth');
const cr = require('../src/utils/crypto');
const settings = require('../src/services/settings');
const { DbHolder } = require('../src/database');
const wallet = require('../src/services/wallet');

const res = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
const connect = (db) => { pc.storeToken(db, 'tok-secret'); pc.setConn(db, { api_verified: 1, state: 'connected' }); };

test('parent URL concepts stay separate; documented OAuth paths are set', () => {
  assert.equal(cfg.websiteUrl, 'https://mrkrishna-smm-panel.onrender.com/'); assert.notEqual(cfg.docsUrl, cfg.apiBaseUrl); assert.equal(cfg.apiBaseUrl, 'https://mrkrishna-smm-panel.onrender.com');
  assert.equal(cfg.oauth.authorizePath, '/authorize'); assert.equal(cfg.oauth.tokenPath, '/api/v1/connect/token'); assert.equal(cfg.endpoints.createOrder[1], '/api/v1/orders');
});
test('parent calls are blocked while the connection is unverified (no network call)', async () => {
  const db = h.freshDb(); let called = false; pc.setFetch(async () => { called = true; return res(200, {}); });
  await assert.rejects(() => pc.api(db).services(), (e) => e.kind === 'disabled'); assert.equal(called, false);
});
test('probe verifies only on a real JSON account response; token never sent unencrypted at rest', async () => {
  const db = h.freshDb(); pc.storeToken(db, 'tok-secret');
  assert.ok(!pc.getConn(db).access_token_enc.includes('tok-secret'));
  pc.setFetch(async (u, o) => { assert.equal(o.headers.Authorization, 'Bearer tok-secret'); return res(200, { ok: true, data: { account: { id: 'USR1005', username: 'owner' }, connection: { status: 'connected' }, wallet: { balance: '1.00' } } }); });
  assert.equal((await pc.probe(db)).ok, true); const c = pc.getConn(db); assert.equal(c.state, 'connected'); assert.equal(c.account_username, 'owner'); assert.equal(c.account_id, 'USR1005');
  pc.setFetch(async () => res(500, { error: 'x' })); assert.equal((await pc.probe(db)).ok, false); assert.equal(pc.getConn(db).api_verified, 0);
});
test('401 marks the connection as needing reauthorization', async () => {
  const db = h.freshDb(); connect(db); pc.setFetch(async () => res(401, { error: 'nope' }));
  await assert.rejects(() => pc.api(db).wallet(), (e) => e.kind === 'reauth'); assert.equal(pc.getConn(db).state, 'reauth_required');
  await assert.rejects(() => pc.api(db).wallet(), (e) => e.kind === 'disabled');
});
test('status codes map to error kinds; order creation is never auto-retried', async () => {
  const db = h.freshDb(); connect(db);
  for (const [s, k] of [[400, 'invalid'], [402, 'insufficient'], [403, 'forbidden'], [404, 'notfound'], [409, 'conflict'], [410, 'expired']]) {
    pc.setFetch(async () => res(s, { message: 'm' })); await assert.rejects(() => pc.api(db).createOrder({}), (e) => e.kind === k);
  }
  let n = 0; pc.setFetch(async () => { n++; return res(503, { message: 'down' }); });
  await assert.rejects(() => pc.api(db).createOrder({}), (e) => e.kind === 'upstream'); assert.equal(n, 1);
});
test('GET retries 503 then succeeds; non-JSON success is rejected', async () => {
  const db = h.freshDb(); connect(db); let n = 0; pc.setFetch(async () => (++n < 2 ? res(503, {}, { 'retry-after': '0' }) : res(200, { balance: 1 })));
  assert.equal((await pc.api(db).wallet()).balance, 1);
  pc.setFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>' })); await assert.rejects(() => pc.api(db).wallet(), (e) => e.kind === 'upstream');
});
test('PKCE S256 pair is correct and random', () => {
  const a = oauth.pkcePair(), b = oauth.pkcePair(); assert.equal(a.challenge, crypto.createHash('sha256').update(a.verifier).digest('base64url')); assert.notEqual(a.verifier, b.verifier); assert.ok(a.verifier.length >= 43);
});
test('response envelope {ok,data} is unwrapped; ok:false on HTTP 200 is an error', async () => {
  const db = h.freshDb(); connect(db); pc.setFetch(async () => res(200, { ok: true, data: { balance: '9.00', currency: 'INR' } })); assert.equal((await pc.api(db).wallet()).balance, '9.00');
  pc.setFetch(async () => res(200, { ok: false, error: { code: 'x', message: 'bad' } })); await assert.rejects(() => pc.api(db).wallet(), (e) => e.kind === 'upstream' && e.code === 'x');
  pc.setFetch(async () => res(409, { ok: false, error: { code: 'transaction_failed', message: 'f' } })); await assert.rejects(() => pc.api(db).wallet(), (e) => e.kind === 'conflict' && e.code === 'transaction_failed');
});
test('authorize URL matches the documented parameters', () => {
  const db = h.freshDb(); pc.setConn(db, { client_id: 'cp_abc' }); const s = {}; const u = new URL(oauth.startAuthorization(db, s, 'https://x.test/oauth/callback'));
  assert.equal(u.origin + u.pathname, 'https://mrkrishna-smm-panel.onrender.com/authorize');
  const q = Object.fromEntries(u.searchParams); assert.equal(q.response_type, 'code'); assert.equal(q.client_id, 'cp_abc'); assert.equal(q.redirect_uri, 'https://x.test/oauth/callback');
  assert.equal(q.code_challenge_method, 'S256'); assert.equal(q.code_challenge.length, 43); assert.ok(q.state.length >= 8 && q.state.length <= 200);
  assert.equal(q.code_challenge, crypto.createHash('sha256').update(s.oauth.verifier).digest('base64url')); assert.equal(q.state, s.oauth.state);
});
test('token exchange sends the documented JSON body, stores the token encrypted, then verifies via account', async () => {
  const db = h.freshDb(); pc.setConn(db, { client_id: 'cp_abc' }); const s = {}; oauth.startAuthorization(db, s, 'https://x.test/cb'); let body, ctype;
  oauth.setFetch(async (u, o) => { assert.equal(u, 'https://mrkrishna-smm-panel.onrender.com/api/v1/connect/token'); ctype = o.headers['Content-Type']; body = JSON.parse(o.body); return res(200, { ok: true, data: { access_token: 'mkp_secret', token_type: 'Bearer', account: { id: 'USR1', username: 'rita' } } }); });
  pc.setFetch(async (u, o) => { assert.equal(o.headers.Authorization, 'Bearer mkp_secret'); return res(200, { ok: true, data: { account: { id: 'USR1', username: 'rita' }, connection: { status: 'connected' } } }); });
  const state = s.oauth.state; const verifier = s.oauth.verifier; const conn = await oauth.handleCallback(db, s, { code: 'CODE', state }, 'https://x.test/cb');
  assert.equal(ctype, 'application/json'); assert.deepEqual(body, { grant_type: 'authorization_code', code: 'CODE', client_id: 'cp_abc', redirect_uri: 'https://x.test/cb', code_verifier: verifier });
  assert.equal(conn.account_username, 'rita'); assert.equal(conn.api_verified, 1); assert.ok(!conn.access_token_enc.includes('mkp_secret'));
});
test('token exchange failure leaves the connection off', async () => {
  const db = h.freshDb(); pc.setConn(db, { client_id: 'cp_abc' }); const s = {}; oauth.startAuthorization(db, s, 'https://x.test/cb'); const state = s.oauth.state;
  oauth.setFetch(async () => res(400, { ok: false, error: { code: 'invalid_grant', message: 'Code already used' } }));
  await assert.rejects(() => oauth.handleCallback(db, s, { code: 'C', state }, 'https://x.test/cb'), /Token exchange failed: Code already used/); assert.equal(pc.getConn(db).api_verified, 0);
});
test('client registration posts the documented body once per redirect URI', async () => {
  const db = h.freshDb(); let calls = 0, sent;
  oauth.setFetch(async (u, o) => { calls++; sent = JSON.parse(o.body); assert.equal(u, 'https://mrkrishna-smm-panel.onrender.com/api/v1/connect/register'); return res(200, { ok: true, data: { client_id: 'cp_new' } }); });
  const a = { name: 'P', url: 'https://p.test', redirectUri: 'https://p.test/oauth/callback' };
  assert.equal(await oauth.ensureClient(db, a), 'cp_new'); assert.equal(await oauth.ensureClient(db, a), 'cp_new'); assert.equal(calls, 1); assert.deepEqual(sent, { name: 'P', url: 'https://p.test', redirect_uri: 'https://p.test/oauth/callback' });
  await oauth.ensureClient(db, { ...a, redirectUri: 'https://p.test/other' }); assert.equal(calls, 2);
  await assert.rejects(() => oauth.registerClient(db, { ...a, redirectUri: 'http://p.test/cb' }), /HTTPS/);
});
test('OAuth callback: invalid state, reuse, and missing session all rejected', async () => {
  const db = h.freshDb(); const s = { oauth: { state: 'good', verifier: 'v', at: Date.now() } };
  await assert.rejects(() => oauth.handleCallback(db, s, { code: 'c', state: 'evil' }, 'https://x.test/cb'), /Invalid state/);
  assert.equal(s.oauth, undefined); // one-time: consumed even on failure
  await assert.rejects(() => oauth.handleCallback(db, s, { code: 'c', state: 'good' }, 'https://x.test/cb'), /No authorization in progress/);
  await assert.rejects(() => oauth.handleCallback(db, { oauth: { state: 's', verifier: 'v', at: Date.now() - 11 * 60000 } }, { code: 'c', state: 's' }, 'x'), /expired/);
});
test('disconnect clears the token even if revocation fails', async () => {
  const db = h.freshDb(); connect(db); pc.setFetch(async () => res(500, {})); const r = await oauth.disconnect(db);
  assert.equal(r.revoked, false); const c = pc.getConn(db); assert.equal(c.access_token_enc, null); assert.equal(c.state, 'disconnected');
});
test('support URL validation', () => {
  assert.equal(support.validateSupportUrl('https://t.me/mygroup').ok, true);
  for (const bad of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', 'https://user:pw@example.com', 'ftp://x.com', 'not a url', 'https://localhost']) assert.equal(support.validateSupportUrl(bad).ok, false, bad);
  const db = h.freshDb(); support.setSupport(db, { url: 'https://wa.me/911234567890', displayName: 'WA', enabled: true }); assert.equal(support.getSupport(db).enabled, 1);
  support.setSupport(db, { url: 'https://discord.gg/abc', enabled: true }); support.setSupport(db, { url: 'https://discord.gg/abc', enabled: false }); assert.equal(support.getSupport(db).enabled, 0);
  assert.throws(() => support.setSupport(db, { url: 'javascript:1', enabled: true }));
});
test('secrets are encrypted at rest and tamper-evident', () => {
  const db = h.freshDb(); settings.set(db, 'gmail_app_password_enc', 'abcd efgh', true);
  const raw = db.prepare("SELECT value FROM admin_settings WHERE key='gmail_app_password_enc'").get().value; assert.ok(!raw.includes('abcd')); assert.equal(settings.getSecret(db, 'gmail_app_password_enc'), 'abcd efgh');
  const parts = raw.split(':'); parts[3] = Buffer.from('tampered').toString('base64'); assert.throws(() => cr.decrypt(parts.join(':')));
});
test('passwords are hashed and verified; wrong password fails', () => {
  const h1 = cr.hashPassword('secret-pass'); assert.ok(!h1.includes('secret-pass')); assert.equal(cr.verifyPassword('secret-pass', h1), true); assert.equal(cr.verifyPassword('nope', h1), false);
});
test('registration validation, duplicate prevention, login, suspension', () => {
  const db = h.freshDb(); auth.register(db, { username: 'bob_1', email: 'b@x.com', password: 'password1', confirm: 'password1' });
  assert.throws(() => auth.register(db, { username: 'BOB_1', email: 'o@x.com', password: 'password1', confirm: 'password1' }), /already/);
  assert.throws(() => auth.register(db, { username: 'new', email: 'B@x.com', password: 'password1', confirm: 'password1' }), /already/);
  assert.throws(() => auth.register(db, { username: 'a', email: 'c@x.com', password: 'password1', confirm: 'password1' })); assert.throws(() => auth.register(db, { username: 'abc', email: 'c@x.com', password: 'short', confirm: 'short' }));
  assert.throws(() => auth.register(db, { username: 'abc', email: 'c@x.com', password: 'password1', confirm: 'different1' }), /match/);
  assert.equal(auth.login(db, { identifier: 'bob_1', password: 'password1' }).username, 'bob_1'); assert.throws(() => auth.login(db, { identifier: 'bob_1', password: 'bad' }));
  db.prepare("UPDATE users SET status='suspended'").run(); assert.throws(() => auth.login(db, { identifier: 'bob_1', password: 'password1' }), /suspended/);
});
test('SQL injection strings are treated as data', () => {
  const db = h.freshDb(); assert.throws(() => auth.login(db, { identifier: "' OR 1=1 --", password: 'x' }), /Wrong/); h.user(db, 'safe');
  assert.equal(db.prepare('SELECT count(*) c FROM users').get().c, 1);
});
test('first admin can be claimed only once, even by two attempts', () => {
  const db = h.freshDb(); const f = (u) => ({ username: u, email: `${u}@x.com`, password: 'password1', confirm: 'password1' });
  auth.claimFirstAdmin(db, f('owner')); assert.throws(() => auth.claimFirstAdmin(db, f('attacker')), /already exists/); assert.equal(db.prepare("SELECT count(*) c FROM users WHERE role='super_admin'").get().c, 1);
});
test('sessions: hashed at rest, expire, and are destroyed on logout', () => {
  const db = h.freshDb(); const id = h.user(db); const { sid } = auth.createSession(db, id);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions WHERE sid=?').get(sid).c, 0); assert.ok(auth.loadSession(db, sid));
  assert.equal(auth.loadSession(db, sid, new Date(Date.now() + 8 * 24 * 3600 * 1000)), null); auth.destroySession(db, sid); assert.equal(auth.loadSession(db, sid), null);
});
test('wallet: no negative balance, every change has a ledger row', () => {
  const db = h.freshDb(); const id = h.user(db, 'w', 1000); assert.throws(() => wallet.applyTx(db, { userId: id, type: 'order_debit', amountPaise: -2000 }), /Insufficient/);
  const sum = db.prepare('SELECT sum(amount_paise) s FROM customer_transactions WHERE user_id=?').get(id).s; assert.equal(sum, wallet.balance(db, id));
});
test('backup + restore round trip, and invalid uploads are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')); const holder = new DbHolder(path.join(dir, 'db.sqlite'));
  const id = h.user(holder.db, 'keep', 4200); const buf = backup.backupBuffer(holder.db); assert.equal(buf.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  wallet.applyTx(holder.db, { userId: id, type: 'admin_adjust', amountPaise: 500, refType: 'a', refId: 'x', reason: 'later change' });
  assert.throws(() => backup.restoreFromBuffer(holder, Buffer.from('not a database'.repeat(400))), /Not a SQLite/);
  assert.throws(() => backup.restoreFromBuffer(holder, Buffer.alloc(10)), /size/);
  const evil = path.join(dir, 'evil.sqlite'); const { openRaw } = require('../src/database'); const e = openRaw(evil); e.exec('CREATE TABLE users(id)'); e.close();
  assert.throws(() => backup.restoreFromBuffer(holder, fs.readFileSync(evil).length < 4096 ? Buffer.concat([fs.readFileSync(evil), Buffer.alloc(8192)]) : fs.readFileSync(evil)));
  assert.equal(wallet.balance(holder.db, id), 4700); // failed restores left live data untouched
  const r = backup.restoreFromBuffer(holder, buf); assert.equal(r.restored, true); assert.equal(wallet.balance(holder.db, id), 4200);
  holder.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('database is recreated and migrated from nothing (restart after /tmp wipe)', () => {
  const dir = path.join(os.tmpdir(), `mk-fresh-${Date.now()}`, 'nested'); const holder = new DbHolder(path.join(dir, 'database.sqlite'));
  assert.ok(fs.existsSync(path.join(dir, 'database.sqlite'))); assert.equal(holder.db.prepare('SELECT count(*) c FROM users').get().c, 0); holder.close(); fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});
