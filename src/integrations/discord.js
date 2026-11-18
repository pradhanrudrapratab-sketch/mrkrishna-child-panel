'use strict';
const settings = require('../services/settings');
const { fromPaise } = require('../utils/money');
const { fmt, addMs } = require('../utils/time');
const { encrypt, decrypt } = require('../utils/crypto');
let doFetch = (...a) => fetch(...a);
const setFetch = (f) => { doFetch = f; };

function getConfig(db) {
  const r = db.prepare('SELECT bot_token_enc,channel_id FROM discord_settings WHERE id=1').get();
  return { token: r && r.bot_token_enc ? decrypt(r.bot_token_enc) : null, channelId: r && r.channel_id };
}
function saveConfig(db, { token, channelId }) {
  if (channelId && !/^\d{5,25}$/.test(channelId)) throw new Error('Invalid channel ID');
  if (token) db.prepare('UPDATE discord_settings SET bot_token_enc=? WHERE id=1').run(encrypt(token));
  if (channelId !== undefined) db.prepare('UPDATE discord_settings SET channel_id=? WHERE id=1').run(channelId || null);
}

// Only paid deposits are ever queued (queued inside the credit transaction), so a log implies a committed credit.
async function processQueue(db, now = new Date()) {
  const cfg = getConfig(db);
  if (!cfg.token || !cfg.channelId) return { sent: 0, skipped: true };
  const rows = db.prepare("SELECT q.id AS qid,q.attempts AS qattempts,d.*,u.username FROM discord_queue q JOIN deposits d ON d.id=q.deposit_id JOIN users u ON u.id=d.user_id WHERE q.sent_at IS NULL AND q.attempts<10 AND (q.next_try_at IS NULL OR q.next_try_at<=?) AND d.status='paid'").all(fmt(now));
  let sent = 0;
  for (const r of rows) {
    const content = [`Deposit verified`, `User: ${r.username}`, `Transaction: ${r.transaction_id}`, `Requested: ₹${fromPaise(r.requested_paise)}`, `Paid: ₹${fromPaise(r.payable_paise)}`, `Method: FamPay UPI`, `Status: Verified`, `Time: ${r.credited_at} UTC`].join('\n');
    try {
      const res = await doFetch(`https://discord.com/api/v10/channels/${cfg.channelId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
      if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
      db.prepare('UPDATE discord_queue SET sent_at=? WHERE id=?').run(fmt(now), r.qid); sent++;
    } catch (e) {
      db.prepare('UPDATE discord_queue SET attempts=attempts+1,last_error=?,next_try_at=? WHERE id=?').run(String(e.message).slice(0, 200), fmt(addMs(now, 60000 * (r.qattempts + 1))), r.qid);
    }
  }
  return { sent };
}
module.exports = { processQueue, getConfig, saveConfig, setFetch };
