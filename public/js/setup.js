(function () {
  'use strict';
  const { esc, api } = MK; const root = document.getElementById('view');
  const q = new URLSearchParams(location.search); const err = q.get('error');
  const errHtml = err ? `<div class="notice err" role="alert">${esc(err)}</div>` : '';
  function welcome() {
    root.innerHTML = `<div class="card"><h1>Set up your panel</h1><p class="sub">Connect your MrKrishna parent account to activate this panel. It takes under a minute.</p>${errHtml}
      <ol class="checks"><li>Connect your parent account (you confirm on the MrKrishna site).</li><li>Come back here automatically.</li><li>Choose your admin email and password.</li></ol>
      <div id="msg" class="notice err" role="alert" hidden></div>
      <button class="btn primary block" id="go" type="button">Connect parent account</button>
      <p class="hint">Your parent password is never shared with this panel. The first account to finish setup becomes the owner, so complete it right after you deploy.</p></div>`;
    document.getElementById('go').addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true; const m = document.getElementById('msg'); m.hidden = true;
      try { const r = await api('/api/setup/start', { method: 'POST', body: {} }); location.href = r.url; } catch (ex) { m.textContent = ex.message; m.hidden = false; b.disabled = false; }
    });
  }
  function adminForm() {
    root.innerHTML = `<div class="card"><h1>Create your admin account</h1><p class="sub">Parent account connected. Choose how you will sign in to this panel.</p>${errHtml}
      <div id="msg" class="notice err" role="alert" hidden></div>
      <form id="f" novalidate>${MK.field('email', 'Email', '', { type: 'email', auto: 'email', req: true })}${MK.field('password', 'Password', '', { type: 'password', auto: 'new-password', req: true, hint: 'At least 8 characters.' })}${MK.field('confirm', 'Confirm password', '', { type: 'password', auto: 'new-password', req: true })}
      <button class="btn primary block" type="submit">Create admin and continue</button></form></div>`;
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault(); const m = document.getElementById('msg'); m.hidden = true; const b = e.target.querySelector('button'); b.disabled = true;
      try { const r = await api('/api/setup/admin', { method: 'POST', body: MK.formData(e.target) }); MK.setToken(r.csrf); location.href = r.redirect; } catch (ex) { m.textContent = ex.message; m.hidden = false; b.disabled = false; }
    });
  }
  MK.session().then((s) => { if (!s.setupNeeded) { location.replace('/login'); return; } if (s.pendingAdmin) adminForm(); else welcome(); }).catch(() => { root.innerHTML = '<div class="notice err">Could not reach the server. Refresh to try again.</div>'; });
})();
