'use strict';
delete process.env.ENCRYPTION_KEY; // prove nothing needs to be configured
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cr = require('../src/utils/crypto');
const { openDb } = require('../src/database');
const settings = require('../src/services/settings');
const { scrubSecrets } = require('../src/services/secrets');
const setup = require('../src/services/setup');
const auth = require('../src/services/auth');
const { resolveAppUrl, validateAppUrl } = require('../src/utils/url');
const pc = require('../src/integrations/parentClient');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mk-key-'));

test('encryption key is generated once, persisted with restricted permissions, and reused', () => {
  const dir = tmp(); const a = cr.initKey(dir); assert.equal(a.created, true);
  const blob = cr.encrypt('secret'); const b = cr.initKey(dir); assert.equal(b.created, false); assert.equal(cr.decrypt(blob), 'secret');
  assert.equal(fs.statSync(path.join(dir, 'secret.key')).mode & 0o077, 0);
});
test('secrets that cannot be decrypted after a key change are cleared, not left broken', () => {
  const db = openDb(':memory:'); cr.initKey(tmp());
  settings.set(db, 'gmail_app_password_enc', 'pw', true); pc.storeToken(db, 'tok'); pc.setConn(db, { api_verified: 1, state: 'connected' });
  db.prepare('UPDATE discord_settings SET bot_token_enc=? WHERE id=1').run(cr.encrypt('bot'));
  assert.deepEqual(scrubSecrets(db), []); // same key: nothing cleared
  cr.initKey(tmp()); // simulates a wiped instance with a brand-new key
  const cleared = scrubSecrets(db); assert.ok(cleared.includes('Gmail app password') && cleared.includes('Discord bot token') && cleared.includes('Parent connection'));
  assert.equal(settings.get(db, 'gmail_app_password_enc'), null); const c = pc.getConn(db); assert.equal(c.api_verified, 0); assert.equal(c.state, 'disconnected'); assert.equal(c.access_token_enc, null);
});
test('setup code: exists only while no admin exists, wrong codes rejected', () => {
  const db = openDb(':memory:'); const log = console.log; let line = ''; console.log = (m) => { line += m; };
  const code = setup.current(db); console.log = log; assert.match(code, /^[0-9a-f]{12}$/); assert.match(line, /SETUP CODE/);
  assert.equal(setup.check(db, 'wrong'), false); assert.equal(setup.check(db, ''), false); assert.equal(setup.check(db, code), true);
  auth.claimFirstAdmin(db, { username: 'owner', email: 'o@x.com', password: 'password1', confirm: 'password1' });
  assert.equal(setup.current(db), null); assert.equal(setup.check(db, code), false);
});
test('public URL: saved value wins, otherwise derived from the request host', () => {
  assert.equal(resolveAppUrl(null, 'my-panel.onrender.com', true), 'https://my-panel.onrender.com');
  assert.equal(resolveAppUrl('https://custom.example.com/', 'x.onrender.com', true), 'https://custom.example.com');
  assert.throws(() => resolveAppUrl(null, 'evil.com/<script>', true));
  assert.equal(validateAppUrl('https://my-panel.onrender.com/'), 'https://my-panel.onrender.com');
  for (const bad of ['http://x.com', 'https://x.com/path', 'https://u:p@x.com', 'javascript:1', 'https://localhost', 'https://x.com?a=1']) assert.equal(validateAppUrl(bad), null, bad);
});
