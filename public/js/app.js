(function () {
  'use strict';
  const { esc, inr, api, badge, date, table, toast, kv, trunc } = MK;
  let me = null; let catalogue = null; const filt = { q: '', cat: '', shown: 36 }; const num = (n) => Number(n).toLocaleString('en-IN');
  const bal = async () => { const m = await api('/api/me'); MK.setBalance(m.balance); return m.balance; };
  const loadCatalogue = async () => (catalogue = catalogue || (await api('/api/services')).services);

  const ordersTable = (rows, empty) => table([
    { h: 'Order', f: (o) => `<span class="mono">${esc(o.reference)}</span>` }, { h: 'Service', cls: 'wide', f: (o) => esc(trunc(o.service, 48)) },
    { h: 'Target', f: (o) => `<span class="mono">${esc(trunc(o.link, 24))}</span>` }, { h: 'Qty', cls: 'r', f: (o) => num(o.quantity) },
    { h: 'Amount', cls: 'r', f: (o) => inr(o.charge) }, { h: 'Status', f: (o) => badge(o.status) }, { h: 'Date', f: (o) => esc(date(o.createdAt)) },
  ], rows, { empty: empty || 'No orders yet. Pick a service to place your first one.' });
  const depositsTable = (rows) => table([
    { h: 'Transaction ID', f: (d) => `<a class="mono" href="#/funds/${esc(d.transactionId)}">${esc(d.transactionId)}</a>` }, { h: 'Amount', cls: 'r', f: (d) => inr(d.requested) },
    ...(rows[0] && rows[0].payable ? [{ h: 'To pay', cls: 'r', f: (d) => inr(d.payable) }] : []), { h: 'Status', f: (d) => badge(d.status) }, { h: 'Created', f: (d) => esc(date(d.createdAt)) },
  ], rows, { href: (d) => '#/funds/' + d.transactionId, empty: 'No deposits yet.' });
  const txTable = (rows) => table([
    { h: 'Date', f: (t) => esc(date(t.createdAt)) }, { h: 'Type', f: (t) => esc(MK.LABEL[t.type] || t.type) }, { h: 'Details', cls: 'wide', f: (t) => esc(trunc(t.reason || '', 60)) },
    { h: 'Amount', cls: 'r', f: (t) => MK.money(t.amount) }, { h: 'Balance', cls: 'r', f: (t) => inr(t.balance) },
  ], rows, { empty: 'No wallet activity yet.' });
  const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;

  // Catalogue grid with search + category filter (shared by Dashboard and New order)
  function catalogueHtml(services) {
    const cats = [...new Set(services.map((s) => s.category).filter(Boolean))];
    return `<div class="filters-bar"><input id="sq" type="search" placeholder="Search services" value="${esc(filt.q)}" aria-label="Search services" autocomplete="off">
      <select id="sc" aria-label="Category"><option value="">All categories (${cats.length})</option>${cats.map((c) => `<option ${c === filt.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="svc-count" id="scount"></div><div class="svc-grid" id="sgrid"></div><div class="more" id="smore"></div>`;
  }
  function wireCatalogue(services) {
    const byId = new Map(services.map((s) => [s.id, s])); const grid = document.getElementById('sgrid');
    const draw = () => {
      const q = filt.q.trim().toLowerCase(); const rows = services.filter((s) => (!filt.cat || s.category === filt.cat) && (!q || s.name.toLowerCase().includes(q)));
      grid.innerHTML = rows.slice(0, filt.shown).map(MK.serviceCard).join('') || '<div class="card empty span-all">No services match your search.</div>';
      document.getElementById('scount').textContent = `${num(rows.length)} service${rows.length === 1 ? '' : 's'}`;
      document.getElementById('smore').innerHTML = rows.length > filt.shown ? `<button class="btn" id="more" type="button">Show more (${num(rows.length - filt.shown)} left)</button>` : '';
      const more = document.getElementById('more'); if (more) more.addEventListener('click', () => { filt.shown += 36; draw(); });
    };
    let t; document.getElementById('sq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { filt.q = e.target.value; filt.shown = 36; draw(); }, 120); });
    document.getElementById('sc').addEventListener('change', (e) => { filt.cat = e.target.value; filt.shown = 36; draw(); });
    grid.addEventListener('click', (e) => { const b = e.target.closest('.svc'); const s = b && byId.get(Number(b.dataset.id)); if (s) MK.openServiceModal(s, { user: me, onOrdered: () => { bal(); location.hash = '#/orders'; } }); });
    draw();
  }

  async function dashboard(m, ctx) {
    const [d, services] = await Promise.all([api('/api/dashboard'), loadCatalogue().catch(() => null)]); MK.setBalance(d.balance);
    ctx.set(`<h1>Dashboard</h1><section class="wallet"><div><div class="label">Wallet balance</div><div class="amount"><span class="cur">₹</span>${esc(inr(d.balance).replace('₹', ''))}</div></div><a class="btn primary" href="#/funds">Add funds</a></section>
      <div class="stats">${stat(inr(d.totalDeposits), 'Total deposits')}${stat(num(d.totalOrders), 'Total orders')}${stat(num(d.completed), 'Completed orders')}${stat(num(d.pending), 'Pending orders')}</div>
      <div class="sec-h"><h2>Services</h2></div>${services ? catalogueHtml(services) : '<div class="notice err">Services could not be loaded.</div>'}
      <h2>Recent orders</h2>${ordersTable(d.recentOrders)}<h2>Recent transactions</h2>${txTable(d.recentTransactions)}<h2>Recent deposits</h2>${depositsTable(d.recentDeposits)}`);
    if (services) wireCatalogue(services);
  }
  async function newOrder(m, ctx) {
    const services = await loadCatalogue();
    ctx.set(`<h1>New order</h1>${services.length ? catalogueHtml(services) : '<div class="card empty">No services are available right now. Please check back soon.</div>'}`);
    if (services.length) wireCatalogue(services);
  }
  const orders = async (m, ctx) => ctx.set(`<h1>Order history</h1>${ordersTable((await api('/api/orders')).orders)}`);
  const deposits = async (m, ctx) => ctx.set(`<h1>Deposit history</h1>${depositsTable((await api('/api/deposits')).deposits)}`);
  const transactions = async (m, ctx) => ctx.set(`<h1>Transactions</h1>${txTable((await api('/api/transactions')).transactions)}`);

  async function funds(m, ctx) {
    await bal();
    ctx.set(`<h1>Add funds</h1><div class="grid2"><form class="card" id="df" novalidate><div id="derr" class="notice err" role="alert" hidden></div>
      <div class="field"><label for="amount">Amount (₹)</label><input id="amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="100" required>
      <div class="chips">${[100, 200, 500, 1000, 2000].map((a) => `<button class="chip" type="button" data-amt="${a}">₹${a}</button>`).join('')}</div></div>
      <button class="btn primary block" type="submit">Continue to payment</button></form>
      <div class="card"><h3>How it works</h3><p class="muted">You pay by UPI to the exact amount we show, including the paise. Your wallet is credited automatically after the payment is verified. You can leave this page and reopen the payment from Deposit history.</p></div></div>`);
    document.querySelectorAll('[data-amt]').forEach((b) => b.addEventListener('click', () => { document.getElementById('amount').value = b.dataset.amt; }));
    document.getElementById('df').addEventListener('submit', async (e) => {
      e.preventDefault(); const er = document.getElementById('derr'); er.hidden = true; const b = e.target.querySelector('button[type=submit]'); b.disabled = true;
      try { const d = await api('/api/deposits', { method: 'POST', body: { amount: document.getElementById('amount').value.trim() } }); location.hash = '#/funds/' + d.transactionId; }
      catch (ex) { er.textContent = ex.message; er.hidden = false; b.disabled = false; }
    });
  }
  async function deposit(m, ctx) {
    const id = m[1]; let d = await api('/api/deposits/' + encodeURIComponent(id));
    const draw = () => {
      const pending = d.status === 'pending';
      ctx.set(`<a class="pub-back" href="#/deposits">← Deposit history</a><h1>Payment ${badge(d.status)}</h1>
        ${pending ? '<div class="notice warn">Pay exactly the amount shown, including the paise. A different amount cannot be matched to your deposit.</div>' : ''}
        ${d.status === 'paid' ? '<div class="notice">Payment verified. Your wallet has been credited.</div>' : ''}${d.status === 'review' ? '<div class="notice warn">This payment needs a manual check by support. Please contact support with your transaction ID.</div>' : ''}
        <div class="card"><div class="pay-grid"><div>${d.qr ? `<div class="qr"><img src="${esc(d.qr)}" alt="UPI QR code"></div>` : '<div class="notice">QR code unavailable. Use the UPI ID instead.</div>'}</div>
        <div><div class="muted">Amount to pay</div><div class="pay-amount">${inr(d.payable)}</div><br>${kv([['Requested', inr(d.requested)], ['UPI ID', `<span class="mono">${esc(d.upiId)}</span>`], ['Transaction ID', `<span class="mono">${esc(d.transactionId)}</span>`], ['Created', esc(date(d.createdAt))], ['Expires', esc(date(d.expiresAt))]])}
        ${pending ? `<div class="row mb"><a class="btn" href="${esc(d.upiUri)}">Open UPI app</a><button class="btn primary" id="chk" type="button">Check payment</button></div><div class="hint" id="cmsg"></div>` : ''}</div></div></div>`);
      const c = document.getElementById('chk'); if (c) c.addEventListener('click', check);
    };
    async function check() {
      const c = document.getElementById('chk'); c.disabled = true; const msg = document.getElementById('cmsg');
      try {
        const r = await api(`/api/deposits/${encodeURIComponent(id)}/check`, { method: 'POST', body: {} });
        if (r.status !== 'pending') { d = await api('/api/deposits/' + encodeURIComponent(id)); bal(); draw(); return; }
        msg.textContent = r.wait ? `Not found yet. You can check again in ${r.wait} seconds.` : 'Payment not found yet. It can take a minute or two after you pay.';
      } catch (ex) { msg.textContent = ex.message; }
      c.disabled = false;
    }
    draw();
    if (d.status === 'pending') MK.timer(async () => { try { const x = await api('/api/deposits/' + encodeURIComponent(id)); if (x.status !== d.status) { d = x; bal(); draw(); } } catch (_) { /* ignore */ } }, 20000);
  }
  async function support(m, ctx) {
    const s = await api('/api/support');
    ctx.set(`<h1>Support</h1><div class="card">${s.enabled ? `<p>Need help with an order or a payment? Our team is here for you.</p><p><a class="btn primary" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Contact ${esc(s.name || 'support')}</a></p>` : '<div class="empty">Support is not set up yet. Please check back soon.</div>'}</div>`);
  }
  async function profile(m, ctx) {
    ctx.set(`<h1>Profile</h1><div class="grid2"><div class="card"><h3>Account</h3>${kv([['Username', esc(me.username)], ['Email', esc(me.email)]])}</div>
      <form class="card" id="pf" novalidate><h3>Change password</h3><div id="perr" class="notice err" role="alert" hidden></div>${MK.field('current', 'Current password', '', { type: 'password', auto: 'current-password', req: true })}${MK.field('password', 'New password', '', { type: 'password', auto: 'new-password', req: true })}${MK.field('confirm', 'Confirm new password', '', { type: 'password', auto: 'new-password', req: true })}
      <button class="btn primary" type="submit">Change password</button></form></div>`);
    document.getElementById('pf').addEventListener('submit', async (e) => {
      e.preventDefault(); const er = document.getElementById('perr'); er.hidden = true;
      try { await api('/api/me/password', { method: 'POST', body: MK.formData(e.target) }); toast('Password changed. Please log in again.', 'ok'); setTimeout(() => { location.href = '/login'; }, 900); } catch (ex) { er.textContent = ex.message; er.hidden = false; }
    });
  }

  MK.start([[/^#\/dashboard$/, dashboard], [/^#\/new$/, newOrder], [/^#\/funds\/([A-Za-z0-9]+)$/, deposit], [/^#\/funds$/, funds], [/^#\/orders$/, orders], [/^#\/deposits$/, deposits],
    [/^#\/transactions$/, transactions], [/^#\/support$/, support], [/^#\/profile$/, profile]], '#/dashboard', async (u) => { me = (await api('/api/me')).user; MK.setWho(me); bal(); });
})();
