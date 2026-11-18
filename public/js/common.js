(function () {
  'use strict';
  const MK = (window.MK = {});
  MK.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const esc = MK.esc;

  // Amounts arrive from the server as rupee strings like "16.90". Display only: the server always recalculates.
  MK.inr = (v) => {
    const s = String(v == null ? '0' : v); const neg = s.startsWith('-'); const n = Number(neg ? s.slice(1) : s) || 0;
    return `${neg ? '-' : ''}₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  MK.toPaise = (s) => { const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(s)); return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0').slice(0, 2)) : 0; };
  MK.charge = (rate, qty) => Math.floor((MK.toPaise(rate) * qty + 999) / 1000) / 100; // ceil to the paisa
  MK.date = (s) => { if (!s) return '–'; const d = new Date(String(s).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')); return isNaN(d) ? esc(s) : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };

  MK.LABEL = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', partial: 'Partial', canceled: 'Canceled', failed: 'Failed', refunded: 'Refunded',
    awaiting_admin: 'Under review', paid: 'Paid', expired: 'Expired', review: 'Under review', active: 'Active', suspended: 'Suspended', connected: 'Connected',
    disconnected: 'Disconnected', reauth_required: 'Reconnect needed', gateway_unavailable: 'Gateway unavailable',
    deposit: 'Deposit', order_debit: 'Order', refund: 'Refund', admin_adjust: 'Adjustment by support' };
  MK.badge = (s, admin) => `<span class="badge s-${esc(String(s).toUpperCase())}">${esc(admin && s === 'awaiting_admin' ? 'Awaiting admin' : MK.LABEL[s] || s)}</span>`;
  MK.money = (v) => { const neg = String(v).startsWith('-'); return `<span class="num ${neg ? 'neg' : 'pos'}">${neg ? '' : '+'}${MK.inr(v)}</span>`; };

  /* ---------- API with CSRF ---------- */
  let csrf = null; let session = null;
  MK.session = async (force) => {
    if (!session || force) { const r = await fetch('/api/session', { credentials: 'same-origin' }); session = await r.json(); csrf = session.csrf; }
    return session;
  };
  MK.setToken = (t) => { csrf = t; session = null; };
  MK.api = async function api(path, opts, retry) {
    const { method = 'GET', body, raw } = opts || {};
    const headers = { Accept: 'application/json' }; let payload;
    if (method !== 'GET') {
      if (!csrf) await MK.session();
      headers['X-CSRF-Token'] = csrf;
      if (raw) { headers['Content-Type'] = 'application/octet-stream'; payload = body; } else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body || {}); }
    }
    let res;
    try { res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' }); } catch (_) { throw new Error('Network problem. Check your connection and try again.'); }
    let data = null; try { data = await res.json(); } catch (_) { /* empty body */ }
    if (res.status === 403 && retry !== false && data && /Session expired/.test(data.error || '')) { await MK.session(true); return api(path, opts, false); }
    if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/setup/')) { location.href = '/login'; throw new Error('Please log in.'); }
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  };

  MK.toast = (msg, type) => {
    const box = document.getElementById('toasts'); if (!box) return;
    const t = document.createElement('div'); t.className = 'toast ' + (type || ''); t.textContent = msg; box.appendChild(t); setTimeout(() => t.remove(), 5200);
  };
  MK.table = (cols, rows, opts) => {
    const o = opts || {};
    if (!rows.length) return `<div class="card empty">${esc(o.empty || 'Nothing here yet.')}</div>`;
    const head = cols.map((c) => `<th class="${c.cls || ''}">${esc(c.h)}</th>`).join('');
    const body = rows.map((r) => `<tr${o.href ? ` data-href="${esc(o.href(r))}"` : ''}>${cols.map((c) => `<td class="${c.cls || ''}">${c.f(r)}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  MK.kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  MK.trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  MK.field = (name, label, value, o) => { const x = o || {}; return `<div class="field"><label for="f-${esc(name)}">${esc(label)}</label><input id="f-${esc(name)}" name="${esc(name)}" type="${x.type || 'text'}" value="${esc(value)}" ${x.ph ? `placeholder="${esc(x.ph)}"` : ''} ${x.auto ? `autocomplete="${x.auto}"` : 'autocomplete="off"'} ${x.req ? 'required' : ''}>${x.hint ? `<div class="hint">${esc(x.hint)}</div>` : ''}</div>`; };
  MK.formData = (form) => { const o = {}; for (const el of form.elements) { if (!el.name) continue; o[el.name] = el.type === 'checkbox' ? el.checked : el.value; } return o; };

  let timers = [];
  MK.timer = (fn, ms) => { timers.push(setInterval(fn, ms)); };
  const clearTimers = () => { timers.forEach(clearInterval); timers = []; };

  /* ---------- shell: hash router, menu, logout ---------- */
  MK.start = function start(routes, fallback, onUser) {
    const view = document.getElementById('view'); let seq = 0;
    const menuBtn = document.getElementById('menu-btn'); const sidebar = document.getElementById('sidebar');
    const closeMenu = () => { sidebar.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); };
    menuBtn.addEventListener('click', () => { const open = sidebar.classList.toggle('open'); menuBtn.setAttribute('aria-expanded', String(open)); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    document.getElementById('logout').addEventListener('click', async () => { try { await MK.api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ } location.href = '/login'; });
    document.addEventListener('click', (e) => {
      if (e.target.closest('#nav a')) closeMenu();
      const tr = e.target.closest('tr[data-href]'); if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.dataset.href;
    });
    async function go() {
      clearTimers(); const mine = ++seq;
      const hash = location.hash || fallback; const [path, query] = hash.split('?');
      document.querySelectorAll('#nav a').forEach((a) => { const h = a.getAttribute('href'); a.classList.toggle('active', path === h || path.startsWith(h + '/')); });
      const ctx = { view, params: new URLSearchParams(query || ''), alive: () => mine === seq, set: (html) => { if (mine !== seq) return false; view.innerHTML = html; return true; } };
      for (const [re, fn] of routes) {
        const m = path.match(re); if (!m) continue;
        view.innerHTML = '<p class="muted">Loading…</p>';
        try { await fn(m, ctx); } catch (err) { ctx.set(`<div class="notice err" role="alert">${esc(err.message)}</div>`); }
        window.scrollTo(0, 0); return;
      }
      location.hash = fallback;
    }
    window.addEventListener('hashchange', go);
    MK.session().then(async (s) => { if (!s.user) { location.href = '/login'; return; } if (onUser) { try { await onUser(s.user); } catch (_) { /* shown by the page itself */ } } go(); });
  };
  MK.setWho = (user) => { const who = document.getElementById('who'); if (who) who.textContent = user.username; };
  MK.setBalance = (v) => { const top = document.getElementById('top-bal'); if (top) top.textContent = v == null ? '' : MK.inr(v); };
})();
