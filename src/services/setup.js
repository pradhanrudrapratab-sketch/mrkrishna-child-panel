'use strict';
const crypto = require('crypto');
const auth = require('./auth');
const { safeEqual } = require('../utils/crypto');
// One-time setup code, generated in memory at start and printed to the server log (Render, Logs tab).
// Nothing to configure, and nobody but the person who can read the logs can claim the first admin.
let code = null;
function current(db) {
  if (auth.adminExists(db)) { code = null; return null; }
  if (!code) { code = crypto.randomBytes(6).toString('hex'); console.log(`SETUP CODE: ${code}  (use it on the first-time admin setup page)`); }
  return code;
}
const check = (db, input) => { const c = current(db); return !!c && safeEqual(String(input || ''), c); };
module.exports = { current, check };
