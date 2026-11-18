(function () {
  'use strict';
  const { esc, inr } = MK;
  const num = (n) => Number(n).toLocaleString('en-IN');
  MK.serviceCard = (s) => `<button class="svc" type="button" data-id="${esc(s.id)}">
    <span class="svc-cat">${esc(s.category || 'General')}</span>
    <span class="svc-name">${esc(s.name)}</span>
    <span class="svc-meta"><span class="svc-rate"><b>${inr(s.rate)}</b><span>per 1000</span></span><span class="svc-lim">Min ${num(s.min)}<br>Max ${num(s.max)}</span></span>
    <span class="svc-go"><span>Order now</span>${(MK.ICONS && MK.ICONS.arrow) || ''}</span></button>`;

  // opts: { user, nextUrl, onOrdered }
  MK.openServiceModal = (s, opts) => {
    const o = opts || {}; const back = document.createElement('div'); back.className = 'modal-back';
    const orderable = !!o.user;
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(s.name)}"><button class="modal-x" type="button" aria-label="Close">×</button>
      <span class="svc-cat">${esc(s.category || 'General')}</span><h2>${esc(s.name)}</h2>
      <div class="pills"><span class="pill">Rate <b>${inr(s.rate)}</b> / 1000</span><span class="pill">Min <b>${num(s.min)}</b></span><span class="pill">Max <b>${num(s.max)}</b></span></div>
      ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}
      ${orderable ? `<form id="mform" novalidate><div id="merr" class="notice err" role="alert" hidden></div>
        <div class="field"><label for="mlink">Link</label><input id="mlink" name="link" type="url" placeholder="https://" autocomplete="off" required></div>
        <div class="field"><label for="mqty">Quantity</label><input id="mqty" name="quantity" inputmode="numeric" autocomplete="off" required><div class="hint">Between ${num(s.min)} and ${num(s.max)}</div></div>
        <div class="total-row"><span class="muted">Total charge</span><strong class="num" id="mtotal">₹0.00</strong></div>
        <button class="btn primary block" id="mgo" type="submit">Place order</button></form>`
        : `<div class="notice">Log in to place an order. Browsing is free.</div><div class="row"><a class="btn primary grow" href="/login?next=${encodeURIComponent(o.nextUrl || '/app')}">Log in</a><a class="btn grow" href="/register?next=${encodeURIComponent(o.nextUrl || '/app')}">Create account</a></div>`}
    </div>`;
    document.body.appendChild(back); document.body.classList.add('modal-open');
    const close = () => { back.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', esc_); };
    const esc_ = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc_);
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.modal-x')) close(); });
    if (!orderable) return;
    const qty = back.querySelector('#mqty'); const total = back.querySelector('#mtotal'); const err = back.querySelector('#merr');
    qty.addEventListener('input', () => { const n = /^\d{1,9}$/.test(qty.value.trim()) ? Number(qty.value) : 0; total.textContent = n ? inr(MK.charge(s.rate, n).toFixed(2)) : '₹0.00'; });
    back.querySelector('#mform').addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true; const btn = back.querySelector('#mgo'); btn.disabled = true;
      try {
        const r = await MK.api('/api/orders', { method: 'POST', body: { serviceId: s.id, link: back.querySelector('#mlink').value.trim(), quantity: qty.value.trim() } });
        close(); MK.toast(`Order placed. ${inr(r.charge)} charged.`, 'ok'); if (o.onOrdered) o.onOrdered(r);
      } catch (ex) { err.innerHTML = esc(ex.message) + (ex.status === 402 ? ' <a href="#/funds">Add funds</a>' : ''); err.hidden = false; btn.disabled = false; }
    });
    back.querySelector('#mlink').focus();
  };
})();
