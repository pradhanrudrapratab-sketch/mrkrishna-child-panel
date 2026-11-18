'use strict';
const { encrypt, decrypt } = require('../utils/crypto');
function get(db, key, def = null) { const r = db.prepare('SELECT value FROM admin_settings WHERE key=?').get(key); return r && r.value !== null ? r.value : def; }
function set(db, key, value, secret = false) {
  const v = secret && value ? encrypt(value) : value;
  db.prepare("INSERT INTO admin_settings(key,value,is_secret,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,is_secret=excluded.is_secret,updated_at=excluded.updated_at").run(key, v, secret ? 1 : 0);
}
function getSecret(db, key) { const v = get(db, key); return v ? decrypt(v) : null; }
function getInt(db, key, def) { const n = parseInt(get(db, key), 10); return Number.isFinite(n) ? n : def; }
module.exports = { get, set, getSecret, getInt };
