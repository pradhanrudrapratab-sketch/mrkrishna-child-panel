(function () {
  'use strict';
  const { esc, api } = MK;
  const platform = location.pathname.split('/').filter(Boolean).pop(); const P = MK.PLATFORMS[platform]; const root = document.getElementById('view');
  if (!P) { location.replace('/'); return; }
  document.title = `${P.name} services · ${document.title.split(' · ').pop()}`;
  const filt = { q: '', cat: '', shown: 36 }; const num = (n) => Number(n).toLocaleString('en-IN');
  const switcher = `<nav class="pub-switch" aria-label="Platforms">${Object.keys(MK.PLATFORMS).map((k) => `<a class="${k === platform ? 'on' : ''} ${MK.PLATFORMS[k].cls}" href="/services/${k}">${MK.ICONS[k]}<span>${esc(MK.PLATFORMS[k].name)}</span></a>`).join('')}</nav>`;
  const shell = (inner) => { root.innerHTML = `<a class="pub-back" href="/">← All platforms</a><div class="pub-title ${P.cls}"><span class="plogo">${MK.ICONS[platform]}</span><div><h1>${esc(P.name)} services</h1><p>${esc(P.tag)}</p></div></div>${switcher}${inner}`; };
  async function init() {
    shell('<p class="muted">Loading services…</p>'); let cfg = null; let data;
    try { [cfg, data] = await Promise.all([api('/api/public/config').catch(() => null), api('/api/public/services?platform=' + platform)]); }
    catch (e) { shell(`<div class="notice err" role="alert">${esc(e.message)}</div>`); return; }
    MK.wireHeader(cfg); const sup = document.getElementById('support'); if (sup && cfg && cfg.supportUrl) sup.hidden = false;
    const user = cfg && cfg.loggedIn ? cfg.user : null; const services = data.services; const byId = new Map(services.map((s) => [s.id, s]));
    if (!services.length) { shell(`<div class="card empty">No ${esc(P.name)} services are listed right now. Please check back soon.</div>`); return; }
    shell(`<div class="filters-bar"><input id="sq" type="search" placeholder="Search ${esc(P.name)} services" aria-label="Search services" autocomplete="off">
      <select id="sc" aria-label="Category"><option value="">All categories (${data.categories.length})</option>${data.categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
      <div class="svc-count" id="scount"></div><div class="svc-grid" id="sgrid"></div><div class="more" id="smore"></div>`);
    const grid = document.getElementById('sgrid');
    const draw = () => {
      const q = filt.q.trim().toLowerCase(); const rows = services.filter((s) => (!filt.cat || s.category === filt.cat) && (!q || s.name.toLowerCase().includes(q)));
      grid.innerHTML = rows.slice(0, filt.shown).map(MK.serviceCard).join('') || '<div class="card empty span-all">No services match your search.</div>';
      document.getElementById('scount').textContent = `${num(rows.length)} service${rows.length === 1 ? '' : 's'}`;
      document.getElementById('smore').innerHTML = rows.length > filt.shown ? `<button class="btn" id="more" type="button">Show more (${num(rows.length - filt.shown)} left)</button>` : '';
      const more = document.getElementById('more'); if (more) more.addEventListener('click', () => { filt.shown += 36; draw(); });
    };
    const open = (s) => MK.openServiceModal(s, { user, nextUrl: `/services/${platform}#svc=${s.id}`, onOrdered: () => { location.href = '/app#/orders'; } });
    let t; document.getElementById('sq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { filt.q = e.target.value; filt.shown = 36; draw(); }, 120); });
    document.getElementById('sc').addEventListener('change', (e) => { filt.cat = e.target.value; filt.shown = 36; draw(); });
    grid.addEventListener('click', (e) => { const b = e.target.closest('.svc'); const s = b && byId.get(Number(b.dataset.id)); if (s) open(s); });
    draw();
    const m = location.hash.match(/^#svc=(\d+)$/); if (m && byId.has(Number(m[1]))) { history.replaceState(null, '', location.pathname); open(byId.get(Number(m[1]))); }
  }
  init();
})();
