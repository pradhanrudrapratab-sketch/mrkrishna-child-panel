(function () {
  'use strict';
  const { esc, inr, api, badge, date, table, toast, kv, trunc, field, formData } = MK;
  let me = null; const num = (n) => Number(n).toLocaleString('en-IN');
  const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;
  const note = (t, cls) => `<div class="notice ${cls || ''}" role="${cls === 'err' ? 'alert' : 'note'}">${t}</div>`;
  const msgBox = '<div id="msg" class="notice err" role="alert" hidden></div>';
  const showErr = (e) => { const m = document.getElementById('msg'); if (m) { m.textContent = e.message; m.hidden = false; } else toast(e.message, 'err'); };
  // Wire a form: disables the button while saving, shows errors inline.
  const bind = (id, fn) => { const f = document.getElementById(id); if (!f) return; f.addEventListener('submit', async (e) => { e.preventDefault(); const b = f.querySelector('button[type=submit]'); if (b) b.disabled = true; const m = document.getElementById('msg'); if (m) m.hidden = true; try { await fn(formData(f), f); } catch (ex) { showErr(ex); } finally { if (b) b.disabled = false; } }); };
  const act = (root, name, fn) => root.querySelectorAll(`[data-act="${name}"]`).forEach((el) => el.addEventListener('click', async () => { el.disabled = true; try { await fn(el); } catch (ex) { toast(ex.message, 'err'); } finally { el.disabled = false; } }));

  async function overview(m, ctx) {
    const o = await api('/api/admin/overview');
    ctx.set(`<h1>Overview</h1>${note(esc(o.storageWarning), 'warn')}
      ${o.awaitingAdmin ? note(`${esc(o.awaitingAdmin)} order(s) need your action. <a href="#/orders">Review them</a>`, 'err') : ''}
      ${!o.parentVerified ? note('The parent panel is not connected. New orders will wait for you. <a href="#/parent">Open connection</a>', 'warn') : ''}
      <div class="stats">${stat(num(o.customers), 'Customers')}${stat(inr(o.liability), 'Customer wallet liability')}${stat(inr(o.verifiedDeposits), 'Verified deposits')}${stat(num(o.orders), 'Orders')}${stat(num(o.pendingOrders), 'Pending orders')}${stat(num(o.completedOrders), 'Completed orders')}</div>
      <div class="stats">${stat(inr(o.retailRevenue), 'Retail revenue')}${stat(inr(o.wholesaleSpend), 'Wholesale spending')}${stat(inr(o.grossMarkup), 'Gross markup (not profit)')}${stat(badge(o.parentState, true), 'Parent connection')}</div>
      <p class="hint">Last background run: ${esc(date(o.lastJobRun))}. Gross markup is retail revenue minus wholesale spending; it excludes payment, hosting and other costs.</p>`);
  }

  async function customers(m, ctx) {
    const q = ctx.params.get('q') || ''; const list = (await api('/api/admin/customers' + (q ? '?q=' + encodeURIComponent(q) : ''))).customers;
    ctx.set(`<h1>Customers</h1><form class="row mb" id="sf"><input class="grow" name="q" type="search" placeholder="Search username or email" value="${esc(q)}" aria-label="Search customers"><button class="btn" type="submit">Search</button></form>
      ${table([{ h: 'Username', f: (u) => `<a href="#/customers/${esc(u.id)}">${esc(u.username)}</a>` }, { h: 'Email', f: (u) => esc(u.email) }, { h: 'Balance', cls: 'r', f: (u) => inr(u.balance) }, { h: 'Status', f: (u) => badge(u.status) }, { h: 'Joined', f: (u) => esc(date(u.created_at)) }], list, { href: (u) => '#/customers/' + u.id, empty: 'No customers yet.' })}`);
    document.getElementById('sf').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/customers?q=' + encodeURIComponent(new FormData(e.target).get('q')); });
  }
  async function customer(m, ctx) {
    const d = await api('/api/admin/customers/' + m[1]); const u = d.user;
    ctx.set(`<a class="pub-back" href="#/customers">← Customers</a><h1>${esc(u.username)} ${badge(u.status)}</h1>
      <div class="grid2"><div class="card"><h3>Account</h3>${kv([['Email', esc(u.email)], ['Joined', esc(date(u.created_at))], ['Wallet balance', `<b>${inr(d.balance)}</b>`]])}
      <p><button class="btn small ${u.status === 'active' ? 'danger' : ''}" data-act="status" data-v="${u.status === 'active' ? 'suspended' : 'active'}">${u.status === 'active' ? 'Suspend account' : 'Restore account'}</button></p></div>
      <form class="card" id="af" novalidate><h3>Adjust wallet</h3>${msgBox}${field('amount', 'Amount (use - to deduct)', '', { req: true, ph: '100 or -50' })}${field('reason', 'Reason (recorded in the audit log)', '', { req: true })}<button class="btn primary" type="submit">Apply adjustment</button></form></div>
      <h2>Transactions</h2>${table([{ h: 'Date', f: (t) => esc(date(t.createdAt)) }, { h: 'Type', f: (t) => esc(MK.LABEL[t.type] || t.type) }, { h: 'Details', cls: 'wide', f: (t) => esc(t.reason || '') }, { h: 'Amount', cls: 'r', f: (t) => MK.money(t.amount) }, { h: 'Balance', cls: 'r', f: (t) => inr(t.balance) }], d.transactions, { empty: 'No transactions.' })}
      <h2>Orders</h2>${table([{ h: 'Order', f: (o) => `<span class="mono">${esc(o.reference)}</span>` }, { h: 'Service', cls: 'wide', f: (o) => esc(trunc(o.service, 48)) }, { h: 'Qty', cls: 'r', f: (o) => num(o.quantity) }, { h: 'Amount', cls: 'r', f: (o) => inr(o.charge) }, { h: 'Status', f: (o) => badge(o.status, true) }], d.orders, { empty: 'No orders.' })}`);
    act(ctx.view, 'status', async (el) => { await api(`/api/admin/customers/${u.id}/status`, { method: 'POST', body: { status: el.dataset.v } }); toast('Updated', 'ok'); customer(m, ctx); });
    bind('af', async (b) => { await api(`/api/admin/customers/${u.id}/adjust`, { method: 'POST', body: b }); toast('Wallet adjusted', 'ok'); customer(m, ctx); });
  }

  async function services(m, ctx) {
    const d = await api('/api/admin/services'); const q = (ctx.params.get('q') || '').toLowerCase();
    const rows = d.services.filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.parentId) === q);
    ctx.set(`<h1>Services</h1><div class="card"><div class="row between"><div>Last sync: <b>${esc(date(d.lastSync))}</b><br><span class="muted">Global markup ${esc(d.globalMarkup)}%. Services also sync automatically about twice a day.</span></div><button class="btn primary" data-act="sync">Sync now</button></div></div>
      <form class="row mb" id="sf"><input class="grow" name="q" type="search" placeholder="Search by name or parent ID" value="${esc(ctx.params.get('q') || '')}"><button class="btn" type="submit">Search</button></form>
      ${table([{ h: 'ID', f: (s) => esc(s.parentId) }, { h: 'Service', cls: 'wide', f: (s) => esc(trunc(s.name, 70)) }, { h: 'Platform', f: (s) => esc(s.platform || '') }, { h: 'Wholesale', cls: 'r', f: (s) => inr(s.wholesale) }, { h: 'Retail', cls: 'r', f: (s) => inr(s.retail) },
        { h: 'Markup %', f: (s) => `<input class="inline-input" data-mk="${esc(s.id)}" value="${esc(s.markup ?? '')}" placeholder="global" aria-label="Markup for ${esc(s.name)}">` }, { h: 'Visible', f: (s) => `<input type="checkbox" data-en="${esc(s.id)}" ${s.enabled ? 'checked' : ''} aria-label="Visible to customers">` }, { h: 'At parent', f: (s) => (s.available ? badge('active') : '<span class="badge s-FAILED">Missing</span>') }], rows.slice(0, 300), { empty: 'No services yet. Connect the parent panel, then press Sync now.' })}
      ${rows.length > 300 ? `<p class="hint">Showing 300 of ${num(rows.length)}. Use search to narrow down.</p>` : ''}`);
    act(ctx.view, 'sync', async () => { const r = await api('/api/admin/services/sync', { method: 'POST', body: {} }); toast(`Synced ${r.synced} services` + (r.skippedUnsupportedType ? ` (${r.skippedUnsupportedType} skipped: unsupported type)` : ''), 'ok'); services(m, ctx); });
    document.getElementById('sf').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/services?q=' + encodeURIComponent(new FormData(e.target).get('q')); });
    ctx.view.querySelectorAll('[data-mk]').forEach((el) => el.addEventListener('change', async () => { try { await api('/api/admin/services/' + el.dataset.mk, { method: 'POST', body: { markup: el.value.trim() === '' ? null : el.value.trim() } }); toast('Markup saved', 'ok'); } catch (ex) { toast(ex.message, 'err'); } }));
    ctx.view.querySelectorAll('[data-en]').forEach((el) => el.addEventListener('change', async () => { try { await api('/api/admin/services/' + el.dataset.en, { method: 'POST', body: { enabled: el.checked } }); } catch (ex) { toast(ex.message, 'err'); el.checked = !el.checked; } }));
  }

  async function orders(m, ctx) {
    const list = (await api('/api/admin/orders')).orders;
    ctx.set(`<h1>Orders</h1>${table([{ h: 'Ref', f: (x) => `<span class="mono">${esc(x.reference)}</span>` }, { h: 'Customer', f: (x) => esc(x.username) }, { h: 'Service', cls: 'wide', f: (x) => esc(trunc(x.service, 40)) }, { h: 'Qty', cls: 'r', f: (x) => num(x.quantity) }, { h: 'Retail', cls: 'r', f: (x) => inr(x.retail) },
      { h: 'Wholesale', cls: 'r', f: (x) => (x.wholesale === null ? '–' : inr(x.wholesale)) }, { h: 'Parent ID', f: (x) => esc(x.parentOrderId || '–') }, { h: 'Status', f: (x) => badge(x.status, true) }, { h: 'Note', cls: 'wide', f: (x) => esc(x.lastError || '') },
      { h: '', f: (x) => `<button class="btn small" data-act="ev" data-id="${esc(x.id)}">Events</button> ${!x.parentOrderId && ['pending', 'awaiting_admin'].includes(x.status) ? `<button class="btn small primary" data-act="retry" data-id="${esc(x.id)}">Retry</button>` : ''} ${Number(x.refunded) === 0 && ['failed', 'canceled', 'partial', 'awaiting_admin'].includes(x.status) ? `<button class="btn small danger" data-act="refund" data-id="${esc(x.id)}">Refund</button>` : ''}` }], list, { empty: 'No orders yet.' })}<div id="evbox"></div>`);
    act(ctx.view, 'ev', async (el) => { const e = (await api('/api/admin/orders/' + el.dataset.id)).events; document.getElementById('evbox').innerHTML = `<h2>Order events</h2>${table([{ h: 'When', f: (x) => esc(date(x.created_at)) }, { h: 'Event', f: (x) => esc(x.event) }, { h: 'Detail', cls: 'wide', f: (x) => esc(x.detail || '') }], e, { empty: 'No events.' })}`; });
    act(ctx.view, 'retry', async (el) => { const r = await api(`/api/admin/orders/${el.dataset.id}/retry`, { method: 'POST', body: {} }); toast(`Retry result: ${r.status || 'done'}`, 'ok'); orders(m, ctx); });
    act(ctx.view, 'refund', async (el) => { if (!confirm('Refund this order to the customer wallet? A refund can only be issued once.')) return; const r = await api(`/api/admin/orders/${el.dataset.id}/refund`, { method: 'POST', body: { reason: 'admin' } }); toast(r.refunded ? 'Refunded' : 'Already refunded', 'ok'); orders(m, ctx); });
  }

  async function deposits(m, ctx) {
    const d = await api('/api/admin/deposits');
    ctx.set(`<h1>Deposits</h1>${table([{ h: 'Transaction', f: (x) => `<span class="mono">${esc(x.transactionId)}</span>` }, { h: 'Customer', f: (x) => esc(x.username) }, { h: 'Requested', cls: 'r', f: (x) => inr(x.requested) }, { h: 'Payable', cls: 'r', f: (x) => inr(x.payable) }, { h: 'Status', f: (x) => badge(x.status, true) }, { h: 'Checks', cls: 'r', f: (x) => esc(x.attempts) },
      { h: 'Result', f: (x) => esc(x.result || '') }, { h: 'Created', f: (x) => esc(date(x.createdAt)) }, { h: '', f: (x) => (['pending', 'review'].includes(x.status) ? `<button class="btn small" data-act="vdep" data-id="${esc(x.id)}">Verify now</button>` : '') }], d.deposits, { empty: 'No deposits yet.' })}
      <h2>Payment emails seen</h2>${table([{ h: 'Sender', f: (n) => esc(n.sender || '') }, { h: 'Amount', cls: 'r', f: (n) => (n.amount === null ? '–' : inr(n.amount)) }, { h: 'Received', f: (n) => esc(date(n.received_at)) }, { h: 'Outcome', f: (n) => badge(n.outcome === 'credited' ? 'paid' : n.outcome) }], d.notifications, { empty: 'No payment emails seen yet.' })}`);
    act(ctx.view, 'vdep', async (el) => { const r = await api(`/api/admin/deposits/${el.dataset.id}/verify`, { method: 'POST', body: {} }); toast(r.error ? `Check failed: ${r.error}` : `Credited ${r.credited}, needs review ${r.review}`, r.error ? 'err' : 'ok'); deposits(m, ctx); });
  }
  const transactions = async (m, ctx) => ctx.set(`<h1>Customer transactions</h1>${table([{ h: 'Customer', f: (t) => esc(t.username) }, { h: 'Type', f: (t) => esc(MK.LABEL[t.type] || t.type) }, { h: 'Amount', cls: 'r', f: (t) => MK.money(t.amount) }, { h: 'Balance', cls: 'r', f: (t) => inr(t.balance) }, { h: 'Reason', cls: 'wide', f: (t) => esc(t.reason || '') }, { h: 'Date', f: (t) => esc(date(t.createdAt)) }], (await api('/api/admin/transactions')).transactions, { empty: 'No transactions yet.' })}`);

  async function parent(m, ctx) {
    const p = await api('/api/admin/parent'); const e = ctx.params.get('error');
    ctx.set(`<h1>Parent connection</h1>${e ? note(esc(e), 'err') : ''}<div class="card">${kv([['Status', `${badge(p.state, true)} ${p.apiVerified ? '' : '<span class="muted">not verified</span>'}`], ['Parent website', esc(p.websiteUrl)], ['API base URL', `<span class="mono">${esc(p.apiBaseUrl)}/api/v1</span>`], ['Connected account', esc(p.account || '–')], ['Last check', esc(date(p.lastProbe))], ['Last error', esc(p.lastError || '–')]])}
      <div class="row" id="pbtns"><button class="btn primary" data-act="connect">${p.state === 'connected' ? 'Reauthorize' : 'Connect parent account'}</button><button class="btn" data-act="probe">Test connection</button><button class="btn" data-act="wallet">Show parent wallet</button><button class="btn danger" data-act="disc">Disconnect</button></div><div id="pw" class="mb"></div></div>
      <p class="hint">Reauthorizing issues a new token and the old one stops working. The token is stored encrypted and never leaves the server. The parent does not offer token refresh, so if the token is revoked or rejected you reconnect here.</p>`);
    act(ctx.view, 'connect', async () => { const r = await api('/api/admin/parent/connect', { method: 'POST', body: {} }); location.href = r.url; });
    act(ctx.view, 'probe', async () => { const r = await api('/api/admin/parent/probe', { method: 'POST', body: {} }); toast(r.ok ? 'Parent connection verified' : `Not verified: ${r.error}`, r.ok ? 'ok' : 'err'); parent(m, ctx); });
    act(ctx.view, 'wallet', async () => { const w = await api('/api/admin/parent/wallet'); document.getElementById('pw').innerHTML = `<br>${note(`Parent wallet balance: <b>${esc(w.balance ?? 'unknown')} ${esc(w.currency || '')}</b>`, 'info')}`; });
    act(ctx.view, 'disc', async () => { if (!confirm('Disconnect the parent panel? New orders will wait until you reconnect.')) return; await api('/api/admin/parent/disconnect', { method: 'POST', body: {} }); toast('Disconnected', 'ok'); parent(m, ctx); });
  }
  async function refills(m, ctx) {
    const r = (await api('/api/admin/refills')).refills;
    ctx.set(`<h1>Parent wallet refills</h1>${note('These top up your wholesale wallet at the parent panel. They are separate from customer deposits.', 'info')}<form class="card row" id="rf">${msgBox}<div class="grow">${field('amount', 'Amount (₹)', '', { req: true, ph: '500' })}</div><button class="btn primary" type="submit">Create refill</button></form>
      ${table([{ h: 'Reference', f: (x) => `<span class="mono">${esc(x.reference)}</span>` }, { h: 'Requested', cls: 'r', f: (x) => inr(x.amount) }, { h: 'Pay exactly', cls: 'r', f: (x) => inr(x.payable) }, { h: 'Status', f: (x) => badge(x.status, true) }, { h: 'Expires', f: (x) => esc(x.expires_at ? date(x.expires_at) : '–') },
        { h: 'Pay', f: (x) => (x.payment_url && /^https:\/\//.test(x.payment_url) ? `<a href="${esc(x.payment_url)}" target="_blank" rel="noopener noreferrer">Open payment</a>` : '–') }, { h: '', f: (x) => (x.status === 'pending' ? `<button class="btn small" data-act="vref" data-id="${esc(x.id)}">Verify</button>` : '') }], r, { empty: 'No refills yet.' })}`);
    bind('rf', async (b) => { await api('/api/admin/refills', { method: 'POST', body: b }); toast('Refill created', 'ok'); refills(m, ctx); });
    act(ctx.view, 'vref', async (el) => { const x = await api(`/api/admin/refills/${el.dataset.id}/verify`, { method: 'POST', body: {} }); toast(`Refill is ${x.status}`, 'ok'); refills(m, ctx); });
  }

  async function settings(m, ctx) {
    const s = await api('/api/admin/settings'); const save = (body) => api('/api/admin/settings', { method: 'PUT', body }).then(() => toast('Saved', 'ok'));
    const card = (id, title, inner, extra) => `<form class="card" id="${id}" novalidate><h3>${title}</h3>${inner}<div class="row"><button class="btn primary" type="submit">Save</button>${extra || ''}</div></form>`;
    ctx.set(`<h1>Settings</h1>${msgBox}<div class="grid2">
      ${card('s-general', 'General', field('appUrl', 'Public address of this panel', s.appUrl, { hint: `${s.appUrlSaved ? 'Saved.' : 'Detected automatically.'} The parent sends you back here after you authorize. If you change it, reconnect the parent.` }))}
      ${card('s-brand', 'Branding', field('panelName', 'Panel name', s.panelName) + field('logoUrl', 'Logo URL (https)', s.logoUrl) + field('faviconUrl', 'Favicon URL (https)', s.faviconUrl) + field('accent', 'Accent color (#RRGGBB)', s.accent, { ph: '#f4a63c' }))}
      ${card('s-price', 'Pricing', field('globalMarkup', 'Global markup (%)', s.globalMarkup, { hint: 'Customer price = parent price + this markup, rounded up to the paisa. Override per service on the Services page.' }))}
      ${card('s-pay', 'Payments (FamPay)', field('fampayUpiId', 'Your FamPay UPI ID', s.fampayUpiId) + field('gmailAddress', 'Gmail that receives FamPay emails', s.gmailAddress, { type: 'email' }) + field('gmailAppPassword', `Gmail app password${s.gmailPasswordSet ? ' (saved, leave blank to keep)' : ''}`, '', { type: 'password' }) + field('allowedSenders', 'FamPay sender address(es), comma separated', s.allowedSenders)
        + `<label class="check-row mb"><input type="checkbox" name="requireDkim" ${s.requireDkim ? 'checked' : ''}> Require the email to pass DKIM/SPF (recommended)</label>` + field('minDeposit', 'Minimum deposit (₹)', s.minDeposit) + field('maxDeposit', 'Maximum deposit (₹)', s.maxDeposit) + field('expiryMinutes', 'Deposit expiry (minutes)', s.expiryMinutes), '<button class="btn" type="button" id="gtest">Test Gmail</button>')}
      ${card('s-discord', 'Discord deposit logs', field('discordToken', `Bot token${s.discordTokenSet ? ' (saved, leave blank to keep)' : ''}`, '', { type: 'password' }) + field('discordChannelId', 'Channel ID', s.discordChannelId))}
      ${card('s-support', 'Customer support', field('url', 'Support URL (https only)', s.support.url, { hint: 'Discord invite, Telegram group, WhatsApp link or a website.' }) + field('displayName', 'Display name', s.support.display_name) + `<label class="check-row mb"><input type="checkbox" name="enabled" ${s.support.enabled ? 'checked' : ''}> Show support to customers</label>`)}</div><div id="gres"></div>`);
    bind('s-general', (b) => save({ appUrl: b.appUrl })); bind('s-brand', (b) => save({ panelName: b.panelName, logoUrl: b.logoUrl, faviconUrl: b.faviconUrl, accent: b.accent })); bind('s-price', (b) => save({ globalMarkup: b.globalMarkup }));
    bind('s-pay', (b) => save({ fampayUpiId: b.fampayUpiId, gmailAddress: b.gmailAddress, gmailAppPassword: b.gmailAppPassword, allowedSenders: b.allowedSenders, requireDkim: b.requireDkim, minDeposit: b.minDeposit, maxDeposit: b.maxDeposit, expiryMinutes: b.expiryMinutes }));
    bind('s-discord', (b) => save({ discordToken: b.discordToken, discordChannelId: b.discordChannelId })); bind('s-support', (b) => save({ support: { url: b.url, displayName: b.displayName, enabled: b.enabled } }));
    document.getElementById('gtest').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true; const box = document.getElementById('gres');
      try { const r = await api('/api/admin/settings/gmail-test', { method: 'POST', body: {} });
        box.innerHTML = r.ok ? `<h2>Gmail test</h2>${note(`Connected. ${r.notifications.length} recent email(s) found.`, 'info')}${table([{ h: 'Sender', f: (n) => esc(n.sender) }, { h: 'Amount read', cls: 'r', f: (n) => (n.amount === null ? 'none' : inr(n.amount)) }, { h: 'Passes DKIM/SPF', f: (n) => (n.authPass ? 'Yes' : 'No') }, { h: 'Has message ID', f: (n) => (n.hasId ? 'Yes' : 'No') }], r.notifications, { empty: 'No emails from the configured sender yet.' })}` : note(esc(r.error), 'err'); }
      catch (ex) { box.innerHTML = note(esc(ex.message), 'err'); } e.currentTarget.disabled = false;
    });
  }
  const logs = async (m, ctx) => ctx.set(`<h1>Activity logs</h1>${table([{ h: 'When', f: (l) => esc(date(l.created_at)) }, { h: 'Who', f: (l) => esc(l.username || 'system') }, { h: 'Action', f: (l) => esc(l.action) }, { h: 'Detail', cls: 'wide', f: (l) => esc(l.detail || '') }], (await api('/api/admin/logs')).logs, { empty: 'No activity yet.' })}`);
  async function backup(m, ctx) {
    ctx.set(`<h1>Backup and restore</h1>${note('Database storage is temporary. Render Free may erase local files during restart, spin-down, or redeployment. Download regular backups to avoid losing data.', 'warn')}
      <div class="grid2"><div class="card"><h3>Download</h3><p class="muted">A complete, consistent copy of your database.</p><a class="btn primary" href="/api/admin/backup" download>Download backup</a></div>
      <div class="card"><h3>Restore</h3>${msgBox}<p class="muted">Replaces all current data. A safety copy is kept on the server when possible. After a server reset, the Gmail app password, Discord token and parent connection are cleared and must be entered again.</p><div class="field"><input id="rfile" type="file" accept=".sqlite,.db" aria-label="Backup file"></div><button class="btn danger" id="rgo" type="button">Restore backup</button></div></div>`);
    document.getElementById('rgo').addEventListener('click', async (e) => {
      const f = document.getElementById('rfile').files[0]; if (!f) return showErr(new Error('Choose a backup file first')); if (!confirm('Replace ALL current data with this backup?')) return;
      e.currentTarget.disabled = true; try { const r = await api('/api/admin/restore', { method: 'POST', body: await f.arrayBuffer(), raw: true }); alert(r.secretsCleared && r.secretsCleared.length ? `Restored. Re-enter: ${r.secretsCleared.join(', ')}.` : 'Restored.'); location.href = '/login'; } catch (ex) { showErr(ex); e.currentTarget.disabled = false; }
    });
  }
  async function profile(m, ctx) {
    ctx.set(`<h1>Profile</h1><div class="grid2"><div class="card"><h3>Account</h3>${kv([['Username', esc(me.username)], ['Email', esc(me.email)], ['Role', 'Super admin']])}</div>
      <form class="card" id="pf" novalidate><h3>Change password</h3>${msgBox}${field('current', 'Current password', '', { type: 'password', auto: 'current-password', req: true })}${field('password', 'New password', '', { type: 'password', auto: 'new-password', req: true })}${field('confirm', 'Confirm new password', '', { type: 'password', auto: 'new-password', req: true })}<button class="btn primary" type="submit">Change password</button></form></div>`);
    bind('pf', async (b) => { await api('/api/me/password', { method: 'POST', body: b }); toast('Password changed. Please log in again.', 'ok'); setTimeout(() => { location.href = '/login'; }, 900); });
  }

  MK.start([[/^#\/overview$/, overview], [/^#\/customers\/(\d+)$/, customer], [/^#\/customers$/, customers], [/^#\/services$/, services], [/^#\/orders$/, orders], [/^#\/deposits$/, deposits], [/^#\/transactions$/, transactions],
    [/^#\/parent$/, parent], [/^#\/refills$/, refills], [/^#\/settings$/, settings], [/^#\/logs$/, logs], [/^#\/backup$/, backup], [/^#\/profile$/, profile]], '#/overview', async () => { me = (await api('/api/me')).user; MK.setWho(me); });
})();
