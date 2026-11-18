'use strict';
const wallet = require('./wallet');
const { hashPassword, verifyPassword, sha256, token } = require('../utils/crypto');
const { fmt, addMs, parse } = require('../utils/time');

const SESSION_MS = 7 * 24 * 3600 * 1000;
class ValidationError extends Error { constructor(m) { super(m); this.code = 'VALIDATION'; } }

function validate({ username, email, password, confirm }) {
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username || '')) throw new ValidationError('Username must be 3-24 letters, numbers or underscores');
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email || '') || email.length > 254) throw new ValidationError('Enter a valid email address');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new ValidationError('Password must be 8-128 characters');
  if (password !== confirm) throw new ValidationError('Passwords do not match');
}

function createUser(db, { username, email, password, role = 'customer', parentAccountId = null }) {
  try {
    return db.transaction(() => {
      const r = db.prepare('INSERT INTO users(username,email,password_hash,role,parent_account_id) VALUES(?,?,?,?,?)').run(username, email.toLowerCase(), hashPassword(password), role, parentAccountId);
      const id = Number(r.lastInsertRowid); wallet.ensureWallet(db, id); return id;
    })();
  } catch (e) { if (/UNIQUE/i.test(e.message)) throw new ValidationError('That username or email is already registered'); throw e; }
}
const register = (db, f) => { validate(f); return createUser(db, f); };

function login(db, { identifier, password }) {
  const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(String(identifier || ''), String(identifier || '').toLowerCase());
  const ok = verifyPassword(String(password || ''), u ? u.password_hash : 's1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'); // constant-ish work for unknown users
  if (!u || !ok) throw new ValidationError('Wrong username or password');
  if (u.status !== 'active') throw new ValidationError('This account is suspended');
  return u;
}

function createSession(db, userId, now = new Date()) {
  const sid = token(32), csrf = token(24);
  db.prepare('INSERT INTO sessions(sid,user_id,data,expires_at) VALUES(?,?,?,?)').run(sha256(sid), userId, JSON.stringify({ csrf }), fmt(addMs(now, SESSION_MS)));
  return { sid, csrf };
}
function loadSession(db, sid, now = new Date()) {
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
  const r = db.prepare('SELECT * FROM sessions WHERE sid=?').get(sha256(sid));
  if (!r || parse(r.expires_at) < now.getTime()) return null;
  return { key: r.sid, userId: r.user_id, data: JSON.parse(r.data || '{}') };
}
const saveSession = (db, s) => db.prepare('UPDATE sessions SET data=? WHERE sid=?').run(JSON.stringify(s.data), s.key);
const destroySession = (db, sid) => db.prepare('DELETE FROM sessions WHERE sid=?').run(sha256(sid));
const purgeSessions = (db, now = new Date()) => db.prepare('DELETE FROM sessions WHERE expires_at<?').run(fmt(now)).changes;

function changePassword(db, userId, { current, password, confirm }) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!verifyPassword(String(current || ''), u.password_hash)) throw new ValidationError('Current password is wrong');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new ValidationError('Password must be 8-128 characters');
  if (password !== confirm) throw new ValidationError('Passwords do not match');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); // sign out everywhere
}

// First-admin claim: single IMMEDIATE transaction so two concurrent claims cannot both succeed.
function claimFirstAdmin(db, { username, email, password, confirm, parentAccountId }) {
  validate({ username, email, password, confirm });
  return db.transaction(() => {
    if (db.prepare("SELECT count(*) c FROM users WHERE role='super_admin'").get().c > 0) throw new ValidationError('An admin already exists');
    let name = username; let n = 0;
    while (db.prepare('SELECT 1 FROM users WHERE username=?').get(name)) name = `${username.slice(0, 20)}_${++n}`;
    return createUser(db, { username: name, email, password, role: 'super_admin', parentAccountId });
  }).immediate();
}
const adminExists = (db) => db.prepare("SELECT count(*) c FROM users WHERE role='super_admin'").get().c > 0;
module.exports = { register, login, createUser, createSession, loadSession, saveSession, destroySession, purgeSessions, changePassword, claimFirstAdmin, adminExists, ValidationError, validate };
