'use strict';
const settings = require('../services/settings');
const deposits = require('../services/deposits');
const orders = require('../services/orders');
const refills = require('../services/refills');
const catalog = require('../services/catalog');
const discord = require('../integrations/discord');
const gmail = require('../integrations/gmail');
const pc = require('../integrations/parentClient');
const auth = require('../services/auth');
const { fmt, parse } = require('../utils/time');

const log = (db, action, detail) => { try { db.prepare('INSERT INTO activity_logs(action,detail) VALUES(?,?)').run(action, String(detail).slice(0, 300)); } catch { /* ignore */ } };
const SYNC_EVERY_MS = 12 * 3600 * 1000;

// Every job is driven by timestamps stored in SQLite, so after a sleep/restart the next run simply catches up. Idempotent by design.
async function runOnce(holder, { fetcher = gmail.fetchRecent, now = new Date() } = {}) {
  const db = holder.db; const done = {};
  const step = async (name, fn) => { try { done[name] = await fn(); } catch (e) { done[name] = { error: e.message }; log(db, `job_error:${name}`, e.message); } };
  await step('deposits', () => deposits.withLock(() => deposits.verifyDeposits(db, { fetcher, now })));
  await step('expire', async () => deposits.expireStale(db, now));
  await step('discord', () => discord.processQueue(db, now));
  const conn = pc.getConn(db);
  if (conn.api_verified && conn.state === 'connected') {
    const client = pc.api(db);
    await step('orders', async () => { let n = 0; for (const o of orders.dueForWork(db, now)) { if (o.parent_order_id) await orders.pollOrder(db, client, o.id, now); else await orders.submitOrder(db, client, o.id, now); n++; } return { processed: n }; });
    await step('refills', async () => {
      const rows = db.prepare("SELECT id FROM parent_refills WHERE status='pending' AND parent_txn_id IS NOT NULL AND (last_checked_at IS NULL OR last_checked_at<?) LIMIT 5").all(fmt(new Date(now.getTime() - 60000)));
      for (const r of rows) await refills.verifyRefill(db, client, r.id); return { checked: rows.length };
    });
    await step('sync', async () => {
      const last = settings.get(db, 'last_service_sync');
      if (last && now.getTime() - parse(last) < SYNC_EVERY_MS) return { skipped: true };
      return catalog.syncServices(db, await client.services(), now);
    });
  }
  await step('sessions', async () => auth.purgeSessions(db, now));
  settings.set(db, 'last_job_run', fmt(now));
  return done;
}

function startJobs(holder, deps = {}) {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await runOnce(holder, deps); } finally { running = false; } };
  const boot = setTimeout(tick, 5000); // recover overdue work shortly after wake/start
  const iv = setInterval(tick, 30000);
  return () => { clearTimeout(boot); clearInterval(iv); };
}
module.exports = { runOnce, startJobs };
