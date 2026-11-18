'use strict';
const crypto = require('crypto');
const { pick } = require('../integrations/parentClient');
const { toPaise, fromPaise } = require('../utils/money');
const { fmt } = require('../utils/time');


const STATUS = { pending: 'pending', created: 'pending', completed: 'completed', complete: 'completed', success: 'completed', paid: 'completed', expired: 'expired', failed: 'failed' };
const rf = (res) => pick(res, 'refill', 'data.refill') || res || {};
const safe = (v) => { try { return v === undefined || v === null ? null : toPaise(String(v)); } catch { return null; } };

// Parent wallet refill. Entirely separate from customer deposits; marked completed ONLY after the parent confirms.
async function createRefill(db, client, amountRupees) {
  const amountPaise = toPaise(amountRupees);
  if (amountPaise <= 0) throw new Error('Invalid amount');
  const reference = `REFILL-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`; // letters, digits and - only
  db.prepare("INSERT INTO parent_refills(reference,amount_paise,status) VALUES(?,?, 'pending')").run(reference, amountPaise);
  try {
    const res = await client.refillCreate({ amount: fromPaise(amountPaise), reference });
    const r = rf(res); const txn = r.transaction_id ?? r.id;
    db.prepare('UPDATE parent_refills SET parent_txn_id=?,payable_paise=?,payment_url=?,qr_url=?,expires_at=?,raw=? WHERE reference=?')
      .run(txn === undefined ? null : String(txn), safe(r.payable_amount), r.payment_url ?? null, r.qr_url ?? null, r.expires_at ?? null, JSON.stringify(r).slice(0, 2000), reference);
  } catch (e) {
    db.prepare("UPDATE parent_refills SET status='gateway_unavailable',raw=? WHERE reference=?").run(String(e.message).slice(0, 200), reference);
    throw e;
  }
  return db.prepare('SELECT * FROM parent_refills WHERE reference=?').get(reference);
}

const FINAL = ['completed', 'expired', 'failed'];
async function verifyRefill(db, client, id) {
  const r = db.prepare('SELECT * FROM parent_refills WHERE id=?').get(id);
  if (!r || FINAL.includes(r.status)) return r; // duplicate verification is a no-op
  if (!r.parent_txn_id) throw new Error('Refill has no parent transaction id');
  let status = null;
  try {
    const res = await client.refillVerify({ transaction_id: r.parent_txn_id });
    status = STATUS[String(rf(res).status || '').toLowerCase()] || null; // 200 pending or completed (parent credits once)
  } catch (e) {
    if (e.kind === 'expired') status = 'expired'; // 410 transaction_expired
    else if (e.kind === 'conflict') status = 'failed'; // 409 transaction_failed
    else throw e; // 502 gateway_unavailable etc: stay pending, retry later
  }
  db.prepare(`UPDATE parent_refills SET status=COALESCE(?,status),last_checked_at=? WHERE id=? AND status NOT IN ('completed','expired','failed')`).run(status, fmt(), id);
  return db.prepare('SELECT * FROM parent_refills WHERE id=?').get(id);
}
module.exports = { createRefill, verifyRefill };
