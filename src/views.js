'use strict';
const fs = require('fs');
const path = require('path');
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cache = {};
const load = (name) => cache[name] || (cache[name] = fs.readFileSync(path.join(__dirname, '..', 'views', `${name}.html`), 'utf8'));

// "MrKrishna Child Panel" -> "MK" (first letter + next capital in the first word), otherwise first letters of two words.
function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean); const w0 = words[0] || 'M';
  const cap = /^.(?:[^A-Z]*)([A-Z])/.exec(w0);
  if (cap) return (w0[0] + cap[1]).toUpperCase();
  return ((w0[0] || 'M') + ((words[1] || w0 + 'K')[0] || 'K')).toUpperCase();
}
function mark(ctx) { return ctx.logoUrl ? `<span class="mark has-img"><img src="${esc(ctx.logoUrl)}" alt=""></span>` : `<span class="mark">${esc(initials(ctx.name))}</span>`; }
function render(name, ctx) {
  return load(name).replace(/{{NAME}}/g, esc(ctx.name)).replace(/{{MARK}}/g, mark(ctx)).replace(/{{FAVICON}}/g, esc(ctx.faviconUrl || '/favicon.svg')).replace(/{{YEAR}}/g, String(new Date().getFullYear()));
}
function darken(hex) { const n = parseInt(hex.slice(1), 16); const f = (v) => Math.max(0, Math.round(v * 0.82)); return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('')}`; }
const themeCss = (accent) => (/^#[0-9a-fA-F]{6}$/.test(accent || '') ? `:root{--accent:${accent};--accent-deep:${darken(accent)}}` : '');
const faviconSvg = (name) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8b95c"/><stop offset="1" stop-color="#e5832a"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="32" y="42" text-anchor="middle" font-family="system-ui,Arial,sans-serif" font-weight="800" font-size="28" fill="#1b1206">${esc(initials(name))}</text></svg>`;
module.exports = { render, initials, themeCss, faviconSvg, esc };
