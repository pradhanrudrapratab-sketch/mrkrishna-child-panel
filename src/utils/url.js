'use strict';
// Public address of this panel. Stored setting wins; otherwise derived from the request (Render sets the host and https).
function resolveAppUrl(stored, host, secure) {
  if (stored) return String(stored).replace(/\/$/, '');
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host || '')) throw new Error('Unrecognized host');
  return `${secure ? 'https' : 'http'}://${host}`;
}
function validateAppUrl(input) {
  let u; try { u = new URL(String(input).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.') || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  return u.origin;
}
module.exports = { resolveAppUrl, validateAppUrl };
