(function () {
  'use strict';
  const form = document.getElementById('form'); const errBox = document.getElementById('error');
  const isRegister = !!document.getElementById('confirmPassword'); const btn = form.querySelector('button[type=submit]');
  // Same-site paths only, so a crafted link can never send people to another website after login.
  const raw = new URLSearchParams(location.search).get('next');
  const next = raw && /^\/(?!\/)[A-Za-z0-9\-._~/%?=&#]*$/.test(raw) && !raw.startsWith('/api') ? raw : null;
  if (next) document.querySelectorAll('a[href="/register"], a[href="/login"]').forEach((a) => { a.href = a.getAttribute('href') + '?next=' + encodeURIComponent(next); });
  const show = (m) => { errBox.textContent = m; errBox.hidden = false; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); errBox.hidden = true;
    const d = Object.fromEntries(new FormData(form).entries());
    if (isRegister && d.password !== d.confirmPassword) { show('Passwords do not match.'); return; }
    if (isRegister) d.confirm = d.confirmPassword;
    btn.disabled = true;
    try {
      const r = await MK.api(isRegister ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: d });
      MK.setToken(r.csrf);
      location.href = next && r.user.role !== 'super_admin' ? next : r.redirect;
    } catch (err) { show(err.message); btn.disabled = false; }
  });
})();
