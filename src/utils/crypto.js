'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let cached = null;
// The key is generated on first start and kept in a file next to the database (never in the repo, never hardcoded).
function initKey(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'secret.key');
  let hex = ''; try { hex = fs.readFileSync(f, 'utf8').trim(); } catch { /* first start */ }
  let created = false;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) { hex = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, hex, { mode: 0o600 }); created = true; }
  cached = Buffer.from(hex, 'hex');
  return { created, file: f };
}
function key() {
  if (cached) return cached;
  const hex = process.env.ENCRYPTION_KEY || ''; // optional override (used by tests)
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Encryption key not initialised');
  return Buffer.from(hex, 'hex');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [v, s, h] = String(stored).split('$');
    if (v !== 's1') return false;
    const calc = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
    const exp = Buffer.from(h, 'base64');
    return calc.length === exp.length && crypto.timingSafeEqual(calc, exp);
  } catch { return false; }
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
module.exports = { initKey, encrypt, decrypt, hashPassword, verifyPassword, sha256, token, b64url, safeEqual };
