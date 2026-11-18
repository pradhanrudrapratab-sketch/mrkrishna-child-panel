'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const h = require('./helpers');
const flow = require('../src/services/setupFlow');
const oauth = require('../src/integrations/oauth');
const pc = require('../src/integrations/parentClient');
const auth = require('../src/services/auth');
const views = require('../src/views');

const res = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
const REDIRECT = 'https://my-panel.onrender.com/oauth/callback';
const mockParent = (username = 'rita', tokenStatus = 200) => {
  oauth.setFetch(async (u) => {
    if (u.endsWith('/connect/register')) return res(200, { ok: true, data: { client_id: 'cp_test' } });
    if (u.endsWith('/connect/token')) return tokenStatus === 200 ? res(200, { ok: true, data: { access_token: 'mkp_secret', token_type: 'Bearer', account: { id: 'USR1005', username } } }) : res(tokenStatus, { ok: false, error: { code: 'invalid_grant', message: 'Code invalid or PKCE failed' } });
    throw new Error('unexpected ' + u);
  });
  pc.setFetch(async () => res(200, { ok: true, data: { account: { id: 'USR1005', username }, connection: { status: 'connected' } } }));
};
const begin = (db, data) => flow.begin(db, data, { name: 'My Panel', url: 'https://my-panel.onrender.com', redirectUri: REDIRECT });
const pw = { email: 'owner@example.com', password: 'password123', confirm: 'password123' };
const stateOf = (u) => new URL(u).searchParams.get('state');

test('begin: registers, builds an S256 authorize URL, keeps verifier and state server-side only', async () => {
  const db = h.freshDb(); mockParent(); const data = {}; const url = await begin(db, data); const q = new URL(url).searchParams;
  assert.equal(new URL(url).pathname, '/authorize'); assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('state'), data.oauth.state);
  assert.ok(data.oauth.verifier && !url.includes(data.oauth.verifier)); assert.equal(pc.getConn(db).client_id, 'cp_test');
});
test('happy path: authorize, return, create admin; token stored encrypted; audit entry written', async () => {
  const db = h.freshDb(); mockParent(); const data = {}; const url = await begin(db, data);
  const r = await flow.callback(db, data, { code: 'C', state: stateOf(url) }, REDIRECT);
  assert.equal(r.pendingAdmin.username, 'rita'); assert.equal(auth.adminExists(db), false); // not an admin yet: password still needed
  assert.ok(!pc.getConn(db).access_token_enc.includes('mkp_secret'));
  const id = flow.createAdmin(db, data, pw); const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  assert.equal(u.role, 'super_admin'); assert.equal(u.username, 'rita'); assert.equal(u.parent_account_id, 'USR1005'); assert.equal(data.pendingAdmin, undefined);
  assert.equal(db.prepare("SELECT count(*) c FROM activity_logs WHERE action='first_admin_created'").get().c, 1);
});
test('invalid OAuth state is rejected, creates nothing, and the attempt cannot be replayed', async () => {
  const db = h.freshDb(); mockParent(); const data = {}; const url = await begin(db, data);
  await assert.rejects(() => flow.callback(db, data, { code: 'C', state: 'forged' }, REDIRECT), /Invalid state/);
  assert.equal(data.pendingAdmin, undefined); assert.equal(data.oauth, undefined);
  await assert.rejects(() => flow.callback(db, data, { code: 'C', state: stateOf(url) }, REDIRECT)); // real state, but attempt already consumed
  assert.equal(pc.getConn(db).api_verified, 0);
});
test('PKCE/token failure from the parent: no admin step, connection stays off', async () => {
  const db = h.freshDb(); mockParent('rita', 400); const data = {}; const url = await begin(db, data);
  await assert.rejects(() => flow.callback(db, data, { code: 'C', state: stateOf(url) }, REDIRECT), /Token exchange failed/);
  assert.equal(data.pendingAdmin, undefined); assert.equal(pc.getConn(db).access_token_enc, null); assert.throws(() => flow.createAdmin(db, data, pw), /Connect your parent account/);
});
test('callback error (user denied) and missing code are rejected', async () => {
  const db = h.freshDb(); mockParent(); let data = {}; let url = await begin(db, data);
  await assert.rejects(() => flow.callback(db, data, { error: 'access_denied', state: stateOf(url) }, REDIRECT), /denied/);
  data = {}; url = await begin(db, data); await assert.rejects(() => flow.callback(db, data, { state: stateOf(url) }, REDIRECT), /Missing authorization code/);
});
test('callback without starting setup in this browser is refused', async () => {
  const db = h.freshDb(); mockParent(); const other = {}; const url = await begin(db, other); // attacker-supplied callback in a fresh session
  await assert.rejects(() => flow.callback(db, {}, { code: 'C', state: stateOf(url) }, REDIRECT), /not started from this browser/);
});
test('setup cannot run or be claimed again once an admin exists', async () => {
  const db = h.freshDb(); mockParent(); const data = {}; const url = await begin(db, data);
  await flow.callback(db, data, { code: 'C', state: stateOf(url) }, REDIRECT); const stale = { pendingAdmin: { ...data.pendingAdmin } }; flow.createAdmin(db, data, pw);
  await assert.rejects(() => begin(db, {}), /already complete/);
  const d2 = { setup: { at: Date.now() }, oauth: { state: 's', verifier: 'v', at: Date.now() } }; await assert.rejects(() => flow.callback(db, d2, { code: 'C', state: 's' }, REDIRECT), /already complete/);
  assert.throws(() => flow.createAdmin(db, stale, { ...pw, email: 'evil@example.com' }), /already exists/); assert.equal(db.prepare("SELECT count(*) c FROM users WHERE role='super_admin'").get().c, 1);
});
test('two browsers finishing at once: only one becomes admin', async () => {
  const db = h.freshDb(); mockParent(); const a = {}, b = {}; const ua = await begin(db, a); const ub = await begin(db, b);
  await flow.callback(db, a, { code: 'C', state: stateOf(ua) }, REDIRECT); await flow.callback(db, b, { code: 'C', state: stateOf(ub) }, REDIRECT);
  flow.createAdmin(db, a, pw); assert.throws(() => flow.createAdmin(db, b, { ...pw, email: 'b@example.com' }), /already exists/);
});
test('logged-in admin can reauthorize the parent without the setup flag', async () => {
  const db = h.freshDb(); mockParent(); auth.claimFirstAdmin(db, { username: 'owner', email: 'o@x.com', ...pw, email2: 1 }); const data = {};
  data.oauth = undefined; pc.setConn(db, { client_id: 'cp_test' }); const url = oauth.startAuthorization(db, data, REDIRECT);
  const r = await flow.callback(db, data, { code: 'C', state: stateOf(url) }, REDIRECT, { adminFlow: true }); assert.equal(r.conn.api_verified, 1);
});
test('optional owner lock rejects other parent accounts and clears their token', async () => {
  const db = h.freshDb(); process.env.OWNER_PARENT_USERNAME = 'rita';
  try {
    mockParent('mallory'); let data = {}; let url = await begin(db, data);
    await assert.rejects(() => flow.callback(db, data, { code: 'C', state: stateOf(url) }, REDIRECT), /not allowed/); assert.equal(data.pendingAdmin, undefined); assert.equal(pc.getConn(db).access_token_enc, null);
    mockParent('Rita'); data = {}; url = await begin(db, data); await flow.callback(db, data, { code: 'C', state: stateOf(url) }, REDIRECT); assert.ok(data.pendingAdmin);
  } finally { delete process.env.OWNER_PARENT_USERNAME; }
});
test('parent usernames are made safe for the local username rules', () => {
  assert.equal(flow.safeUsername('rita.k-1'), 'rita_k_1'); assert.equal(flow.safeUsername('ab').length >= 3, true); assert.equal(flow.safeUsername('x'.repeat(40)).length, 24); assert.equal(flow.safeUsername(''), 'admin');
});

