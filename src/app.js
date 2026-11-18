'use strict';
const express = require('express');
const path = require('path');
const settings = require('./services/settings');
const auth = require('./services/auth');
const wallet = require('./services/wallet');
const deposits = require('./services/deposits');
const allocation = require('./services/allocation');
const catalog = require('./services/catalog');
const orders = require('./services/orders');
const refills = require('./services/refills');
const support = require('./services/support');
const backup = require('./services/backup');
const discord = require('./integrations/discord');
const gmail = require('./integrations/gmail');
const pc = require('./integrations/parentClient');
const oauth = require('./integrations/oauth');
const parentCfg = require('./config/parent');
const { toPaise, fromPaise } = require('./utils/money');
const { safeEqual } = require('./utils/crypto');
const setupFlow = require('./services/setupFlow');
const views = require('./views');
const catalogSvc = require('./services/catalog');
const { resolveAppUrl, validateAppUrl } = require('./utils/url');
const { fmt } = require('./utils/time');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const bad = (m, code = 400) => Object.assign(new Error(m), { http: code });

function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const k = `${req.ip}|${req.path}`; const now = Date.now(); const h = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    h.push(now); hits.set(k, h); if (hits.size > 5000) hits.clear(); next();
  };
}

function createApp(holder, { fetcher = gmail.fetchRecent } = {}) {
  const app = express();
  const db = () => holder.db;
  const appUrl = (req) => resolveAppUrl(settings.get(db(), 'app_url'), req.get('host'), req.secure);
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/admin/restore', express.raw({ type: 'application/octet-stream', limit: '100mb' }));

  app.get('/health', (req, res) => { try { db().prepare('SELECT 1').get(); res.json({ status: 'ok', time: fmt() }); } catch { res.status(503).json({ status: 'error' }); } });

  // ---- session + CSRF ----
  app.use((req, res, next) => {
    req.sid = cookies(req.headers.cookie).sid;
    req.sess = auth.loadSession(db(), req.sid);
    req.user = null;
    if (req.sess && req.sess.userId) { const u = db().prepare('SELECT id,username,email,role,status FROM users WHERE id=?').get(req.sess.userId); if (u && u.status === 'active') req.user = u; }
    if (req.path.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
      const t = req.headers['x-csrf-token'];
      if (!req.sess || !t || !safeEqual(t, req.sess.data.csrf)) return res.status(403).json({ error: 'Session expired. Refresh the page.' });
    }
    next();
  });
  const setCookie = (req, res, sid) => res.append('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${req.secure ? '; Secure' : ''}`);
  const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in' }));
  const needAdmin = (req, res, next) => (req.user && req.user.role === 'super_admin' ? next() : res.status(req.user ? 403 : 401).json({ error: 'Admin access required' }));
  const audit = (req, action, detail) => db().prepare('INSERT INTO activity_logs(actor_id,action,detail) VALUES(?,?,?)').run(req.user ? req.user.id : null, action, detail ? String(detail).slice(0, 300) : null);
  const publicSettings = () => ({ panelName: settings.get(db(), 'panel_name'), logoUrl: settings.get(db(), 'logo_url'), faviconUrl: settings.get(db(), 'favicon_url'), accent: settings.get(db(), 'accent') });

  app.get('/api/session', (req, res) => {
    let s = req.sess;
    if (!s) { const c = auth.createSession(db(), null); setCookie(req, res, c.sid); s = { data: { csrf: c.csrf } }; }
    res.json({ csrf: s.data.csrf, user: req.user, settings: publicSettings(), setupNeeded: !auth.adminExists(db()),
      pendingAdmin: !!(s.data && s.data.pendingAdmin), support: (({ url, display_name, enabled }) => ({ enabled: !!(enabled && url), name: display_name }))(support.getSupport(db())) });
  });

  // ---- auth ----
  const loginLimit = rateLimiter(10, 15 * 60000);
  const startSession = (req, res, userId) => { if (req.sid) auth.destroySession(db(), req.sid); const c = auth.createSession(db(), userId); setCookie(req, res, c.sid); return c; };
  app.post('/api/auth/register', loginLimit, wrap((req, res) => {
    if (!auth.adminExists(db())) throw bad('This panel is not set up yet', 409);
    const id = auth.register(db(), req.body || {}); const u = db().prepare('SELECT id,username,role FROM users WHERE id=?').get(id); const c = startSession(req, res, id);
    res.json({ ok: true, csrf: c.csrf, user: u, redirect: '/app' });
  }));
  app.post('/api/auth/login', loginLimit, wrap((req, res) => {
    const u = auth.login(db(), req.body || {}); const c = startSession(req, res, u.id);
    res.json({ ok: true, csrf: c.csrf, user: { id: u.id, username: u.username, role: u.role }, redirect: u.role === 'super_admin' ? '/admin' : '/app' });
  }));
  app.post('/api/auth/logout', (req, res) => { if (req.sid) auth.destroySession(db(), req.sid); res.clearCookie('sid'); res.json({ ok: true }); });
  app.post('/api/me/password', needUser, wrap((req, res) => { auth.changePassword(db(), req.user.id, req.body || {}); res.json({ ok: true, relogin: true }); }));

  // ---- first-time owner setup: parent OAuth only (no setup code, no manual claim) ----
  app.post('/api/setup/start', loginLimit, wrap(async (req, res) => {
    if (auth.adminExists(db())) throw bad('Setup is already complete', 409);
    if (!req.sess) throw bad('No session', 403);
    if (!settings.get(db(), 'app_url')) settings.set(db(), 'app_url', appUrl(req)); // remember the public address for OAuth
    const url = await setupFlow.begin(db(), req.sess.data, { name: settings.get(db(), 'panel_name'), url: appUrl(req), redirectUri: `${appUrl(req)}/oauth/callback` });
    auth.saveSession(db(), req.sess); res.json({ url });
  }));
  app.post('/api/setup/admin', loginLimit, wrap((req, res) => {
    if (!req.sess) throw bad('No session', 403);
    const id = setupFlow.createAdmin(db(), req.sess.data, req.body || {}); auth.saveSession(db(), req.sess);
    const c = startSession(req, res, id); res.json({ ok: true, csrf: c.csrf, redirect: '/admin' });
  }));
  app.get('/oauth/callback', wrap(async (req, res) => {
    if (!req.sess) return res.redirect('/login');
    const adminFlow = !!(req.user && req.user.role === 'super_admin');
    try {
      await setupFlow.callback(db(), req.sess.data, req.query, `${appUrl(req)}/oauth/callback`, { adminFlow });
      auth.saveSession(db(), req.sess); res.redirect(adminFlow ? '/admin#/parent' : '/setup');
    } catch (e) { auth.saveSession(db(), req.sess); res.redirect(adminFlow ? `/admin#/parent?error=${encodeURIComponent(e.message)}` : `/setup?error=${encodeURIComponent(e.message)}`); }
  }));

  // ---- pages (HTML is rendered server-side with the panel name/logo; scripts and styles are external for the strict CSP) ----
  const brand = () => ({ name: settings.get(db(), 'panel_name') || 'MrKrishna Child Panel', logoUrl: settings.get(db(), 'logo_url'), faviconUrl: settings.get(db(), 'favicon_url') });
  const send = (res, name) => res.type('html').set('Cache-Control', 'no-store').send(views.render(name, brand()));
  const ready = (res) => (auth.adminExists(db()) ? true : (res.redirect('/setup'), false));
  const home = (u) => (u.role === 'super_admin' ? '/admin' : '/app');
  app.get('/', (req, res) => { if (ready(res)) send(res, 'landing'); });
  app.get(['/login', '/register'], (req, res) => { if (!ready(res)) return; if (req.user) return res.redirect(home(req.user)); send(res, req.path === '/login' ? 'login' : 'register'); });
  app.get('/services/:platform', (req, res) => { if (!ready(res)) return; if (!['instagram', 'youtube', 'telegram', 'facebook', 'whatsapp'].includes(req.params.platform)) return res.redirect('/'); send(res, 'services'); });
  app.get('/app', (req, res) => { if (!ready(res)) return; if (!req.user) return res.redirect('/login'); if (req.user.role === 'super_admin') return res.redirect('/admin'); send(res, 'app'); });
  app.get('/admin', (req, res) => { if (!ready(res)) return; if (!req.user || req.user.role !== 'super_admin') return res.redirect('/login'); send(res, 'admin'); });
  app.get('/setup', (req, res) => { if (auth.adminExists(db())) return res.redirect('/login'); send(res, 'setup'); });
  app.get('/theme.css', (req, res) => res.type('text/css').set('Cache-Control', 'no-cache').send(views.themeCss(settings.get(db(), 'accent'))));
  app.get('/favicon.svg', (req, res) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(views.faviconSvg(brand().name)));

  // ---- public read-only APIs (retail prices only: no wholesale rates, no parent IDs) ----
  const PLATFORMS = ['instagram', 'youtube', 'telegram', 'facebook', 'whatsapp'];
  app.get('/api/public/config', (req, res) => {
    const sup = support.getSupport(db()); const counts = {};
    for (const x of catalogSvc.publicServices(db())) counts[x.platform] = (counts[x.platform] || 0) + 1;
    res.json({ panelName: brand().name, supportUrl: sup.enabled && sup.url ? sup.url : null, loggedIn: !!req.user, user: req.user ? { username: req.user.username, role: req.user.role } : null, counts });
  });
  app.get('/api/public/services', (req, res) => {
    const p = String(req.query.platform || ''); if (p && !PLATFORMS.includes(p)) throw bad('Unknown platform');
    const list = catalogSvc.publicServices(db()).filter((x) => !p || x.platform === p);
    res.json({ services: list, categories: [...new Set(list.map((x) => x.category).filter(Boolean))] });
  });

  // ---- customer ----
  app.get('/api/me', needUser, (req, res) => res.json({ user: req.user, balance: fromPaise(wallet.balance(db(), req.user.id)) }));
  app.get('/api/dashboard', needUser, (req, res) => {
    const id = req.user.id; const c = (s) => db().prepare(s).get(id).c;
    res.json({ balance: fromPaise(wallet.balance(db(), id)),
      totalOrders: c('SELECT count(*) c FROM orders WHERE user_id=?'), completed: c("SELECT count(*) c FROM orders WHERE user_id=? AND status='completed'"),
      pending: c("SELECT count(*) c FROM orders WHERE user_id=? AND status IN('pending','in_progress','awaiting_admin')"),
      totalDeposits: fromPaise(db().prepare("SELECT COALESCE(sum(requested_paise),0) s FROM deposits WHERE user_id=? AND status='paid'").get(id).s),
      recentOrders: ordersFor(id, 5), recentTransactions: txFor(id, 5),
      recentDeposits: db().prepare('SELECT transaction_id,requested_paise,status,created_at FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 5').all(id).map((d) => ({ transactionId: d.transaction_id, requested: fromPaise(d.requested_paise), status: d.status, createdAt: d.created_at })) });
  });
  const ordersFor = (uid, limit = 100) => db().prepare('SELECT o.reference,o.link,o.quantity,o.retail_paise,o.status,o.created_at,s.name service FROM orders o JOIN services s ON s.id=o.service_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT ?').all(uid, limit)
    .map((o) => ({ reference: o.reference, service: o.service, link: o.link, quantity: o.quantity, charge: fromPaise(o.retail_paise), status: o.status, createdAt: o.created_at }));
  const txFor = (uid, limit = 100) => db().prepare('SELECT type,amount_paise,balance_after_paise,reason,created_at FROM customer_transactions WHERE user_id=? ORDER BY id DESC LIMIT ?').all(uid, limit)
    .map((t) => ({ type: t.type, amount: (t.amount_paise < 0 ? '-' : '') + fromPaise(Math.abs(t.amount_paise)), balance: fromPaise(t.balance_after_paise), reason: t.reason, createdAt: t.created_at }));
  app.get('/api/services', needUser, (req, res) => res.json({ services: catalog.publicServices(db()) }));
  app.get('/api/orders', needUser, (req, res) => res.json({ orders: ordersFor(req.user.id) }));
  app.get('/api/transactions', needUser, (req, res) => res.json({ transactions: txFor(req.user.id) }));
  app.get('/api/support', needUser, (req, res) => { const s = support.getSupport(db()); res.json({ enabled: !!(s.enabled && s.url), url: s.enabled ? s.url : null, name: s.display_name }); });

  const orderLimit = rateLimiter(30, 60000);
  app.post('/api/orders', needUser, orderLimit, wrap(async (req, res) => {
    const b = req.body || {};
    let o;
    try { o = orders.placeOrder(db(), { userId: req.user.id, serviceId: parseInt(b.serviceId, 10), link: b.link, quantity: parseInt(b.quantity, 10) }); }
    catch (e) { if (e.code === 'INSUFFICIENT_FUNDS') throw bad('Not enough balance. Add funds first.', 402); if (e.code === 'VALIDATION') throw bad(e.message); throw e; }
    // Submit right away; if this fails the job recovers it with the same reference. The customer is only told "placed", never "delivered".
    orders.submitOrder(db(), pc.api(db()), o.id).catch(() => {}); // holds as 'awaiting admin' if the parent is not connected
    res.json({ ok: true, reference: o.reference, charge: fromPaise(o.retailPaise) });
  }));

  const depositView = async (d) => {
    const params = new URLSearchParams({ pa: d.owner_upi_snapshot, pn: settings.get(db(), 'panel_name', 'MrKrishna'), am: fromPaise(d.payable_paise), cu: 'INR', tn: d.transaction_id });
    const upiUri = `upi://pay?${params}`; let qr = null;
    try { qr = await require('qrcode').toDataURL(upiUri, { margin: 1, width: 260 }); } catch { /* qr lib missing: UPI link still shown */ }
    return { transactionId: d.transaction_id, status: d.status, requested: fromPaise(d.requested_paise), payable: fromPaise(d.payable_paise), upiId: d.owner_upi_snapshot,
      expiresAt: d.expires_at, createdAt: d.created_at, upiUri, qr, result: d.verification_result };
  };
  app.post('/api/deposits', needUser, rateLimiter(10, 60000), wrap(async (req, res) => {
    const upi = settings.get(db(), 'fampay_upi_id');
    if (!upi || !settings.get(db(), 'gmail_address') || !settings.get(db(), 'gmail_app_password_enc') || !gmail.allowedSenders(db()).length) throw bad('Deposits are not available yet. Please contact support.', 503);
    let p; try { p = toPaise(String((req.body || {}).amount)); } catch { throw bad('Enter a valid amount'); }
    const min = settings.getInt(db(), 'min_deposit_paise', 1000), max = settings.getInt(db(), 'max_deposit_paise', 5000000);
    if (p < min || p > max) throw bad(`Amount must be between ₹${fromPaise(min)} and ₹${fromPaise(max)}`);
    const open = db().prepare("SELECT count(*) c FROM deposits WHERE user_id=? AND status='pending'").get(req.user.id).c;
    if (open >= 3) throw bad('You have too many open deposits. Complete or wait for them to expire.', 429);
    const d = allocation.createDeposit(db(), { userId: req.user.id, requestedPaise: p, upiId: upi, expiresMinutes: settings.getInt(db(), 'deposit_expiry_minutes', 30) });
    res.json(await depositView(db().prepare('SELECT * FROM deposits WHERE transaction_id=?').get(d.transactionId)));
  }));
  app.get('/api/deposits', needUser, (req, res) => res.json({ deposits: db().prepare('SELECT transaction_id,requested_paise,payable_paise,status,created_at FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id)
    .map((d) => ({ transactionId: d.transaction_id, requested: fromPaise(d.requested_paise), payable: fromPaise(d.payable_paise), status: d.status, createdAt: d.created_at })) }));
  app.get('/api/deposits/:id', needUser, wrap(async (req, res) => { // reopening never creates a new deposit
    const d = db().prepare('SELECT * FROM deposits WHERE transaction_id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!d) throw bad('Deposit not found', 404); res.json(await depositView(d));
  }));
  app.post('/api/deposits/:id/check', needUser, rateLimiter(20, 60000), wrap(async (req, res) => {
    const r = await deposits.checkNow(db(), { userId: req.user.id, transactionId: req.params.id, fetcher });
    if (!r.found) throw bad('Deposit not found', 404); res.json(r);
  }));

  // ---- admin ----
  const A = express.Router(); A.use(needAdmin); app.use('/api/admin', A);
  const money = (v) => fromPaise(v || 0);
  A.get('/overview', (req, res) => {
    const d = db(); const one = (s) => d.prepare(s).get();
    const revenue = one("SELECT COALESCE(sum(retail_paise-refunded_paise),0) s FROM orders WHERE status NOT IN('failed') OR refunded_paise>0").s;
    const wholesale = one('SELECT COALESCE(sum(wholesale_paise),0) s FROM orders WHERE parent_order_id IS NOT NULL').s;
    const conn = pc.getConn(d);
    res.json({ customers: one("SELECT count(*) c FROM users WHERE role='customer'").c, liability: money(one('SELECT COALESCE(sum(balance_paise),0) s FROM customer_wallets').s),
      verifiedDeposits: money(one("SELECT COALESCE(sum(requested_paise),0) s FROM deposits WHERE status='paid'").s), orders: one('SELECT count(*) c FROM orders').c,
      pendingOrders: one("SELECT count(*) c FROM orders WHERE status IN('pending','in_progress','awaiting_admin')").c, completedOrders: one("SELECT count(*) c FROM orders WHERE status='completed'").c,
      awaitingAdmin: one("SELECT count(*) c FROM orders WHERE status='awaiting_admin'").c,
      retailRevenue: money(revenue), wholesaleSpend: money(wholesale), grossMarkup: money(revenue - wholesale),
      parentState: conn.state, parentVerified: !!conn.api_verified, lastJobRun: settings.get(d, 'last_job_run'),
      storageWarning: 'Database storage is temporary. Render Free may erase local files during restart, spin-down, or redeployment. Download regular backups to avoid losing data.' });
  });
  A.get('/customers', (req, res) => { const q = `%${String(req.query.q || '').replace(/[%_]/g, '')}%`;
    res.json({ customers: db().prepare('SELECT u.id,u.username,u.email,u.status,u.created_at,COALESCE(w.balance_paise,0) b FROM users u LEFT JOIN customer_wallets w ON w.user_id=u.id WHERE u.role=? AND (u.username LIKE ? OR u.email LIKE ?) ORDER BY u.id DESC LIMIT 200').all('customer', q, q).map((u) => ({ ...u, balance: money(u.b), b: undefined })) }); });
  A.get('/customers/:id', (req, res) => { const id = parseInt(req.params.id, 10); const u = db().prepare('SELECT id,username,email,status,created_at FROM users WHERE id=?').get(id); if (!u) throw bad('Not found', 404);
    res.json({ user: u, balance: money(wallet.balance(db(), id)), transactions: txFor(id, 50), orders: ordersFor(id, 50) }); });
  A.post('/customers/:id/status', wrap((req, res) => { const st = (req.body || {}).status; if (!['active', 'suspended'].includes(st)) throw bad('Invalid status');
    const id = parseInt(req.params.id, 10); db().prepare("UPDATE users SET status=? WHERE id=? AND role='customer'").run(st, id); if (st === 'suspended') db().prepare('DELETE FROM sessions WHERE user_id=?').run(id); audit(req, 'customer_status', `${id}:${st}`); res.json({ ok: true }); }));
  A.post('/customers/:id/adjust', wrap((req, res) => { const b = req.body || {}; const reason = String(b.reason || '').trim(); if (reason.length < 5) throw bad('A reason is required');
    const m = /^(-?)(\d+(?:\.\d{1,2})?)$/.exec(String(b.amount || '')); if (!m) throw bad('Enter a valid amount'); const p = toPaise(m[2]) * (m[1] ? -1 : 1); if (!p) throw bad('Amount cannot be zero');
    const id = parseInt(req.params.id, 10);
    try { wallet.applyTx(db(), { userId: id, type: 'admin_adjust', amountPaise: p, refType: 'admin', refId: `${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, reason }); } catch (e) { if (e.code === 'INSUFFICIENT_FUNDS') throw bad('Adjustment would make the balance negative'); throw e; }
    audit(req, 'balance_adjust', `${id}:${p} paise:${reason}`); res.json({ ok: true }); }));

  A.get('/services', (req, res) => { const g = catalog.globalMarkupBp(db());
    res.json({ lastSync: settings.get(db(), 'last_service_sync'), globalMarkup: fromPaise(g), services: db().prepare('SELECT s.*,c.name category,c.platform FROM services s LEFT JOIN service_categories c ON c.id=s.category_id ORDER BY c.platform,s.name LIMIT 2000').all()
      .map((s) => ({ id: s.id, parentId: s.parent_service_id, name: s.name, category: s.category, platform: s.platform, wholesale: fromPaise(s.wholesale_paise_per_1000), retail: fromPaise(catalog.effectiveRate(s, g)), markup: s.markup_bp === null ? null : fromPaise(s.markup_bp), enabled: !!s.enabled, available: !!s.available, description: s.description })) }); });
  A.post('/services/sync', wrap(async (req, res) => { const r = catalog.syncServices(db(), await pc.api(db()).services()); audit(req, 'service_sync', JSON.stringify(r)); res.json(r); }));
  A.post('/services/:id', wrap((req, res) => { const b = req.body || {}; const id = parseInt(req.params.id, 10); const d = db();
    if (b.enabled !== undefined) d.prepare('UPDATE services SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, id);
    if (b.markup !== undefined) { if (b.markup === null || b.markup === '') d.prepare('UPDATE services SET markup_bp=NULL WHERE id=?').run(id); else { let bp; try { bp = toPaise(String(b.markup)); } catch { throw bad('Invalid markup'); } if (bp > 100000) throw bad('Markup too high'); d.prepare('UPDATE services SET markup_bp=? WHERE id=?').run(bp, id); } }
    if (b.description !== undefined) d.prepare('UPDATE services SET description=? WHERE id=?').run(String(b.description).slice(0, 2000), id);
    audit(req, 'service_update', String(id)); res.json({ ok: true }); }));

  A.get('/orders', (req, res) => res.json({ orders: db().prepare('SELECT o.*,u.username,s.name service FROM orders o JOIN users u ON u.id=o.user_id JOIN services s ON s.id=o.service_id ORDER BY o.id DESC LIMIT 300').all()
    .map((o) => ({ id: o.id, reference: o.reference, username: o.username, service: o.service, quantity: o.quantity, retail: money(o.retail_paise), wholesale: o.wholesale_paise === null ? null : money(o.wholesale_paise), refunded: money(o.refunded_paise), parentOrderId: o.parent_order_id, status: o.status, lastError: o.last_error, createdAt: o.created_at })) }));
  A.get('/orders/:id', (req, res) => res.json({ events: db().prepare('SELECT event,detail,created_at FROM order_events WHERE order_id=? ORDER BY id').all(parseInt(req.params.id, 10)) }));
  A.post('/orders/:id/retry', wrap(async (req, res) => { const id = parseInt(req.params.id, 10); const o = db().prepare('SELECT status,parent_order_id FROM orders WHERE id=?').get(id);
    if (!o || o.parent_order_id || !['pending', 'awaiting_admin'].includes(o.status)) throw bad('This order cannot be retried');
    db().prepare("UPDATE orders SET status='pending' WHERE id=?").run(id); audit(req, 'order_retry', String(id)); res.json(await orders.submitOrder(db(), pc.api(db()), id)); }));
  A.post('/orders/:id/refund', wrap((req, res) => { const id = parseInt(req.params.id, 10); const o = db().prepare('SELECT retail_paise FROM orders WHERE id=?').get(id); if (!o) throw bad('Not found', 404);
    const amt = (req.body || {}).amount ? toPaise(String(req.body.amount)) : o.retail_paise; const r = orders.refundOrder(db(), id, amt, `Admin refund: ${String((req.body || {}).reason || 'manual').slice(0, 100)}`); audit(req, 'order_refund', `${id}:${amt}`); res.json(r); }));

  A.get('/deposits', (req, res) => res.json({ deposits: db().prepare('SELECT d.*,u.username FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 300').all()
      .map((d) => ({ id: d.id, transactionId: d.transaction_id, username: d.username, requested: money(d.requested_paise), payable: money(d.payable_paise), upi: d.owner_upi_snapshot, status: d.status, attempts: d.verification_attempts, result: d.verification_result, createdAt: d.created_at, creditedAt: d.credited_at })),
    notifications: db().prepare("SELECT message_uid,sender,amount_paise,received_at,outcome FROM deposit_notifications ORDER BY id DESC LIMIT 100").all().map((n) => ({ ...n, amount: n.amount_paise === null ? null : money(n.amount_paise), amount_paise: undefined })) }));
  A.post('/deposits/:id/verify', wrap(async (req, res) => { const r = await deposits.withLock(() => deposits.verifyDeposits(db(), { fetcher, onlyId: parseInt(req.params.id, 10) })); res.json(r); }));
  A.get('/transactions', (req, res) => res.json({ transactions: db().prepare('SELECT t.*,u.username FROM customer_transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 300').all().map((t) => ({ id: t.id, username: t.username, type: t.type, amount: (t.amount_paise < 0 ? '-' : '') + fromPaise(Math.abs(t.amount_paise)), balance: money(t.balance_after_paise), reason: t.reason, createdAt: t.created_at })) }));

  A.get('/settings', (req, res) => { const d = db(); const g = (k) => settings.get(d, k);
    res.json({ appUrl: appUrl(req), appUrlSaved: !!g('app_url'), fampayUpiId: g('fampay_upi_id'), gmailAddress: g('gmail_address'), gmailPasswordSet: !!g('gmail_app_password_enc'), allowedSenders: g('fampay_allowed_senders'), requireDkim: g('require_dkim') === '1',
      globalMarkup: fromPaise(catalog.globalMarkupBp(d)), panelName: g('panel_name'), logoUrl: g('logo_url'), faviconUrl: g('favicon_url'), accent: g('accent'),
      minDeposit: fromPaise(settings.getInt(d, 'min_deposit_paise', 1000)), maxDeposit: fromPaise(settings.getInt(d, 'max_deposit_paise', 5000000)), expiryMinutes: settings.getInt(d, 'deposit_expiry_minutes', 30),
      discordTokenSet: !!discord.getConfig(d).token, discordChannelId: discord.getConfig(d).channelId, support: support.getSupport(d) }); });
  const httpsUrl = (u) => { if (!u) return null; const v = support.validateSupportUrl(u); if (!v.ok) throw bad(v.error); return v.url; };
  A.put('/settings', wrap((req, res) => { const b = req.body || {}; const d = db();
    if (b.fampayUpiId !== undefined) { if (b.fampayUpiId && !/^[\w.\-]{2,100}@[A-Za-z][\w.\-]{1,60}$/.test(b.fampayUpiId)) throw bad('Enter a valid UPI ID'); settings.set(d, 'fampay_upi_id', b.fampayUpiId || null); }
    if (b.gmailAddress !== undefined) { if (b.gmailAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.gmailAddress)) throw bad('Enter a valid Gmail address'); settings.set(d, 'gmail_address', b.gmailAddress || null); }
    if (b.gmailAppPassword) settings.set(d, 'gmail_app_password_enc', String(b.gmailAppPassword).replace(/\s+/g, ''), true);
    if (b.allowedSenders !== undefined) { const l = String(b.allowedSenders).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); if (l.some((s) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) throw bad('Sender list must be email addresses'); settings.set(d, 'fampay_allowed_senders', l.join(',')); }
    if (b.requireDkim !== undefined) settings.set(d, 'require_dkim', b.requireDkim ? '1' : '0');
    if (b.globalMarkup !== undefined) { let bp; try { bp = toPaise(String(b.globalMarkup)); } catch { throw bad('Invalid markup'); } if (bp > 100000) throw bad('Markup too high'); settings.set(d, 'global_markup_bp', String(bp)); }
    if (b.appUrl !== undefined) { if (!b.appUrl) settings.set(d, 'app_url', null); else { const v = validateAppUrl(b.appUrl); if (!v) throw bad('Enter your public address like https://my-panel.onrender.com'); settings.set(d, 'app_url', v); } }
    if (b.panelName !== undefined) settings.set(d, 'panel_name', String(b.panelName).trim().slice(0, 60) || 'MrKrishna SMM Child Panel');
    if (b.logoUrl !== undefined) settings.set(d, 'logo_url', httpsUrl(b.logoUrl)); if (b.faviconUrl !== undefined) settings.set(d, 'favicon_url', httpsUrl(b.faviconUrl));
    if (b.accent !== undefined) { if (b.accent && !/^#[0-9a-fA-F]{6}$/.test(b.accent)) throw bad('Accent must be a hex color'); settings.set(d, 'accent', b.accent || null); }
    if (b.minDeposit !== undefined) settings.set(d, 'min_deposit_paise', String(toPaise(String(b.minDeposit)))); if (b.maxDeposit !== undefined) settings.set(d, 'max_deposit_paise', String(toPaise(String(b.maxDeposit))));
    if (b.expiryMinutes !== undefined) { const n = parseInt(b.expiryMinutes, 10); if (!(n >= 10 && n <= 120)) throw bad('Expiry must be 10-120 minutes'); settings.set(d, 'deposit_expiry_minutes', String(n)); }
    if (b.discordToken !== undefined || b.discordChannelId !== undefined) discord.saveConfig(d, { token: b.discordToken || undefined, channelId: b.discordChannelId });
    if (b.support) support.setSupport(d, { url: b.support.url, displayName: b.support.displayName, enabled: !!b.support.enabled });
    audit(req, 'settings_update', Object.keys(b).filter((k) => !/password|token/i.test(k)).join(',')); res.json({ ok: true }); }));
  A.post('/settings/gmail-test', wrap(async (req, res) => { try { const n = await gmail.fetchRecent(db(), { limit: 10 });
    res.json({ ok: true, notifications: n.map((x) => ({ sender: x.sender, amount: x.amountPaise === null ? null : money(x.amountPaise), receivedAt: x.receivedAt, authPass: x.authPass, hasId: !!x.uid })) }); }
    catch (e) { res.json({ ok: false, error: String(e.message).slice(0, 200) }); } }));

  A.get('/parent', wrap(async (req, res) => { const c = pc.getConn(db());
    res.json({ websiteUrl: parentCfg.websiteUrl, docsUrl: parentCfg.docsUrl, apiBaseUrl: parentCfg.apiBaseUrl, state: c.state, apiVerified: !!c.api_verified, docsVerified: parentCfg.docsVerified, account: c.account_username, lastProbe: c.last_probe_at, lastError: c.last_error,
      oauthConfigured: !!(parentCfg.oauth.authorizePath && parentCfg.oauth.tokenPath), clientRegistered: !!(c.client_id || parentCfg.oauth.clientId) }); }));
  A.post('/parent/probe', wrap(async (req, res) => res.json(await pc.probe(db()))));
  A.post('/parent/connect', wrap(async (req, res) => { const redirect = `${appUrl(req)}/oauth/callback`;
    await oauth.ensureClient(db(), { name: settings.get(db(), 'panel_name'), url: appUrl(req), redirectUri: redirect });
    const url = oauth.startAuthorization(db(), req.sess.data, redirect); auth.saveSession(db(), req.sess); res.json({ url }); }));
  A.post('/parent/disconnect', wrap(async (req, res) => { const r = await oauth.disconnect(db()); audit(req, 'parent_disconnect', JSON.stringify(r)); res.json(r); }));
  A.get('/parent/wallet', wrap(async (req, res) => { const w = await pc.api(db()).wallet(); res.json({ balance: pc.pick(w, 'data.balance', 'balance') ?? null, currency: pc.pick(w, 'data.currency', 'currency') ?? null }); }));
  A.get('/parent/orders', wrap(async (req, res) => res.json(await pc.api(db()).listOrders({ limit: 50 }))));
  A.get('/refills', (req, res) => res.json({ refills: db().prepare('SELECT id,reference,parent_txn_id,amount_paise,payable_paise,payment_url,qr_url,status,expires_at,created_at FROM parent_refills ORDER BY id DESC LIMIT 100').all().map((r) => ({ ...r, amount: money(r.amount_paise), payable: money(r.payable_paise || r.amount_paise), amount_paise: undefined, payable_paise: undefined })) }));
  A.post('/refills', wrap(async (req, res) => { const r = await refills.createRefill(db(), pc.api(db()), String((req.body || {}).amount)); audit(req, 'refill_create', r.reference); res.json(r); }));
  A.post('/refills/:id/verify', wrap(async (req, res) => res.json(await refills.verifyRefill(db(), pc.api(db()), parseInt(req.params.id, 10)))));
  A.get('/logs', (req, res) => res.json({ logs: db().prepare('SELECT l.id,l.action,l.detail,l.created_at,u.username FROM activity_logs l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.id DESC LIMIT 300').all() }));
  A.get('/backup', (req, res) => { audit(req, 'backup_download'); res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="child-panel-${fmt().replace(/[ :]/g, '-')}.sqlite"` }); res.send(backup.backupBuffer(db())); });
  A.post('/restore', wrap((req, res) => { if (!Buffer.isBuffer(req.body)) throw bad('Upload a .sqlite backup file'); const r = backup.restoreFromBuffer(holder, req.body); res.clearCookie('sid'); res.json({ ok: true, ...r, relogin: true }); }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: 0 }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof pc.ParentError) return res.status(502).json({ error: err.kind === 'disabled' ? 'Parent connection is not active' : `Parent error: ${err.message}` });
    const code = err.http || (err.code === 'VALIDATION' ? 400 : err.type === 'entity.too.large' ? 413 : 500);
    if (code === 500) console.error('[error]', err.message);
    res.status(code).json({ error: code === 500 ? 'Something went wrong' : err.message });
  });
  return app;
}
module.exports = { createApp };
