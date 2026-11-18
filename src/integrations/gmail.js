'use strict';
const settings = require('../services/settings');
const { toPaise } = require('../utils/money');

const CUR = String.raw`(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)`;
function amountToPaise(raw) { try { return toPaise(raw.replace(/,/g, '')); } catch { return null; } }

// Pure parser. FamPay email wording is NOT verified: the admin "Test Gmail" screen shows what this extracts from real emails.
function parseNotification({ fromAddress, subject = '', text = '', headers = {}, messageId, date }) {
  const body = `${subject}\n${text}`;
  let amountPaise = null;
  const kw = new RegExp(String.raw`(?:received|credited|paid you|sent you)[^0-9₹]{0,40}${CUR}`, 'i').exec(body);
  if (kw) amountPaise = amountToPaise(kw[1]);
  else {
    const all = [...body.matchAll(new RegExp(CUR, 'gi'))].map((m) => amountToPaise(m[1])).filter((x) => x !== null);
    const uniq = [...new Set(all)];
    if (uniq.length === 1) amountPaise = uniq[0];
  }
  const ref = /MKP\d{8}[A-Z0-9]{4}/.exec(body);
  const auth = String(headers['authentication-results'] || '').toLowerCase();
  return {
    uid: messageId || null,
    sender: String(fromAddress || '').toLowerCase(),
    amountPaise,
    receivedAt: date ? new Date(date) : null,
    reference: ref ? ref[0] : null,
    authPass: /dkim=pass/.test(auth) || /spf=pass/.test(auth),
  };
}

function allowedSenders(db) {
  return String(settings.get(db, 'fampay_allowed_senders', '')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function fetchRecent(db, { limit = 10 } = {}) {
  const user = settings.get(db, 'gmail_address');
  const pass = settings.getSecret(db, 'gmail_app_password_enc');
  const senders = allowedSenders(db);
  if (!user || !pass) throw new Error('Gmail is not configured');
  if (!senders.length) throw new Error('No FamPay sender address configured');
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  const out = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const s of senders) {
        const uids = (await client.search({ from: s }, { uid: true })) || [];
        const last = uids.slice(-limit);
        if (!last.length) continue;
        for await (const msg of client.fetch(last, { source: true, uid: true }, { uid: true })) {
          const p = await simpleParser(msg.source);
          const from = (p.from && p.from.value && p.from.value[0] && p.from.value[0].address) || '';
          const headers = {}; if (p.headers) for (const [k, v] of p.headers) headers[k] = typeof v === 'string' ? v : JSON.stringify(v);
          out.push(parseNotification({ fromAddress: from, subject: p.subject, text: p.text || '', headers, messageId: p.messageId, date: p.date }));
        }
      }
    } finally { lock.release(); }
  } finally { try { await client.logout(); } catch { /* ignore */ } }
  return out;
}
module.exports = { parseNotification, fetchRecent, allowedSenders };
