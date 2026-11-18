'use strict';
function validateSupportUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return { ok: false, error: 'Enter a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'Support URL must start with https://' };
  if (u.username || u.password) return { ok: false, error: 'URLs with credentials are not allowed' };
  if (!u.hostname.includes('.')) return { ok: false, error: 'Enter a public website address' };
  if (String(input).length > 500) return { ok: false, error: 'URL is too long' };
  return { ok: true, url: u.toString() };
}
function getSupport(db) { const r = db.prepare('SELECT url,display_name,enabled FROM support_settings WHERE id=1').get(); return r || { url: null, display_name: null, enabled: 0 }; }
function setSupport(db, { url, displayName, enabled }) {
  let clean = null;
  if (url) { const v = validateSupportUrl(url); if (!v.ok) throw new Error(v.error); clean = v.url; }
  if (enabled && !clean) throw new Error('Add a support URL before enabling support');
  db.prepare('UPDATE support_settings SET url=?,display_name=?,enabled=? WHERE id=1').run(clean, displayName ? String(displayName).slice(0, 60) : null, enabled ? 1 : 0);
}
module.exports = { validateSupportUrl, getSupport, setSupport };
