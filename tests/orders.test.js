'use strict';
const test = require('node:test'); const assert = require('node:assert');
const h = require('./helpers');
const orders = require('../src/services/orders');
const wallet = require('../src/services/wallet');
const catalog = require('../src/services/catalog');
const { ParentError } = require('../src/integrations/parentClient');

const setup = (funds = 5000) => { const db = h.freshDb(); const uid = h.user(db, 'alice', funds); const svc = h.seedService(db); return { db, uid, svc }; };
const place = (db, uid, svc, q = 1000) => orders.placeOrder(db, { userId: uid, serviceId: svc.id, link: 'https://instagram.com/x', quantity: q });
const st = (db) => db.prepare('SELECT * FROM orders').get();

test('retail price uses 30% markup, rounded up, and debits atomically', () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc);
  assert.equal(o.retailPaise, 1690); assert.equal(wallet.balance(db, uid), 5000 - 1690); assert.equal(st(db).status, 'pending');
});
test('insufficient balance leaves no order and no debit', () => {
  const { db, uid, svc } = setup(100); assert.throws(() => place(db, uid, svc), /Insufficient/);
  assert.equal(db.prepare('SELECT count(*) c FROM orders').get().c, 0); assert.equal(wallet.balance(db, uid), 100);
});
test('quantity limits and bad links rejected', () => {
  const { db, uid, svc } = setup();
  assert.throws(() => place(db, uid, svc, 5), /between/); assert.throws(() => orders.placeOrder(db, { userId: uid, serviceId: svc.id, link: 'javascript:alert(1)', quantity: 1000 }), /valid link/);
});
test('submit success records parent id and wholesale cost', async () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc); let sent;
  await orders.submitOrder(db, { createOrder: async (b) => { sent = b; return { order: { id: 4812, status: 'in_progress', charge: '13.00' }, duplicate: false, balance: '987.00' }; } }, o.id);
  assert.equal(sent.reference, o.reference); assert.equal(sent.service, 7); assert.equal(st(db).parent_order_id, '4812'); assert.equal(st(db).wholesale_paise, 1300); assert.equal(st(db).status, 'in_progress');
});
test('unrecognized parent response is not reported as success', async () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc);
  await orders.submitOrder(db, { createOrder: async () => ({ ok: true }) }, o.id); assert.equal(st(db).status, 'awaiting_admin'); assert.equal(st(db).parent_order_id, null);
});
test('parent low balance keeps order and funds, then retries with the same reference', async () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc);
  await orders.submitOrder(db, { createOrder: async () => { throw new ParentError('insufficient', 402, 'low'); } }, o.id);
  assert.equal(st(db).status, 'awaiting_admin'); assert.equal(wallet.balance(db, uid), 5000 - 1690);
  db.prepare("UPDATE orders SET status='pending'").run(); let ref;
  await orders.submitOrder(db, { findOrderByReference: async () => ({ orders: [] }), createOrder: async (b) => { ref = b.reference; return { order: { id: 'P2', status: 'pending' } }; } }, o.id);
  assert.equal(ref, o.reference); assert.equal(st(db).parent_order_id, 'P2'); assert.equal(db.prepare('SELECT count(*) c FROM customer_transactions WHERE type=?').get('order_debit').c, 1);
});
test('timeout: next attempt looks up by reference and never double-submits', async () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc);
  await orders.submitOrder(db, { createOrder: async () => { throw new ParentError('timeout', 0, 'timed out'); } }, o.id); assert.equal(st(db).status, 'pending');
  let created = 0;
  await orders.submitOrder(db, { findOrderByReference: async (r) => ({ orders: [{ id: 'P9', reference: r, status: 'in_progress' }] }), createOrder: async () => { created++; return { id: 'X' }; } }, o.id);
  assert.equal(created, 0); assert.equal(st(db).parent_order_id, 'P9');
});
test('lookup says order not found: resubmit with the SAME reference (parent treats it as idempotency key)', async () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc); db.prepare('UPDATE orders SET submit_attempts=1').run(); let ref;
  await orders.submitOrder(db, { findOrderByReference: async () => { throw new ParentError('notfound', 404, 'nope'); }, createOrder: async (b) => { ref = b.reference; return { order: { id: 'X1' } }; } }, o.id);
  assert.equal(ref, o.reference); assert.equal(st(db).parent_order_id, 'X1');
});
test('unexpected lookup failure goes to admin instead of blind retry', async () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc); db.prepare('UPDATE orders SET submit_attempts=1').run(); let created = 0;
  await orders.submitOrder(db, { findOrderByReference: async () => { throw new ParentError('forbidden', 403, 'no'); }, createOrder: async () => { created++; return { id: 'X' }; } }, o.id);
  assert.equal(created, 0); assert.equal(st(db).status, 'awaiting_admin');
});
test('reference conflict (409 idempotency_conflict) goes to admin', async () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc);
  await orders.submitOrder(db, { createOrder: async () => { throw new ParentError('conflict', 409, 'x', undefined, 'idempotency_conflict'); } }, o.id); assert.equal(st(db).status, 'awaiting_admin'); assert.equal(wallet.balance(db, uid), 5000 - 1690);
});
test('definitive parent rejection refunds the customer exactly once', async () => {
  const { db, uid, svc } = setup(); const o = place(db, uid, svc);
  await orders.submitOrder(db, { createOrder: async () => { throw new ParentError('invalid', 400, 'bad link'); } }, o.id);
  assert.equal(wallet.balance(db, uid), 5000); assert.equal(st(db).status, 'refunded'); assert.equal(orders.refundOrder(db, o.id, 1690, 'again').refunded, false); assert.equal(wallet.balance(db, uid), 5000);
});
const live = (db, uid, svc) => { const o = place(db, uid, svc); db.prepare("UPDATE orders SET parent_order_id='P1',status='in_progress',wholesale_paise=1300").run(); return o; };
test('status polling updates and stops polling final orders', async () => {
  const { db, uid, svc } = setup(); const o = live(db, uid, svc);
  await orders.pollOrder(db, { getOrder: async () => ({ order: { status: 'in_progress' } }) }, o.id); assert.equal(st(db).status, 'in_progress'); assert.ok(st(db).next_poll_at);
  await orders.pollOrder(db, { getOrder: async () => ({ order: { status: 'completed' } }) }, o.id); assert.equal(st(db).status, 'completed'); assert.equal(st(db).next_poll_at, null);
  assert.equal(orders.dueForWork(db, new Date(Date.now() + 1e9)).length, 0);
});
test('partial order refunds proportionally, once', async () => {
  const { db, uid, svc } = setup(); const o = live(db, uid, svc); const c = { getOrder: async () => ({ order: { status: 'partial', refund_amount: '3.25', refunded: false } }) };
  await orders.pollOrder(db, c, o.id); await orders.pollOrder(db, c, o.id);
  assert.equal(st(db).refunded_paise, 422); assert.equal(wallet.balance(db, uid), 5000 - 1690 + 422); assert.equal(st(db).status, 'partial');
});
test('parent failed does not auto-refund', async () => {
  const { db, uid, svc } = setup(); const o = live(db, uid, svc); await orders.pollOrder(db, { getOrder: async () => ({ order: { status: 'failed' } }) }, o.id);
  assert.equal(st(db).status, 'failed'); assert.equal(wallet.balance(db, uid), 5000 - 1690);
  assert.equal(orders.refundOrder(db, o.id, 1690, 'admin').refunded, true); assert.equal(wallet.balance(db, uid), 5000);
});
test('canceled refunds only when parent confirms funds returned', async () => {
  const { db, uid, svc } = setup(); const o = live(db, uid, svc); await orders.pollOrder(db, { getOrder: async () => ({ order: { status: 'canceled', refunded: false } }) }, o.id);
  assert.equal(wallet.balance(db, uid), 5000 - 1690);
  db.prepare("UPDATE orders SET status='in_progress'").run(); await orders.pollOrder(db, { getOrder: async () => ({ order: { status: 'canceled', refunded: true, refund_amount: '13.00' } }) }, o.id); assert.equal(wallet.balance(db, uid), 5000);
});
test('partial without refund details falls back to remains, else waits for admin', async () => {
  const { db, uid, svc } = setup(); const o = live(db, uid, svc);
  await orders.pollOrder(db, { getOrder: async () => ({ order: { status: 'partial', remains: 250 } }) }, o.id); assert.equal(st(db).refunded_paise, 422);
  db.prepare("UPDATE orders SET refunded_paise=0,status='in_progress'").run(); db.prepare('DELETE FROM customer_transactions WHERE type=?').run('refund');
  await orders.pollOrder(db, { getOrder: async () => ({ order: { status: 'partial' } }) }, o.id); assert.equal(st(db).refunded_paise, 0);
});
test('parent status refunded refunds the customer in full, once', async () => {
  const { db, uid, svc } = setup(); const o = live(db, uid, svc); const c = { getOrder: async () => ({ order: { status: 'refunded', refunded: true, refund_amount: '13.00' } }) };
  await orders.pollOrder(db, c, o.id); await orders.pollOrder(db, c, o.id); assert.equal(wallet.balance(db, uid), 5000); assert.equal(st(db).status, 'refunded');
});
test('per-service markup, custom rate, disabled service, hidden wholesale', () => {
  const { db, svc } = setup(); db.prepare('UPDATE services SET markup_bp=5000 WHERE id=?').run(svc.id);
  let pub = catalog.publicServices(db); assert.equal(pub[0].rate, '19.50'); assert.equal(JSON.stringify(pub).includes('wholesale'), false); assert.equal(pub[0].parentId, undefined);
  db.prepare('UPDATE services SET enabled=0').run(); assert.equal(catalog.publicServices(db).length, 0);
});
test('service sync marks missing services unavailable, keeps history, refuses empty payload', () => {
  const { db, uid, svc } = setup(); place(db, uid, svc);
  const r = catalog.syncServices(db, { services: [{ id: 8, name: 'Other', category: 'Telegram', platform: 'telegram', type: 'Default', rate: '5.0000' }, { id: 9, name: 'Poll', category: 'X', type: 'Poll', rate: '1.0000' }] });
  assert.equal(r.skippedUnsupportedType, 1); assert.equal(db.prepare('SELECT count(*) c FROM services WHERE parent_service_id=?').get('9').c, 0);
  assert.equal(db.prepare('SELECT available FROM services WHERE parent_service_id=?').get('7').available, 0); assert.equal(db.prepare('SELECT count(*) c FROM orders').get().c, 1);
  assert.throws(() => catalog.syncServices(db, []), /no usable/); assert.equal(db.prepare('SELECT available FROM services WHERE parent_service_id=?').get('8').available, 1);
});
