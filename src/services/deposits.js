'use strict';
const settings = require('./settings');
const wallet = require('./wallet');
const { allowedSenders } = require('../integrations/gmail');
const { fmt, parse, addMs } = require('../utils/time');

const FIRST_CHECK_MS = 10 * 60000, RETRY_MS = 90000, MANUAL_MIN_MS = 60000, GRACE_MS = 5 * 60000, SKEW_MS = 120000;

function evaluate(deposit, notifs, { usedUids, senders, requireAuth }) {
  const created = parse(deposit.created_at), expires = parse(deposit.expires_at);
  const ok = notifs.filter((n) => {
    if (!n.uid || usedUids.has(n.uid)) return false;
    if (!senders.includes(n.sender)) return false;
    if (requireAuth && !n.authPass) return false;
    if (n.amountPaise !== deposit.payable_paise) return false;
    if (!n.receivedAt) return false;
    const t = n.receivedAt.getTime();
    if (t < created - SKEW_MS || t > expires + GRACE_MS) return false;
    if (n.reference && n.reference !== deposit.transaction_id) return false;
    return true;
  });
  if (ok.length === 1) return { outcome: 'match', notif: ok[0] };
  if (ok.length > 1) return { outcome: 'ambiguous', notifs: ok };
  return { outcome: 'none' };
}

// Exactly-once credit: status flip guarded by status='pending', ledger row unique per deposit, notification uid unique.
function creditDeposit(db, deposit, notif, now = new Date()) {
  return db.transaction(() => {
    const prior = db.prepare('SELECT outcome FROM deposit_notifications WHERE message_uid=?').get(notif.uid);
    if (prior && prior.outcome === 'credited') return { credited: false, reason: 'notification_used' };
    const u = db.prepare("UPDATE deposits SET status='paid',notification_uid=?,verification_result='matched',credited_at=? WHERE id=? AND status='pending'")
      .run(notif.uid, fmt(now), deposit.id);
    if (u.changes !== 1) return { credited: false, reason: 'not_pending' };
    db.prepare("INSERT INTO deposit_notifications(message_uid,sender,amount_paise,received_at,outcome,deposit_id) VALUES(?,?,?,?, 'credited',?) ON CONFLICT(message_uid) DO UPDATE SET outcome='credited',deposit_id=excluded.deposit_id")
      .run(notif.uid, notif.sender, notif.amountPaise, fmt(notif.receivedAt), deposit.id);
    wallet.applyTx(db, { userId: deposit.user_id, type: 'deposit', amountPaise: deposit.requested_paise, refType: 'deposit', refId: deposit.transaction_id, reason: 'FamPay deposit' });
    db.prepare('INSERT OR IGNORE INTO discord_queue(deposit_id) VALUES(?)').run(deposit.id);
    return { credited: true };
  }).immediate();
}

function recordUnmatched(db, notifs) {
  const ins = db.prepare("INSERT OR IGNORE INTO deposit_notifications(message_uid,sender,amount_paise,received_at,outcome) VALUES(?,?,?,?, 'unmatched')");
  for (const n of notifs) if (n.uid) ins.run(n.uid, n.sender, n.amountPaise, n.receivedAt ? fmt(n.receivedAt) : null);
}

let chain = Promise.resolve();
const withLock = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

function dueDeposits(db, now, onlyId) {
  if (onlyId) return db.prepare("SELECT * FROM deposits WHERE id=? AND status='pending'").all(onlyId);
  return db.prepare("SELECT * FROM deposits WHERE status='pending'").all().filter((d) => {
    const exp = parse(d.expires_at) <= now.getTime();
    if (d.verification_attempts === 0 && !exp) return now.getTime() >= parse(d.created_at) + FIRST_CHECK_MS;
    if (!d.last_attempt_at) return true;
    return now.getTime() >= parse(d.last_attempt_at) + RETRY_MS;
  });
}

async function verifyDeposits(db, { fetcher, now = new Date(), onlyId = null } = {}) {
  const due = dueDeposits(db, now, onlyId);
  const summary = { checked: due.length, credited: 0, review: 0, expired: 0, error: null };
  if (!due.length) return summary;
  let notifs;
  try { notifs = await fetcher(db); } catch (e) {
    summary.error = e.message;
    for (const d of due) {
      db.prepare('UPDATE deposits SET verification_attempts=verification_attempts+1,last_attempt_at=?,verification_result=? WHERE id=?').run(fmt(now), 'fetch_error', d.id);
      db.prepare('INSERT INTO payment_verifications(deposit_id,result,detail) VALUES(?,?,?)').run(d.id, 'fetch_error', String(e.message).slice(0, 200));
    }
    return summary;
  }
  const used = new Set(db.prepare("SELECT message_uid u FROM deposit_notifications WHERE outcome='credited'").all().map((r) => r.u));
  const ctx = { usedUids: used, senders: allowedSenders(db), requireAuth: settings.get(db, 'require_dkim', '1') === '1' };
  recordUnmatched(db, notifs);
  for (const d of due) {
    const r = evaluate(d, notifs, ctx);
    db.prepare('UPDATE deposits SET verification_attempts=verification_attempts+1,last_attempt_at=? WHERE id=?').run(fmt(now), d.id);
    db.prepare('INSERT INTO payment_verifications(deposit_id,result) VALUES(?,?)').run(d.id, r.outcome);
    if (r.outcome === 'match') { if (creditDeposit(db, d, r.notif, now).credited) { summary.credited++; used.add(r.notif.uid); } }
    else if (r.outcome === 'ambiguous') {
      db.prepare("UPDATE deposits SET status='review',verification_result='ambiguous' WHERE id=? AND status='pending'").run(d.id); summary.review++;
    } else if (parse(d.expires_at) + GRACE_MS <= now.getTime()) {
      db.prepare("UPDATE deposits SET status='expired',verification_result='expired' WHERE id=? AND status='pending'").run(d.id); summary.expired++;
    }
  }
  return summary;
}

// Customer "Check Payment": backend-controlled, rate limited per deposit.
async function checkNow(db, { userId, transactionId, fetcher, now = new Date() }) {
  const d = db.prepare('SELECT * FROM deposits WHERE transaction_id=? AND user_id=?').get(transactionId, userId);
  if (!d) return { found: false };
  if (d.status !== 'pending') return { found: true, status: d.status };
  if (d.last_attempt_at && now.getTime() < parse(d.last_attempt_at) + MANUAL_MIN_MS) {
    return { found: true, status: 'pending', wait: Math.ceil((parse(d.last_attempt_at) + MANUAL_MIN_MS - now.getTime()) / 1000) };
  }
  await withLock(() => verifyDeposits(db, { fetcher, now, onlyId: d.id }));
  const after = db.prepare('SELECT status FROM deposits WHERE id=?').get(d.id);
  return { found: true, status: after.status };
}

function expireStale(db, now = new Date()) {
  // Safety net when the final verification pass could not run (e.g. Gmail unreachable for long).
  return db.prepare("UPDATE deposits SET status='expired',verification_result='expired' WHERE status='pending' AND expires_at<?").run(fmt(addMs(now, -GRACE_MS * 6))).changes;
}
module.exports = { evaluate, creditDeposit, verifyDeposits, checkNow, withLock, expireStale, FIRST_CHECK_MS, RETRY_MS, MANUAL_MIN_MS };
