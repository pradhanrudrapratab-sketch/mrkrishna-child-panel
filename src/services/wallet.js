'use strict';
class InsufficientFunds extends Error { constructor() { super('Insufficient wallet balance'); this.code = 'INSUFFICIENT_FUNDS'; } }
class DuplicateOperation extends Error { constructor() { super('Operation already processed'); this.code = 'DUPLICATE'; } }

function ensureWallet(db, userId) { db.prepare('INSERT OR IGNORE INTO customer_wallets(user_id) VALUES(?)').run(userId); }
function balance(db, userId) { const r = db.prepare('SELECT balance_paise b FROM customer_wallets WHERE user_id=?').get(userId); return r ? r.b : 0; }

// amountPaise is signed. Every balance change writes a ledger row in the same transaction.
function applyTx(db, { userId, type, amountPaise, refType = null, refId = null, reason = null }) {
  if (!Number.isInteger(amountPaise) || amountPaise === 0) throw new Error('Invalid amount');
  return db.transaction(() => {
    const w = db.prepare('SELECT balance_paise b FROM customer_wallets WHERE user_id=?').get(userId);
    if (!w) throw new Error('Wallet not found');
    const nb = w.b + amountPaise;
    if (nb < 0) throw new InsufficientFunds();
    try {
      db.prepare('INSERT INTO customer_transactions(user_id,type,amount_paise,balance_after_paise,ref_type,ref_id,reason) VALUES(?,?,?,?,?,?,?)')
        .run(userId, type, amountPaise, nb, refType, refId, reason);
    } catch (e) { if (/UNIQUE/i.test(e.message)) throw new DuplicateOperation(); throw e; }
    db.prepare('UPDATE customer_wallets SET balance_paise=? WHERE user_id=?').run(nb, userId);
    return { balanceAfter: nb };
  })();
}
module.exports = { applyTx, ensureWallet, balance, InsufficientFunds, DuplicateOperation };
