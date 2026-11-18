'use strict';
const { decrypt } = require('../utils/crypto');
// If the encryption key changed (new deploy, wiped /tmp, restore on a new instance), stored secrets can't be read.
// Clear them so the admin simply re-enters them, instead of failing in confusing ways later.
function scrubSecrets(db) {
  const cleared = [];
  const bad = (v) => { try { decrypt(v); return false; } catch { return true; } };
  for (const r of db.prepare('SELECT key,value FROM admin_settings WHERE is_secret=1 AND value IS NOT NULL').all())
    if (bad(r.value)) { db.prepare('UPDATE admin_settings SET value=NULL WHERE key=?').run(r.key); cleared.push(r.key === 'gmail_app_password_enc' ? 'Gmail app password' : r.key); }
  const d = db.prepare('SELECT bot_token_enc FROM discord_settings WHERE id=1').get();
  if (d && d.bot_token_enc && bad(d.bot_token_enc)) { db.prepare('UPDATE discord_settings SET bot_token_enc=NULL WHERE id=1').run(); cleared.push('Discord bot token'); }
  const p = db.prepare('SELECT access_token_enc FROM parent_connection WHERE id=1').get();
  if (p && p.access_token_enc && bad(p.access_token_enc)) {
    db.prepare("UPDATE parent_connection SET access_token_enc=NULL,api_verified=0,state='disconnected',last_error='Reconnect needed: stored token could not be decrypted' WHERE id=1").run(); cleared.push('Parent connection');
  }
  return cleared;
}
module.exports = { scrubSecrets };
