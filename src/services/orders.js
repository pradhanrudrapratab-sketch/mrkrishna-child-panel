'use strict';
const crypto = require('crypto');
const wallet = require('./wallet');
const { effectiveRate, globalMarkupBp } = require('./catalog');
const { orderCostPaise, toPaise } = require('../utils/money');
const { fmt, addMs, parse } = require('../utils/time');
const { pick } = require('../integrations/parentClient');

const POLL_MS = 3 * 60000, MAX_SUBMIT_ATTEMPTS = 5;
const FINAL = ['completed', 'canceled', 'refunded'];
const event = (db, id, ev, detail) => db.prepare('INSERT INTO order_events(order_id,event,detail) VALUES(?,?,?)').run(id, ev, detail ? String(detail).slice(0, 300) : null);
const setStatus = (db, id, status, extra = {}) => {
  const k = Object.keys(extra);
  db.prepare(`UPDATE orders SET status=?,updated_at=?${k.map((x) => `,${x}=?`).join('')} WHERE id=?`).run(status, fmt(), ...k.map((x) => extra[x]), id);
};

function validLink(l) { try { const u = new URL(String(l).trim()); return (u.protocol === 'https:' || u.protocol === 'http:') && String(l).length <= 500; } catch { return false; } }

// Order row is committed (with its unique reference) together with the wallet debit BEFORE any parent request.
function placeOrder(db, { userId, serviceId, link, quantity, now = new Date() }) {
  if (!validLink(link)) throw Object.assign(new Error('Enter a valid link'), { code: 'VALIDATION' });
  if (!Number.isInteger(quantity) || quantity <= 0) throw Object.assign(new Error('Enter a valid quantity'), { code: 'VALIDATION' });
  const reference = `ORD${fmt(now).slice(0, 10).replace(/-/g, '')}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  return db.transaction(() => {
    const svc = db.prepare('SELECT * FROM services WHERE id=?').get(serviceId);
    if (!svc || !svc.enabled || !svc.available) throw Object.assign(new Error('Service is not available'), { code: 'VALIDATION' });
    if (quantity < svc.min_qty || quantity > svc.max_qty) throw Object.assign(new Error(`Quantity must be between ${svc.min_qty} and ${svc.max_qty}`), { code: 'VALIDATION' });
    const cost = orderCostPaise(effectiveRate(svc, globalMarkupBp(db)), quantity);
    const r = db.prepare("INSERT INTO orders(reference,user_id,service_id,link,quantity,retail_paise,status,created_at) VALUES(?,?,?,?,?,?, 'pending',?)").run(reference, userId, serviceId, String(link).trim(), quantity, cost, fmt(now));
    const id = Number(r.lastInsertRowid);
    wallet.applyTx(db, { userId, type: 'order_debit', amountPaise: -cost, refType: 'order', refId: reference, reason: 'Order placed' });
    event(db, id, 'created', `charged ${cost} paise`);
    return { id, reference, retailPaise: cost };
  }).immediate();
}

function refundOrder(db, orderId, amountPaise, reason) {
  return db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o) throw new Error('Order not found');
    if (o.refunded_paise > 0) return { refunded: false, reason: 'already_refunded' };
    if (!Number.isInteger(amountPaise) || amountPaise <= 0 || amountPaise > o.retail_paise) throw new Error('Invalid refund amount');
    try { wallet.applyTx(db, { userId: o.user_id, type: 'refund', amountPaise, refType: 'order_refund', refId: String(o.id), reason }); }
    catch (e) { if (e.code === 'DUPLICATE') return { refunded: false, reason: 'already_refunded' }; throw e; }
    db.prepare('UPDATE orders SET refunded_paise=?,updated_at=? WHERE id=?').run(amountPaise, fmt(), o.id);
    if (amountPaise === o.retail_paise) db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(o.id);
    event(db, o.id, 'refunded', `${amountPaise} paise: ${reason}`);
    return { refunded: true, amountPaise };
  }).immediate();
}

const extractId = (res) => { const v = pick(res, 'order.id', 'data.order.id', 'data.id', 'order_id', 'id'); return v === undefined || v === null || typeof v === 'object' ? null : String(v); };
const orderOf = (res) => pick(res, 'order', 'data.order') || res || {};
const safePaise = (v) => { try { return v === undefined || v === null ? 0 : toPaise(String(v)); } catch { return 0; } };

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]/g, '');
// Documented parent statuses: pending, in_progress, completed, partial, canceled (not refunded), failed (charge stays), refunded.
const MAP = { pending: 'pending', inqueue: 'pending', queued: 'pending', processing: 'in_progress', inprogress: 'in_progress', running: 'in_progress',
  completed: 'completed', complete: 'completed', success: 'completed', partial: 'partial', canceled: 'canceled', cancelled: 'canceled',
  failed: 'failed', error: 'failed', rejected: 'failed', refunded: 'refunded' };

function adopt(db, order, svc, res, now) {
  const ord = orderOf(res); const parentId = extractId(res);
  const status = MAP[norm(ord.status)] || 'pending';
  const charge = safePaise(ord.charge); // actual wholesale charge reported by the parent
  const wholesale = charge > 0 ? charge : orderCostPaise(svc.wholesale_paise_per_1000, order.quantity);
  setStatus(db, order.id, status, { parent_order_id: parentId, parent_status: String(ord.status || '').slice(0, 40) || null, wholesale_paise: wholesale, next_poll_at: ['pending', 'in_progress'].includes(status) ? fmt(addMs(now, POLL_MS)) : null, last_error: null });
  event(db, order.id, 'submitted', `parent order ${parentId}${res && res.duplicate ? ' (duplicate reference, existing order adopted)' : ''}`);
}

// The parent treats `reference` as an idempotency key, so repeating the SAME reference can never create a second order.
async function submitOrder(db, client, orderId, now = new Date()) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o || o.parent_order_id || !['pending', 'awaiting_admin'].includes(o.status)) return { skipped: true };
  const svc = db.prepare('SELECT * FROM services WHERE id=?').get(o.service_id);
  const hold = (reason, status = 'awaiting_admin') => { setStatus(db, o.id, status, { last_error: reason }); event(db, o.id, status === 'awaiting_admin' ? 'awaiting_admin' : 'retry_later', reason); return { status }; };
  try {
    if (o.submit_attempts > 0) { // an earlier attempt may have reached the parent: check by reference first
      try {
        const r = await client.findOrderByReference(o.reference);
        const arr = Array.isArray(r) ? r : pick(r, 'orders', 'data.orders', 'data'); const list = Array.isArray(arr) ? arr : (r && r.order ? [r.order] : []);
        const found = list.find((x) => x && (!x.reference || x.reference === o.reference));
        if (found && extractId(found)) { adopt(db, o, svc, { order: found }, now); return { status: db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status }; }
      } catch (e) {
        if (['ratelimit', 'upstream', 'timeout', 'network'].includes(e.kind)) return hold(`lookup failed: ${e.message}`, 'pending');
        if (e.kind !== 'notfound') return hold(`cannot confirm earlier attempt: ${e.message}`);
        // notfound: the parent has no such order, and resubmitting the same reference is safe (idempotent)
      }
    }
    db.prepare('UPDATE orders SET submit_attempts=submit_attempts+1 WHERE id=?').run(o.id);
    const res = await client.createOrder({ service: /^\d+$/.test(svc.parent_service_id) ? Number(svc.parent_service_id) : svc.parent_service_id, link: o.link, quantity: o.quantity, reference: o.reference });
    if (!extractId(res)) return hold('Parent response did not contain an order id; needs manual check');
    adopt(db, o, svc, res, now); return { status: db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status };
  } catch (e) {
    const k = e.kind;
    if (['disabled', 'reauth', 'insufficient'].includes(k)) return hold(k === 'insufficient' ? 'Parent wallet balance is too low' : k === 'reauth' ? 'Parent connection needs reauthorization' : 'Parent connection is not active');
    if (k === 'forbidden' && e.code === 'account_suspended') return hold('Parent reseller account is suspended');
    if (k === 'conflict') return hold('Parent reports this reference was used with different details');
    if (['invalid', 'forbidden', 'notfound', 'expired'].includes(k)) {
      setStatus(db, o.id, 'failed', { last_error: e.message }); event(db, o.id, 'rejected', `${k}: ${e.message}`);
      refundOrder(db, o.id, o.retail_paise, 'Order rejected by supplier'); return { status: 'failed' }; // never accepted, nothing charged by the parent
    }
    const attempts = o.submit_attempts + 1;
    if (attempts >= MAX_SUBMIT_ATTEMPTS) return hold(`Supplier unreachable after ${attempts} attempts`);
    setStatus(db, o.id, 'pending', { last_error: e.message, next_poll_at: fmt(addMs(now, 2 * 60000)) }); event(db, o.id, 'retry_later', e.message);
    return { status: 'pending' };
  }
}

async function pollOrder(db, client, orderId, now = new Date()) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o || !o.parent_order_id || FINAL.includes(o.status)) return { skipped: true };
  let res;
  try { res = await client.getOrder(o.parent_order_id); }
  catch (e) { setStatus(db, o.id, o.status, { last_error: e.message, next_poll_at: fmt(addMs(now, POLL_MS)) }); return { error: e.kind }; }
  const ord = orderOf(res); const raw = ord.status;
  const mapped = MAP[norm(raw)];
  if (!mapped) { event(db, o.id, 'unknown_parent_status', raw); setStatus(db, o.id, o.status, { next_poll_at: fmt(addMs(now, POLL_MS)) }); return { unknown: raw }; }
  const remains = parseInt(ord.remains ?? '', 10);
  const parentRefund = safePaise(ord.refund_amount); // wholesale amount the parent returned to our parent wallet
  const next = ['pending', 'in_progress'].includes(mapped) ? fmt(addMs(now, POLL_MS)) : null;
  setStatus(db, o.id, mapped, { parent_status: String(raw).slice(0, 40), next_poll_at: next, last_error: null });
  if (mapped !== o.status) event(db, o.id, 'status', `${o.status} -> ${mapped}`);
  // Refund policy (customer wallet): only when the parent confirms funds came back.
  //  refunded -> full refund. partial/canceled with a parent refund_amount -> same share of the retail price (rounded down).
  //  partial without refund_amount -> proportional to `remains` if given, else left for the admin. failed -> never automatic.
  const share = (n) => (o.wholesale_paise > 0 ? Math.min(o.retail_paise, Math.floor((o.retail_paise * n) / o.wholesale_paise)) : 0);
  if (mapped === 'refunded') refundOrder(db, o.id, o.retail_paise, 'Supplier confirmed full refund');
  else if ((mapped === 'partial' || mapped === 'canceled') && parentRefund > 0 && share(parentRefund) > 0) refundOrder(db, o.id, share(parentRefund), 'Supplier refund received');
  else if (mapped === 'partial' && Number.isInteger(remains) && remains > 0 && remains <= o.quantity) refundOrder(db, o.id, Math.floor((o.retail_paise * remains) / o.quantity), `Partial delivery, ${remains} undelivered`);
  else if (mapped === 'partial') event(db, o.id, 'needs_review', 'Partial order without refund details; check and refund manually if due');
  else if (mapped === 'canceled') event(db, o.id, 'needs_review', 'Canceled by supplier without refund; refund manually only after confirming funds returned');
  else if (mapped === 'failed') event(db, o.id, 'needs_review', 'Parent reported failure; refund only after confirming funds returned');
  return { status: mapped };
}

function dueForWork(db, now = new Date()) {
  return db.prepare("SELECT id,parent_order_id FROM orders WHERE status IN ('pending','in_progress') AND (next_poll_at IS NULL OR next_poll_at<=?) ORDER BY id LIMIT 50").all(fmt(now));
}
module.exports = { placeOrder, refundOrder, submitOrder, pollOrder, dueForWork, extractId, MAP, validLink };