test('no manual setup bypass or setup-code mechanism remains anywhere', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const root = path.join(__dirname, '..');
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'public')), ...walk(path.join(root, 'views'))];
  for (const f of files) { const t = fs.readFileSync(f, 'utf8'); assert.ok(!/api\/setup\/claim|setupToken|SETUP CODE|setupCode|SETUP_TOKEN/.test(t), `${f} still references the old setup code`); }
  assert.equal(fs.existsSync(path.join(root, 'src/services/setup.js')), false);
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'); const routes = [...app.matchAll(/app\.(?:get|post)\('(\/(?:api\/setup|oauth)[^']*)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(routes, ['/api/setup/admin', '/api/setup/start', '/oauth/callback']);
});

test('pages: panel name is escaped, initials and logo work, accent cannot inject CSS', () => {
  assert.equal(views.initials('MrKrishna Child Panel'), 'MK'); assert.equal(views.initials('Alpha Beta'), 'AB');
  const html = views.render('login', { name: '<script>alert(1)</script>', logoUrl: null }); assert.ok(!html.includes('<script>alert(1)')); assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(views.render('landing', { name: 'X', logoUrl: 'https://cdn.test/l.png' }).includes('has-img'));
  assert.equal(views.themeCss('#f4a63c').includes('--accent:#f4a63c'), true); assert.equal(views.themeCss('#fff;}body{display:none'), ''); assert.equal(views.themeCss(null), '');
});
test('pages: no inline scripts, inline styles or inline handlers (strict CSP), no leftover parent branding', () => {
  const dir = path.join(__dirname, '..', 'views');
  for (const f of fs.readdirSync(dir)) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)/.test(t), `${f} has an inline script`); assert.ok(!/\sstyle=|<style|\son[a-z]+=/.test(t), `${f} has inline style/handler`);
    assert.ok(!/MrKrishna SMM Panel|mrkrishna\.in/.test(t), `${f} has hardcoded parent branding`);
    assert.ok(!views.render(f.replace('.html', ''), { name: 'N' }).includes('{{'), `${f} has an unreplaced placeholder`);
  }
});
