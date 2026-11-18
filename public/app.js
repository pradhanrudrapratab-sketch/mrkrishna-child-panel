'use strict';
const S = { csrf: null, user: null, cfg: {}, balance: null, services: [], filter: { q: '', platform: 'all' } };
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const root = $('#root');
let pollTimer = null;

async function api(path, { method = 'GET', body, raw } = {}) {
  const h = { Accept: 'application/json' }; if (S.csrf) h['x-csrf-token'] = S.csrf;
  if (body && !raw) h['Content-Type'] = 'application/json'; if (raw) h['Content-Type'] = 'application/octet-stream';
  const r = await fetch(path, { method, headers: h, body: raw ? body : body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.status = r.status; throw e; }
  return d;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500); }
const tagClass = { completed: 'ok', paid: 'ok', active: 'ok', connected: 'ok', in_progress: 'info', pending: 'warn', awaiting_admin: 'warn', review: 'warn', partial: 'warn', failed: 'bad', canceled: 'bad', expired: 'bad', suspended: 'bad', refunded: 'info', reauth_required: 'bad', disconnected: 'warn' };
const label = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const tag = (s) => `<span class="tag ${tagClass[s] || ''}">${esc(label(s))}</span>`;
const table = (cols, rows, empty = 'Nothing here yet.') => rows.length
  ? `<div class="tw"><table><thead><tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : `<div class="empty">${esc(empty)}</div>`;
const inr = (v) => `₹${esc(v)}`;
const dt = (s) => esc(s ? String(s).slice(0, 16) : '');

function applyBrand() {
  const c = S.cfg; document.title = c.panelName || 'Child Panel';
  if (c.accent) document.documentElement.style.setProperty('--accent', c.accent);
  if (c.faviconUrl) $('#favicon').href = c.faviconUrl;
}
const logo = () => (S.cfg.logoUrl ? `<img class="logo" src="${esc(S.cfg.logoUrl)}" alt="">` : `<span class="logo">MK</span>`);

const CUSTOMER_NAV = [['dashboard', 'Dashboard'], ['services', 'Services'], ['orders', 'Orders'], ['funds', 'Add funds'], ['history', 'History'], ['profile', 'Profile'], ['support', 'Support']];
const ADMIN_NAV = [['admin', 'Overview'], ['admin/customers', 'Customers'], ['admin/services', 'Services'], ['admin/orders', 'Orders'], ['admin/deposits', 'Deposits'], ['admin/transactions', 'Transactions'],
  ['admin/parent', 'Parent connection'], ['admin/refills', 'Parent refills'], ['admin/settings', 'Settings'], ['admin/logs', 'Activity logs'], ['admin/backup', 'Backup']];

function shell(route, html) {
  const admin = S.user.role === 'super_admin';
  const nav = (items, h) => `${h ? `<h4>${h}</h4>` : ''}${items.map(([r, n]) => `<a href="#/${r}" class="${route === r ? 'on' : ''}">${esc(n)}</a>`).join('')}`;
  const bottom = (admin ? [['admin', 'Overview'], ['admin/orders', 'Orders'], ['admin/deposits', 'Deposits'], ['admin/settings', 'Settings']] : [['dashboard', 'Home'], ['services', 'Order'], ['funds', 'Funds'], ['orders', 'Orders'], ['support', 'Support']]);
  root.innerHTML = `<header class="top"><a class="brand" href="#/${admin ? 'admin' : 'dashboard'}">${logo()}<span>${esc(S.cfg.panelName)}</span></a><span class="grow"></span>
    ${admin ? '' : `<span class="bal" id="bal">${S.balance === null ? '' : inr(S.balance)}</span>`}<button class="btn sec sm" data-act="logout">Log out</button></header>
    <div class="shell"><nav class="side">${admin ? nav(ADMIN_NAV, 'Admin') : nav(CUSTOMER_NAV)}</nav><main>${html}</main></div>
    <nav class="bottom">${bottom.map(([r, n]) => `<a href="#/${r}" class="${route === r ? 'on' : ''}">${esc(n)}</a>`).join('')}</nav>`;
}
const refreshBalance = async () => { try { const m = await api('/api/me'); S.balance = m.balance; const b = $('#bal'); if (b) b.textContent = `₹${m.balance}`; } catch { /* ignore */ } };

// ---------- public views ----------
function authView(mode) {
  const reg = mode === 'register';
  root.innerHTML = `<div class="auth"><div class="brand">${logo()}<span>${esc(S.cfg.panelName)}</span></div><div class="card"><h2>${reg ? 'Create account' : 'Log in'}</h2>
  <div id="msg"></div><form data-form="${mode}"><label>${reg ? 'Username' : 'Username or email'}</label><input name="${reg ? 'username' : 'identifier'}" required autocomplete="username">
  ${reg ? '<label>Email</label><input name="email" type="email" required autocomplete="email">' : ''}
  <label>Password</label><input name="password" type="password" required autocomplete="${reg ? 'new-password' : 'current-password'}">
  ${reg ? '<label>Confirm password</label><input name="confirm" type="password" required autocomplete="new-password">' : ''}
  <p><button class="btn" type="submit">${reg ? 'Create account' : 'Log in'}</button></p></form>
  <p class="muted">${reg ? '<a href="#/login">I already have an account</a>' : '<a href="#/register">Create an account</a>'}${S.setupNeeded ? ' · <a href="#/setup">First-time admin setup</a>' : ''}</p></div></div>`;
}
function setupView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  root.innerHTML = `<div class="auth"><div class="brand">${logo()}<span>Admin setup</span></div>
  ${q.get('error') ? `<div class="note err">${esc(q.get('error'))}</div>` : ''}
  ${!S.setupNeeded ? '<div class="card">Setup is already complete. <a href="#/login">Log in</a></div>' :
  S.pendingAdmin ? `<div class="card"><h2>Create your admin password</h2><div id="msg"></div><form data-form="setup-admin"><label>Email</label><input name="email" type="email" required><label>Password</label><input name="password" type="password" required autocomplete="new-password"><label>Confirm password</label><input name="confirm" type="password" required autocomplete="new-password"><p><button class="btn">Create admin</button></p></form></div>` :
  `<div class="card"><h2>Connect the parent panel</h2><p class="muted">Uses the parent's OAuth sign-in. Your parent password is never shared with this panel.</p><div class="note info">Setup code: open your Render service, go to Logs, and find the line that starts with SETUP CODE.</div><div id="msg"></div><form data-form="setup-start"><label>Setup code</label><input name="setupToken" type="password" required><p><button class="btn">Connect parent account</button></p></form></div>
  <div class="card"><h2>Manual setup</h2><p class="muted">Use this if the parent sign-in does not work for you. The parent connection stays off until you connect it from Admin, Parent connection.</p><form data-form="setup-claim"><label>Setup code</label><input name="setupToken" type="password" required><label>Username</label><input name="username" required><label>Email</label><input name="email" type="email" required><label>Password</label><input name="password" type="password" required autocomplete="new-password"><label>Confirm password</label><input name="confirm" type="password" required autocomplete="new-password"><p><button class="btn sec">Create admin manually</button></p></form></div>`}</div>`;
}

// ---------- customer views ----------
const V = {};
V.dashboard = async () => {
  const d = await api('/api/dashboard'); S.balance = d.balance;
  const st = (v, l) => `<div class="card stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  return `<h1>Dashboard</h1><div class="grid">${st(inr(d.balance), 'Available balance')}${st(esc(d.totalOrders), 'Total orders')}${st(esc(d.completed), 'Completed')}${st(esc(d.pending), 'Pending')}${st(inr(d.totalDeposits), 'Total deposits')}</div>
  <div class="card"><h2>Recent orders</h2>${ordersTable(d.recentOrders)}<p><a href="#/orders">All orders</a></p></div>
  <div class="card"><h2>Recent transactions</h2>${txTable(d.recentTransactions)}</div>`;
};
const ordersTable = (rows) => table([['Order', (o) => esc(o.reference)], ['Service', (o) => esc(o.service)], ['Link', (o) => `<span class="wrap">${esc(o.link)}</span>`], ['Qty', (o) => esc(o.quantity)], ['Charge', (o) => inr(o.charge)], ['Status', (o) => tag(o.status)], ['Date', (o) => dt(o.createdAt)]], rows, 'No orders yet. Pick a service to place your first order.');
const txTable = (rows) => table([['Type', (t) => esc(label(t.type))], ['Amount', (t) => inr(t.amount)], ['Balance', (t) => inr(t.balance)], ['Note', (t) => esc(t.reason || '')], ['Date', (t) => dt(t.createdAt)]], rows, 'No transactions yet.');
V.orders = async () => `<h1>Orders</h1><div class="card">${ordersTable((await api('/api/orders')).orders)}</div>`;
V.services = async () => {
  S.services = (await api('/api/services')).services;
  const plats = ['all', ...new Set(S.services.map((s) => s.platform))];
  return `<h1>Services</h1><div class="card"><div class="chips">${plats.map((p) => `<button data-act="platform" data-v="${esc(p)}" class="${S.filter.platform === p ? 'on' : ''}">${esc(label(p))}</button>`).join('')}</div>
  <input id="svq" placeholder="Search services" value="${esc(S.filter.q)}"><div id="svlist"></div></div><div id="orderbox"></div>`;
};
function renderServiceList() {
  const q = S.filter.q.toLowerCase(); const list = S.services.filter((s) => (S.filter.platform === 'all' || s.platform === S.filter.platform) && (!q || `${s.name} ${s.category}`.toLowerCase().includes(q)));
  $('#svlist').innerHTML = table([['Service', (s) => `<span class="wrap">${esc(s.name)}</span>`], ['Category', (s) => esc(s.category)], ['Per 1000', (s) => inr(s.rate)], ['Min', (s) => esc(s.min)], ['Max', (s) => esc(s.max)], ['', (s) => `<button class="btn sm" data-act="pick" data-id="${esc(s.id)}">Order</button>`]], list, 'No services match. Try another search or platform.');
}
function orderBox(id) {
  const s = S.services.find((x) => String(x.id) === String(id)); if (!s) return;
  $('#orderbox').innerHTML = `<div class="card"><h2>${esc(s.name)}</h2>${s.description ? `<p class="muted">${esc(s.description)}</p>` : ''}<div id="msg"></div>
  <form data-form="order"><input type="hidden" name="serviceId" value="${esc(s.id)}"><label>Link</label><input name="link" type="url" required placeholder="https://"><label>Quantity (${esc(s.min)} to ${esc(s.max)})</label><input name="quantity" type="number" min="${esc(s.min)}" max="${esc(s.max)}" required>
  <p class="muted">Price: ₹${esc(s.rate)} per 1000. The final charge is calculated when you confirm.</p><p><button class="btn">Place order</button></p></form></div>`;
  $('#orderbox').scrollIntoView({ behavior: 'smooth' });
}
V.funds = async () => `<h1>Add funds</h1><div class="card"><div id="msg"></div><form data-form="deposit"><label>Amount (₹)</label><input name="amount" inputmode="decimal" required placeholder="100"><p><button class="btn">Continue to payment</button></p></form></div><div id="paybox"></div>`;
function payView(d) {
  const pending = d.status === 'pending';
  $('#paybox').innerHTML = `<div class="card"><h2>Pay with UPI ${tag(d.status)}</h2>${pending ? '<div class="note">Pay the exact amount shown, including the paise. A different amount cannot be matched.</div>' : ''}
  <div class="pay"><div>${d.qr ? `<img src="${esc(d.qr)}" alt="UPI QR code">` : '<div class="empty">QR unavailable. Use the UPI ID.</div>'}</div>
  <dl class="kv"><dt>Exact amount</dt><dd><b>${inr(d.payable)}</b></dd><dt>Requested</dt><dd>${inr(d.requested)}</dd><dt>UPI ID</dt><dd>${esc(d.upiId)}</dd><dt>Transaction ID</dt><dd>${esc(d.transactionId)}</dd><dt>Expires</dt><dd>${dt(d.expiresAt)} UTC</dd></dl></div>
  <p><a class="btn sec" href="${esc(d.upiUri)}">Open UPI app</a> ${pending ? `<button class="btn" data-act="check" data-id="${esc(d.transactionId)}">Check payment</button>` : ''}</p><div id="chk" class="muted"></div></div>`;
  clearInterval(pollTimer);
  if (pending) pollTimer = setInterval(async () => { try { const x = await api(`/api/deposits/${d.transactionId}`); if (x.status !== 'pending') { clearInterval(pollTimer); payView(x); refreshBalance(); } } catch { /* ignore */ } }, 20000);
}
V.history = async () => {
  const [d, t] = await Promise.all([api('/api/deposits'), api('/api/transactions')]);
  return `<h1>History</h1><div class="card"><h2>Deposits</h2>${table([['Transaction', (x) => esc(x.transactionId)], ['Requested', (x) => inr(x.requested)], ['To pay', (x) => inr(x.payable)], ['Status', (x) => tag(x.status)], ['Date', (x) => dt(x.createdAt)], ['', (x) => `<a class="btn sec sm" href="#/pay/${esc(x.transactionId)}">${x.status === 'pending' ? 'Open payment' : 'View'}</a>`]], d.deposits, 'No deposits yet.')}</div><div class="card"><h2>Wallet transactions</h2>${txTable(t.transactions)}</div>`;
};
V.pay = async (id) => { const d = await api(`/api/deposits/${encodeURIComponent(id)}`); setTimeout(() => payView(d)); return `<h1>Payment</h1><div id="paybox"></div>`; };
V.profile = async () => `<h1>Profile</h1><div class="card"><dl class="kv"><dt>Username</dt><dd>${esc(S.user.username)}</dd><dt>Email</dt><dd>${esc(S.user.email)}</dd></dl></div><div class="card"><h2>Change password</h2><div id="msg"></div><form data-form="password"><label>Current password</label><input name="current" type="password" required><label>New password</label><input name="password" type="password" required autocomplete="new-password"><label>Confirm new password</label><input name="confirm" type="password" required autocomplete="new-password"><p><button class="btn">Change password</button></p></form></div>`;
V.support = async () => { const s = await api('/api/support'); return `<h1>Support</h1><div class="card">${s.enabled ? `<p>Need help with an order or a payment?</p><p><a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Contact ${esc(s.name || 'support')}</a></p>` : '<div class="empty">Support is not set up yet. Please check back soon.</div>'}</div>`; };

// ---------- admin views ----------
V['admin'] = async () => { const o = await api('/api/admin/overview'); const st = (v, l) => `<div class="card stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  return `<h1>Overview</h1><div class="note">${esc(o.storageWarning)}</div>${o.awaitingAdmin ? `<div class="note err">${esc(o.awaitingAdmin)} order(s) need your action. <a href="#/admin/orders">Review</a></div>` : ''}
  ${!o.parentVerified ? '<div class="note">Parent panel is not connected. New orders will wait for admin action. <a href="#/admin/parent">Connection</a></div>' : ''}
  <div class="grid">${st(esc(o.customers), 'Customers')}${st(inr(o.liability), 'Customer wallet liability')}${st(inr(o.verifiedDeposits), 'Verified deposits')}${st(esc(o.orders), 'Orders')}${st(esc(o.pendingOrders), 'Pending orders')}${st(esc(o.completedOrders), 'Completed orders')}${st(inr(o.retailRevenue), 'Retail revenue')}${st(inr(o.wholesaleSpend), 'Wholesale spending')}${st(inr(o.grossMarkup), 'Gross markup (not profit)')}${st(tag(o.parentState), 'Parent connection')}</div><p class="muted">Last background run: ${esc(o.lastJobRun || 'never')} UTC</p>`; };
V['admin/customers'] = async () => { const c = (await api('/api/admin/customers')).customers;
  return `<h1>Customers</h1><div class="card"><div id="msg"></div>${table([['User', (u) => esc(u.username)], ['Email', (u) => esc(u.email)], ['Balance', (u) => inr(u.balance)], ['Status', (u) => tag(u.status)], ['Joined', (u) => dt(u.created_at)], ['', (u) => `<button class="btn sec sm" data-act="cust" data-id="${esc(u.id)}">Open</button>`]], c, 'No customers yet.')}</div><div id="custbox"></div>`; };
V['admin/services'] = async () => { const d = await api('/api/admin/services');
  return `<h1>Services</h1><div class="card"><div class="row"><div>Last sync: ${esc(d.lastSync || 'never')} · Global markup ${esc(d.globalMarkup)}%</div><div><button class="btn" data-act="sync">Sync now</button></div></div><div id="msg"></div></div><div class="card">${table([['ID', (s) => esc(s.parentId)], ['Service', (s) => `<span class="wrap">${esc(s.name)}</span>`], ['Platform', (s) => esc(s.platform)], ['Wholesale', (s) => inr(s.wholesale)], ['Retail', (s) => inr(s.retail)], ['Markup %', (s) => `<input class="mk" data-id="${esc(s.id)}" value="${esc(s.markup ?? '')}" placeholder="global">`], ['On', (s) => `<input type="checkbox" data-act="toggle" data-id="${esc(s.id)}" ${s.enabled ? 'checked' : ''}>`], ['Parent', (s) => (s.available ? tag('active') : '<span class="tag bad">Missing</span>')]], d.services, 'No services yet. Connect the parent panel and press Sync now.')}</div>`; };
V['admin/orders'] = async () => { const o = (await api('/api/admin/orders')).orders;
  return `<h1>Orders</h1><div class="card"><div id="msg"></div>${table([['Ref', (x) => esc(x.reference)], ['User', (x) => esc(x.username)], ['Service', (x) => esc(x.service)], ['Qty', (x) => esc(x.quantity)], ['Retail', (x) => inr(x.retail)], ['Wholesale', (x) => (x.wholesale === null ? '-' : inr(x.wholesale))], ['Parent ID', (x) => esc(x.parentOrderId || '-')], ['Status', (x) => tag(x.status)], ['Note', (x) => `<span class="wrap">${esc(x.lastError || '')}</span>`],
   ['', (x) => `<button class="btn sec sm" data-act="ev" data-id="${esc(x.id)}">Events</button> ${!x.parentOrderId && ['pending', 'awaiting_admin'].includes(x.status) ? `<button class="btn sm" data-act="retry" data-id="${esc(x.id)}">Retry</button>` : ''} ${Number(x.refunded) === 0 && ['failed', 'canceled', 'partial', 'awaiting_admin'].includes(x.status) ? `<button class="btn danger sm" data-act="refund" data-id="${esc(x.id)}">Refund</button>` : ''}`]], o, 'No orders yet.')}</div><div id="evbox"></div>`; };
V['admin/deposits'] = async () => { const d = await api('/api/admin/deposits');
  return `<h1>Deposits</h1><div class="card"><div id="msg"></div>${table([['Transaction', (x) => esc(x.transactionId)], ['User', (x) => esc(x.username)], ['Requested', (x) => inr(x.requested)], ['Payable', (x) => inr(x.payable)], ['Status', (x) => tag(x.status)], ['Checks', (x) => esc(x.attempts)], ['Result', (x) => esc(x.result || '')], ['Created', (x) => dt(x.createdAt)], ['', (x) => (['pending', 'review'].includes(x.status) ? `<button class="btn sec sm" data-act="vdep" data-id="${esc(x.id)}">Verify now</button>` : '')]], d.deposits, 'No deposits yet.')}</div>
  <div class="card"><h2>Notifications seen</h2>${table([['Sender', (n) => esc(n.sender)], ['Amount', (n) => (n.amount === null ? '-' : inr(n.amount))], ['Received', (n) => dt(n.received_at)], ['Outcome', (n) => tag(n.outcome === 'credited' ? 'paid' : n.outcome)]], d.notifications, 'No payment emails seen yet.')}</div>`; };
V['admin/transactions'] = async () => `<h1>Customer transactions</h1><div class="card">${table([['User', (t) => esc(t.username)], ['Type', (t) => esc(label(t.type))], ['Amount', (t) => inr(t.amount)], ['Balance', (t) => inr(t.balance)], ['Reason', (t) => esc(t.reason || '')], ['Date', (t) => dt(t.createdAt)]], (await api('/api/admin/transactions')).transactions, 'No transactions yet.')}</div>`;
V['admin/parent'] = async () => { const p = await api('/api/admin/parent'); const q = new URLSearchParams(location.hash.split('?')[1] || '');
  return `<h1>Parent connection</h1>${q.get('error') ? `<div class="note err">${esc(q.get('error'))}</div>` : ''}<div class="card"><dl class="kv"><dt>Status</dt><dd>${tag(p.state)} ${p.apiVerified ? '' : '<span class="tag warn">Not connected yet</span>'}</dd><dt>Parent website</dt><dd>${esc(p.websiteUrl)}</dd><dt>Docs URL</dt><dd>${esc(p.docsUrl)}</dd><dt>API base URL</dt><dd>${esc(p.apiBaseUrl)}</dd><dt>Account</dt><dd>${esc(p.account || '-')}</dd><dt>Last check</dt><dd>${esc(p.lastProbe || 'never')}</dd><dt>Last error</dt><dd>${esc(p.lastError || '-')}</dd></dl>
  <div id="msg"></div>
  <p><button class="btn" data-act="pconnect">${p.state === 'connected' ? 'Reauthorize' : 'Connect'}</button> <button class="btn sec" data-act="pprobe">Test connection</button> <button class="btn sec" data-act="pwallet">Show parent wallet</button> <button class="btn danger" data-act="pdisc">Disconnect</button></p><div id="pw"></div></div>`; };
V['admin/refills'] = async () => { const r = (await api('/api/admin/refills')).refills;
  return `<h1>Parent wallet refills</h1><div class="note info">These top up your wholesale wallet at the parent panel. They are separate from customer deposits.</div><div class="card"><div id="msg"></div><form data-form="refill" class="row"><div><label>Amount (₹)</label><input name="amount" inputmode="decimal" required></div><div><button class="btn">Create refill</button></div></form></div><div class="card">${table([['Reference', (x) => esc(x.reference)], ['Requested', (x) => inr(x.amount)], ['Pay exactly', (x) => inr(x.payable)], ['Status', (x) => tag(x.status)], ['Expires', (x) => esc(x.expires_at || '-')], ['Pay', (x) => (x.payment_url && /^https:\/\//.test(x.payment_url) ? `<a href="${esc(x.payment_url)}" target="_blank" rel="noopener noreferrer">Open</a>` : '-')], ['', (x) => (x.status === 'pending' ? `<button class="btn sec sm" data-act="vref" data-id="${esc(x.id)}">Verify</button>` : '')]], r, 'No refills yet.')}</div>`; };
V['admin/logs'] = async () => `<h1>Activity logs</h1><div class="card">${table([['When', (l) => dt(l.created_at)], ['Who', (l) => esc(l.username || 'system')], ['Action', (l) => esc(l.action)], ['Detail', (l) => `<span class="wrap">${esc(l.detail || '')}</span>`]], (await api('/api/admin/logs')).logs, 'No activity yet.')}</div>`;
V['admin/backup'] = async () => `<h1>Backup and restore</h1><div class="note">Database storage is temporary. Render Free may erase local files during restart, spin-down, or redeployment. Download regular backups to avoid losing data.</div><div class="card"><h2>Download</h2><p><a class="btn" href="/api/admin/backup" download>Download backup</a></p></div><div class="card"><h2>Restore</h2><div id="msg"></div><p class="muted">Replaces all current data. A safety copy of the current database is kept on the server when possible. You will need to log in again. If this server was reset, the Gmail app password, Discord token and parent connection are cleared and must be entered again.</p><input id="rfile" type="file" accept=".sqlite,.db"><p><button class="btn danger" data-act="restore">Restore backup</button></p></div>`;
V['admin/settings'] = async () => { const s = await api('/api/admin/settings'); const f = (n, l, v, extra = '') => `<label>${l}</label><input name="${n}" value="${esc(v ?? '')}" ${extra}>`;
  return `<h1>Settings</h1><div id="msg"></div>
  <div class="card"><h2>General</h2><form data-form="set-general">${f('appUrl', 'Public address of this panel (https)', s.appUrl)}<p class="muted">${s.appUrlSaved ? 'Saved.' : 'Detected automatically. Save it to lock it in.'} The parent sends you back to this address after you authorize. If you change it, reconnect the parent.</p><p><button class="btn">Save</button></p></form></div>
  <div class="card"><h2>Payments (FamPay)</h2><form data-form="set-pay">${f('fampayUpiId', 'Your FamPay UPI ID', s.fampayUpiId)}${f('gmailAddress', 'Gmail address that receives FamPay emails', s.gmailAddress)}<label>Gmail app password ${s.gmailPasswordSet ? '(saved, leave blank to keep)' : ''}</label><input name="gmailAppPassword" type="password" autocomplete="off">${f('allowedSenders', 'FamPay sender email address(es), comma separated', s.allowedSenders)}
  <label><input type="checkbox" name="requireDkim" ${s.requireDkim ? 'checked' : ''}> Require the email to pass DKIM/SPF (recommended)</label>${f('minDeposit', 'Minimum deposit (₹)', s.minDeposit)}${f('maxDeposit', 'Maximum deposit (₹)', s.maxDeposit)}${f('expiryMinutes', 'Deposit expiry (minutes)', s.expiryMinutes)}
  <p><button class="btn">Save</button> <button class="btn sec" type="button" data-act="gtest">Test Gmail</button></p><div id="gres"></div></form></div>
  <div class="card"><h2>Pricing</h2><form data-form="set-price">${f('globalMarkup', 'Global markup (%)', s.globalMarkup)}<p><button class="btn">Save</button></p></form></div>
  <div class="card"><h2>Discord deposit logs</h2><form data-form="set-discord"><label>Bot token ${s.discordTokenSet ? '(saved, leave blank to keep)' : ''}</label><input name="discordToken" type="password" autocomplete="off">${f('discordChannelId', 'Channel ID', s.discordChannelId)}<p><button class="btn">Save</button></p></form></div>
  <div class="card"><h2>Customer support</h2><form data-form="set-support">${f('url', 'Support URL (https only)', s.support.url)}${f('displayName', 'Display name', s.support.display_name)}<label><input type="checkbox" name="enabled" ${s.support.enabled ? 'checked' : ''}> Show support to customers</label><p><button class="btn">Save</button></p></form></div>
  <div class="card"><h2>Branding</h2><form data-form="set-brand">${f('panelName', 'Panel name', s.panelName)}${f('logoUrl', 'Logo URL (https)', s.logoUrl)}${f('faviconUrl', 'Favicon URL (https)', s.faviconUrl)}${f('accent', 'Accent color (#RRGGBB)', s.accent)}<p><button class="btn">Save</button></p></form></div>`; };

// ---------- routing ----------
async function route() {
  clearInterval(pollTimer);
  const hash = (location.hash || '#/').slice(2).split('?')[0];
  if (!S.user) { if (hash === 'register') return authView('register'); if (hash === 'setup') return setupView(); return authView('login'); }
  const admin = S.user.role === 'super_admin';
  let r = hash || (admin ? 'admin' : 'dashboard');
  const m = /^pay\/(.+)$/.exec(r); const arg = m ? m[1] : null; if (m) r = 'pay';
  if (['login', 'register', 'setup'].includes(r)) r = admin ? 'admin' : 'dashboard';
  if (admin && !r.startsWith('admin')) r = 'admin';
  if (!admin && r.startsWith('admin')) r = 'dashboard';
  if (!V[r]) r = admin ? 'admin' : 'dashboard';
  try { if (!admin && S.balance === null) await refreshBalance(); const html = await V[r](arg); shell(r, html); if (r === 'services') renderServiceList(); }
  catch (e) { if (e.status === 401) { S.user = null; return route(); } shell(r, `<div class="note err">${esc(e.message)}</div>`); }
}
const msg = (t, ok) => { const m = $('#msg'); if (m) { m.innerHTML = t ? `<div class="note ${ok ? 'info' : 'err'}">${esc(t)}</div>` : ''; } else toast(t); };
const fd = (form) => { const o = {}; for (const el of form.elements) { if (!el.name) continue; o[el.name] = el.type === 'checkbox' ? el.checked : el.value; } return o; };

const FORMS = {
  async login(b) { const r = await api('/api/auth/login', { method: 'POST', body: b }); S.csrf = r.csrf; await boot(); location.hash = '#/'; },
  async register(b) { await api('/api/auth/register', { method: 'POST', body: b }); await FORMS.login({ identifier: b.username, password: b.password }); },
  async 'setup-start'(b) { const r = await api('/api/setup/start', { method: 'POST', body: b }); location.href = r.url; },
  async 'setup-admin'(b) { const r = await api('/api/setup/admin', { method: 'POST', body: b }); S.csrf = r.csrf; await boot(); location.hash = '#/admin'; },
  async 'setup-claim'(b) { const r = await api('/api/setup/claim', { method: 'POST', body: b }); S.csrf = r.csrf; await boot(); location.hash = '#/admin'; },
  async order(b) { const r = await api('/api/orders', { method: 'POST', body: { serviceId: b.serviceId, link: b.link, quantity: b.quantity } }); toast(`Order ${r.reference} placed. Charged ₹${r.charge}.`); refreshBalance(); location.hash = '#/orders'; },
  async deposit(b) { const d = await api('/api/deposits', { method: 'POST', body: b }); payView(d); },
  async password(b) { await api('/api/me/password', { method: 'POST', body: b }); toast('Password changed. Please log in again.'); S.user = null; await boot(); route(); },
  async refill(b) { await api('/api/admin/refills', { method: 'POST', body: b }); toast('Refill created'); route(); },
  async 'set-pay'(b) { await api('/api/admin/settings', { method: 'PUT', body: { fampayUpiId: b.fampayUpiId, gmailAddress: b.gmailAddress, gmailAppPassword: b.gmailAppPassword, allowedSenders: b.allowedSenders, requireDkim: b.requireDkim, minDeposit: b.minDeposit, maxDeposit: b.maxDeposit, expiryMinutes: b.expiryMinutes } }); toast('Saved'); },
  async 'set-general'(b) { await api('/api/admin/settings', { method: 'PUT', body: { appUrl: b.appUrl } }); toast('Saved'); },
  async 'set-price'(b) { await api('/api/admin/settings', { method: 'PUT', body: { globalMarkup: b.globalMarkup } }); toast('Saved'); },
  async 'set-discord'(b) { await api('/api/admin/settings', { method: 'PUT', body: { discordToken: b.discordToken, discordChannelId: b.discordChannelId } }); toast('Saved'); },
  async 'set-support'(b) { await api('/api/admin/settings', { method: 'PUT', body: { support: { url: b.url, displayName: b.displayName, enabled: b.enabled } } }); toast('Saved'); },
  async 'set-brand'(b) { await api('/api/admin/settings', { method: 'PUT', body: b }); toast('Saved'); await boot(); },
};
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
  const btn = f.querySelector('button:not([type=button])'); if (btn) btn.disabled = true;
  try { await FORMS[f.dataset.form](fd(f)); } catch (err) { msg(err.message); } finally { if (btn) btn.disabled = false; }
});

const ACT = {
  async logout() { await api('/api/auth/logout', { method: 'POST' }); S.user = null; S.balance = null; await boot(); location.hash = '#/login'; route(); },
  platform(el) { S.filter.platform = el.dataset.v; route(); },
  pick(el) { orderBox(el.dataset.id); },
  async check(el) { const r = await api(`/api/deposits/${encodeURIComponent(el.dataset.id)}/check`, { method: 'POST' }); const c = $('#chk');
    if (r.status === 'paid') { toast('Payment verified. Wallet credited.'); refreshBalance(); payView(await api(`/api/deposits/${encodeURIComponent(el.dataset.id)}`)); }
    else if (r.wait) c.textContent = `Payment not found yet. Try again in ${r.wait} seconds.`; else if (r.status !== 'pending') payView(await api(`/api/deposits/${encodeURIComponent(el.dataset.id)}`)); else c.textContent = 'Payment not found yet. It can take a minute or two after you pay.'; },
  async cust(el) { const d = await api(`/api/admin/customers/${el.dataset.id}`);
    $('#custbox').innerHTML = `<div class="card"><h2>${esc(d.user.username)} ${tag(d.user.status)}</h2><p>Balance ${inr(d.balance)} · ${esc(d.user.email)}</p>
      <p><button class="btn sec sm" data-act="cstatus" data-id="${esc(d.user.id)}" data-v="${d.user.status === 'active' ? 'suspended' : 'active'}">${d.user.status === 'active' ? 'Suspend' : 'Restore'}</button></p>
      <form data-form-adjust="${esc(d.user.id)}" class="row"><div><label>Amount (use - to deduct)</label><input name="amount" required></div><div><label>Reason</label><input name="reason" required></div><div><button class="btn">Adjust balance</button></div></form>
      <h2>Transactions</h2>${txTable(d.transactions)}<h2>Orders</h2>${ordersTable(d.orders)}</div>`; },
  async cstatus(el) { await api(`/api/admin/customers/${el.dataset.id}/status`, { method: 'POST', body: { status: el.dataset.v } }); toast('Updated'); route(); },
  async sync() { const r = await api('/api/admin/services/sync', { method: 'POST' }); toast(`Synced ${r.synced} services`); route(); },
  async toggle(el) { await api(`/api/admin/services/${el.dataset.id}`, { method: 'POST', body: { enabled: el.checked } }); },
  async ev(el) { const e = (await api(`/api/admin/orders/${el.dataset.id}`)).events; $('#evbox').innerHTML = `<div class="card"><h2>Order events</h2>${table([['When', (x) => dt(x.created_at)], ['Event', (x) => esc(x.event)], ['Detail', (x) => `<span class="wrap">${esc(x.detail || '')}</span>`]], e, 'No events.')}</div>`; },
  async retry(el) { const r = await api(`/api/admin/orders/${el.dataset.id}/retry`, { method: 'POST' }); toast(`Retry result: ${r.status || 'done'}`); route(); },
  async refund(el) { if (!confirm('Refund this order to the customer wallet? This can only be done once.')) return; const r = await api(`/api/admin/orders/${el.dataset.id}/refund`, { method: 'POST', body: { reason: 'admin' } }); toast(r.refunded ? 'Refunded' : 'Already refunded'); route(); },
  async vdep(el) { const r = await api(`/api/admin/deposits/${el.dataset.id}/verify`, { method: 'POST' }); toast(r.error ? `Check failed: ${r.error}` : `Credited ${r.credited}, review ${r.review}`); route(); },
  async vref(el) { const r = await api(`/api/admin/refills/${el.dataset.id}/verify`, { method: 'POST' }); toast(`Refill is ${r.status}`); route(); },
  async gtest() { const r = await api('/api/admin/settings/gmail-test', { method: 'POST' }); $('#gres').innerHTML = r.ok ? `<div class="note info">Connected. ${esc(r.notifications.length)} recent email(s) found.</div>${table([['Sender', (n) => esc(n.sender)], ['Amount read', (n) => (n.amount === null ? 'none' : inr(n.amount))], ['Signed', (n) => (n.authPass ? 'Yes' : 'No')], ['Has ID', (n) => (n.hasId ? 'Yes' : 'No')]], r.notifications, 'No emails from the configured sender yet.')}` : `<div class="note err">${esc(r.error)}</div>`; },
  async pconnect() { const r = await api('/api/admin/parent/connect', { method: 'POST' }); location.href = r.url; },
  async pprobe() { const r = await api('/api/admin/parent/probe', { method: 'POST' }); toast(r.ok ? 'Parent connection verified' : `Not verified: ${r.error}`); route(); },
  async pdisc() { if (!confirm('Disconnect the parent panel?')) return; await api('/api/admin/parent/disconnect', { method: 'POST' }); toast('Disconnected'); route(); },
  async pwallet() { const w = await api('/api/admin/parent/wallet'); $('#pw').innerHTML = `<div class="note info">Parent wallet balance: ${esc(w.balance ?? 'unknown')} ${esc(w.currency || '')}</div>`; },
  async restore() { const f = $('#rfile').files[0]; if (!f) return msg('Choose a backup file first'); if (!confirm('Replace ALL current data with this backup?')) return;
    const r = await api('/api/admin/restore', { method: 'POST', body: await f.arrayBuffer(), raw: true }); toast(r.secretsCleared && r.secretsCleared.length ? `Restored. Re-enter: ${r.secretsCleared.join(', ')}. Please log in again.` : 'Restored. Please log in again.'); S.user = null; await boot(); location.hash = '#/login'; route(); },
};
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el || el.type === 'checkbox') return; const fn = ACT[el.dataset.act]; if (!fn) return;
  el.disabled = true; try { await fn(el); } catch (err) { msg(err.message); } finally { el.disabled = false; }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.act === 'toggle') { try { await ACT.toggle(el); } catch (err) { toast(err.message); el.checked = !el.checked; } }
  if (el.classList && el.classList.contains('mk')) { try { await api(`/api/admin/services/${el.dataset.id}`, { method: 'POST', body: { markup: el.value.trim() === '' ? null : el.value.trim() } }); toast('Markup saved'); } catch (err) { toast(err.message); } }
});
document.addEventListener('input', (e) => { if (e.target.id === 'svq') { S.filter.q = e.target.value; renderServiceList(); } });
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form-adjust]'); if (!f) return; e.preventDefault();
  try { const b = fd(f); await api(`/api/admin/customers/${f.dataset.formAdjust}/adjust`, { method: 'POST', body: b }); toast('Balance adjusted'); ACT.cust({ dataset: { id: f.dataset.formAdjust } }); } catch (err) { toast(err.message); }
});

async function boot() {
  const s = await api('/api/session'); S.csrf = s.csrf; S.user = s.user; S.cfg = s.settings || {}; S.setupNeeded = s.setupNeeded; S.setupEnabled = s.setupEnabled; S.pendingAdmin = s.pendingAdmin; applyBrand();
}
window.addEventListener('hashchange', route);
boot().then(route).catch(() => { root.innerHTML = '<div class="auth"><div class="note err">Could not reach the server. Refresh to try again.</div></div>'; });
