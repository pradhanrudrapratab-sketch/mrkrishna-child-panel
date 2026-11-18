(function () {
  'use strict';
  // Tiny, optional enhancement: the page is fully usable without it.
  fetch('/api/public/config', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((c) => {
    if (!c) return;
    const support = document.getElementById('support');
    if (c.supportUrl && support) { support.href = c.supportUrl; support.hidden = false; }
    if (c.loggedIn) {
      const dash = c.user && c.user.role === 'super_admin' ? '/admin' : '/app';
      const a = document.getElementById('cta-login'); if (a) { a.textContent = 'Dashboard'; a.href = dash; }
      const h = document.getElementById('hero-login'); if (h) { h.textContent = 'Open dashboard'; h.href = dash; }
    }
    const counts = c.counts || {};
    Object.keys(counts).forEach((k) => { const el = document.querySelector('[data-count="' + k + '"]'); if (el && counts[k]) el.textContent = Number(counts[k]).toLocaleString('en-IN') + ' services'; });
  }).catch(() => {});
})();
