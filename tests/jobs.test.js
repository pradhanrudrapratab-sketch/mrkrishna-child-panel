'use strict';
const test = require('node:test'); const assert = require('node:assert');
const h = require('./helpers');
const refills = require('../src/services/refills');
const jobs = require('../src/jobs');
const alloc = require('../src/services/allocation');
const wallet = require('../src/services/wallet');
const pc = require('../src/integrations/parentClient'); const { ParentError } = pc;

test('refill: created pending, completed only on parent confirmation, duplicate verify is a no-op', async () => {
  const db = h.freshDb(); let verifies = 0;
  const client = { refillCreate: async (b) => { assert.equal(b.amount, '500.00'); assert.match(b.reference, /^[A-Za-z0-9._:-]{1,64}$/); return { duplicate: false, refill: { transaction_id: 'T1', status: 'pending', amount: '500.00', payable_amount: '500.00', payment_url: 'https://pay.test/x', qr_url: 'https://pay.test/qr', expires_at: '2099-01-01' } }; }, refillVerify: async () => { verifies++; return { credited: true, balance: '1500.00', refill: { transaction_id: 'T1', status: 'completed' } }; } };
  const r = await refills.createRefill(db, client, '500'); assert.equal(r.status, 'pending'); assert.equal(r.payment_url, 'https://pay.test/x'); assert.equal(r.payable_paise, 50000);
  const done = await refills.verifyRefill(db, client, r.id); assert.equal(done.status, 'completed'); await refills.verifyRefill(db, client, r.id); assert.equal(verifies, 1);
});
test('refill: pending stays pending; gateway failure is recorded', async () => {
  const db = h.freshDb(); const r = await refills.createRefill(db, { refillCreate: async () => ({ refill: { transaction_id: 'T2' } }) }, '100');
  assert.equal((await refills.verifyRefill(db, { refillVerify: async () => ({ credited: false, refill: { status: 'pending' } }) }, r.id)).status, 'pending');
  await assert.rejects(() => refills.verifyRefill(db, { refillVerify: async () => { throw new ParentError('upstream', 502, 'gw', undefined, 'gateway_unavailable'); } }, r.id));
  assert.equal(db.prepare('SELECT status FROM parent_refills WHERE id=?').get(r.id).status, 'pending');
  await assert.rejects(() => refills.createRefill(db, { refillCreate: async () => { throw new Error('down'); } }, '100'));
  assert.equal(db.prepare("SELECT count(*) c FROM parent_refills WHERE status='gateway_unavailable'").get().c, 1);
});
test('refill: 410 expired and 409 failed are recorded; a failed refill is never completed', async () => {
  const db = h.freshDb(); const mk = async (t) => refills.createRefill(db, { refillCreate: async () => ({ refill: { transaction_id: t } }) }, '50');
  const a = await mk('E1'); const b = await mk('F1');
  assert.equal((await refills.verifyRefill(db, { refillVerify: async () => { throw new ParentError('expired', 410, 'x', undefined, 'transaction_expired'); } }, a.id)).status, 'expired');
  assert.equal((await refills.verifyRefill(db, { refillVerify: async () => { throw new ParentError('conflict', 409, 'x', undefined, 'transaction_failed'); } }, b.id)).status, 'failed');
});
test('jobs catch up overdue deposit verification after a restart/sleep', async () => {
  const db = h.freshDb(); h.configurePayments(db); const uid = h.user(db); const t0 = new Date(Date.now() - 3 * 3600000);
  alloc.createDeposit(db, { userId: uid, requestedPaise: 10000, upiId: 'o@f', now: t0, expiresMinutes: 600 });
  const n = h.notif({ amountPaise: 10000, receivedAt: new Date(t0.getTime() + 120000) });
  const out = await jobs.runOnce({ db }, { fetcher: async () => [n] });
  assert.equal(out.deposits.credited, 1); assert.equal(wallet.balance(db, uid), 10000); assert.ok(require('../src/services/settings').get(db, 'last_job_run'));
  const again = await jobs.runOnce({ db }, { fetcher: async () => [n] }); assert.equal(wallet.balance(db, uid), 10000); assert.ok(again);
});
test('jobs skip parent work while disconnected', async () => {
  const db = h.freshDb(); const out = await jobs.runOnce({ db }, { fetcher: async () => [] }); assert.equal(out.orders, undefined); assert.equal(pc.getConn(db).api_verified, 0);
});
