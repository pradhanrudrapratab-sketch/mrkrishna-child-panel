'use strict';
const { newTransactionId } = require('../utils/txid');
const { fmt, addMs } = require('../utils/time');

// Unique payable amount: start at the requested amount and add 1 paisa until it is free among pending deposits.
// Runs in one IMMEDIATE transaction; partial unique index uq_active_payable is the final guard.
function createDeposit(db, { userId, requestedPaise, upiId, expiresMinutes = 30, now = new Date() }) {
  if (!Number.isInteger(requestedPaise) || requestedPaise <= 0) throw new Error('Invalid amount');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return db.transaction(() => {
        const taken = new Set(db.prepare("SELECT payable_paise p FROM deposits WHERE status='pending'").all().map((r) => r.p));
        let payable = requestedPaise;
        while (taken.has(payable)) payable += 1;
        const transactionId = newTransactionId(now);
        db.prepare("INSERT INTO deposits(transaction_id,user_id,requested_paise,payable_paise,owner_upi_snapshot,status,expires_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)")
          .run(transactionId, userId, requestedPaise, payable, upiId, fmt(addMs(now, expiresMinutes * 60000)), fmt(now));
        return { transactionId, requestedPaise, payablePaise: payable };
      }).immediate();
    } catch (e) { if (!/UNIQUE/i.test(e.message)) throw e; }
  }
  throw new Error('Could not allocate a unique amount, try again');
}
module.exports = { createDeposit };
