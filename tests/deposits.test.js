'use strict';
const test = require('node:test'); const assert = require('node:assert');
const h = require('./helpers');
const alloc = require('../src/services/allocation');
const dep = require('../src/services/deposits');
const wallet = require('../src/services/wallet');
const discord = require('../src/integrations/discord');
const { parseNotification } = require('../src/integrations/gmail');

const setup = () => { const db = h.freshDb(); h.configurePayments(db); return { db, uid: h.user(db) }; };
const mk = (db, uid, paise, now) => alloc.createDeposit(db, { userId: uid, requestedPaise: paise, upiId: 'owner@fam', now });

test('unique payable amounts increment by 1 paisa', () => {
  const { db, uid } = setup(); const u2 = h.user(db, 'bob'); const u3 = h.user(db, 'cara');
  assert.deepEqual([mk(db, uid, 10000), mk(db, u2, 10000), mk(db, u3, 10000)].map((d) => d.payablePaise), [10000, 10001, 10002]);
});
test('DB unique index blocks duplicate pending payable amounts', () => {
  const { db, uid } = setup(); mk(db, uid, 5000);
  assert.throws(() => db.prepare("INSERT INTO deposits(transaction_id,user_id,requested_paise,payable_paise,owner_upi_snapshot,expires_at) VALUES('X',?,5000,5000,'o','2099-01-01 00:00:00')").run(uid), /UNIQUE/);
});
test('freed amount is reusable after the deposit leaves pending', () => {
  const { db, uid } = setup(); const a = mk(db, uid, 5000); db.prepare("UPDATE deposits SET status='expired'").run();
  assert.equal(mk(db, uid, 5000).payablePaise, 5000); assert.ok(a);
});
test('verified payment credits exactly once and replay is ignored', async () => {
  const { db, uid } = setup(); const t0 = new Date(); const d = mk(db, uid, 10000, t0);
  const n = h.notif({ amountPaise: 10000, receivedAt: new Date(t0.getTime() + 60000) });
  const later = new Date(t0.getTime() + 11 * 60000);
  const r1 = await dep.verifyDeposits(db, { fetcher: async () => [n], now: later });
  assert.equal(r1.credited, 1); assert.equal(wallet.balance(db, uid), 10000);
  const r2 = await dep.verifyDeposits(db, { fetcher: async () => [n], now: new Date(later.getTime() + 120000) });
  assert.equal(r2.credited, 0); assert.equal(wallet.balance(db, uid), 10000);
  // same email can't pay a second deposit either
  const d2 = mk(db, uid, 10000, new Date(later.getTime() + 1000));
  const r3 = await dep.verifyDeposits(db, { fetcher: async () => [n], now: new Date(later.getTime() + 11 * 60000 + 5000) });
  assert.equal(r3.credited, 0); assert.equal(wallet.balance(db, uid), 10000); assert.ok(d && d2);
});
test('creditDeposit called twice credits once', () => {
  const { db, uid } = setup(); const d = mk(db, uid, 10000); const row = db.prepare('SELECT * FROM deposits').get(); const n = h.notif();
  assert.equal(dep.creditDeposit(db, row, n).credited, true); assert.equal(dep.creditDeposit(db, row, n).credited, false);
  assert.equal(wallet.balance(db, uid), 10000); assert.ok(d);
});
test('wrong amount, wrong sender, unsigned or early email are rejected', async () => {
  const { db, uid } = setup(); const t0 = new Date(); mk(db, uid, 10000, t0); const now = new Date(t0.getTime() + 11 * 60000);
  const bads = [h.notif({ amountPaise: 10001 }), h.notif({ sender: 'evil@example.com' }), h.notif({ authPass: false }), h.notif({ receivedAt: new Date(t0.getTime() - 3600000) }), h.notif({ reference: 'MKP01012026ZZZZ' })];
  const r = await dep.verifyDeposits(db, { fetcher: async () => bads, now }); assert.equal(r.credited, 0); assert.equal(wallet.balance(db, uid), 0);
});
test('ambiguous notifications go to review, no credit', async () => {
  const { db, uid } = setup(); const t0 = new Date(); mk(db, uid, 10000, t0);
  const r = await dep.verifyDeposits(db, { fetcher: async () => [h.notif(), h.notif()], now: new Date(t0.getTime() + 11 * 60000) });
  assert.equal(r.review, 1); assert.equal(db.prepare('SELECT status FROM deposits').get().status, 'review'); assert.equal(wallet.balance(db, uid), 0);
});
test('no check before 10 minutes; retry spacing; expiry without payment', async () => {
  const { db, uid } = setup(); const t0 = new Date(); mk(db, uid, 10000, t0); let calls = 0; const f = async () => { calls++; return []; };
  await dep.verifyDeposits(db, { fetcher: f, now: new Date(t0.getTime() + 5 * 60000) }); assert.equal(calls, 0);
  await dep.verifyDeposits(db, { fetcher: f, now: new Date(t0.getTime() + 10 * 60000) }); assert.equal(calls, 1);
  await dep.verifyDeposits(db, { fetcher: f, now: new Date(t0.getTime() + 10 * 60000 + 30000) }); assert.equal(calls, 1);
  await dep.verifyDeposits(db, { fetcher: f, now: new Date(t0.getTime() + 10 * 60000 + 91000) }); assert.equal(calls, 2);
  await dep.verifyDeposits(db, { fetcher: f, now: new Date(t0.getTime() + 36 * 60000) });
  assert.equal(db.prepare('SELECT status FROM deposits').get().status, 'expired'); assert.equal(wallet.balance(db, uid), 0);
});
test('manual check is rate limited and never creates a deposit', async () => {
  const { db, uid } = setup(); const d = mk(db, uid, 10000); let calls = 0; const f = async () => { calls++; return []; };
  const a = await dep.checkNow(db, { userId: uid, transactionId: d.transactionId, fetcher: f }); assert.equal(a.status, 'pending');
  const b = await dep.checkNow(db, { userId: uid, transactionId: d.transactionId, fetcher: f }); assert.ok(b.wait > 0); assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM deposits').get().c, 1);
});
test("a customer cannot check another customer's deposit", async () => {
  const { db, uid } = setup(); const other = h.user(db, 'mallory'); const d = mk(db, uid, 10000);
  assert.equal((await dep.checkNow(db, { userId: other, transactionId: d.transactionId, fetcher: async () => [] })).found, false);
});
test('Gmail fetch failure leaves deposit pending', async () => {
  const { db, uid } = setup(); const t0 = new Date(); mk(db, uid, 10000, t0);
  const r = await dep.verifyDeposits(db, { fetcher: async () => { throw new Error('imap down'); }, now: new Date(t0.getTime() + 11 * 60000) });
  assert.equal(r.error, 'imap down'); assert.equal(db.prepare('SELECT status FROM deposits').get().status, 'pending');
});
test('Discord failure never reverses a credit; retry succeeds later', async () => {
  const { db, uid } = setup(); mk(db, uid, 10000); dep.creditDeposit(db, db.prepare('SELECT * FROM deposits').get(), h.notif());
  discord.saveConfig(db, { token: 'tok', channelId: '123456789' });
  discord.setFetch(async () => ({ ok: false, status: 500 })); assert.equal((await discord.processQueue(db)).sent, 0);
  assert.equal(wallet.balance(db, uid), 10000); assert.equal(db.prepare('SELECT status FROM deposits').get().status, 'paid');
  let body; discord.setFetch(async (u, o) => { body = JSON.parse(o.body); return { ok: true }; });
  assert.equal((await discord.processQueue(db, new Date(Date.now() + 3600000))).sent, 1); assert.match(body.content, /alice/); assert.match(body.content, /MKP/);
});
test('unpaid deposits are never logged to Discord', async () => {
  const { db, uid } = setup(); mk(db, uid, 10000); db.prepare('INSERT INTO discord_queue(deposit_id) VALUES(1)').run();
  discord.saveConfig(db, { token: 'tok', channelId: '123456789' }); let called = false; discord.setFetch(async () => { called = true; return { ok: true }; });
  await discord.processQueue(db); assert.equal(called, false);
});
test('notification parser', () => {
  const p = parseNotification({ fromAddress: 'No-Reply@FamPay.test', subject: 'Payment', text: 'You have received ₹1,250.50 from someone', headers: { 'authentication-results': 'mx; dkim=pass' }, messageId: '<a@b>', date: new Date() });
  assert.equal(p.amountPaise, 125050); assert.equal(p.sender, 'no-reply@fampay.test'); assert.equal(p.authPass, true);
  assert.equal(parseNotification({ text: 'Offer: ₹10 off, spend ₹500' }).amountPaise, null);
});
