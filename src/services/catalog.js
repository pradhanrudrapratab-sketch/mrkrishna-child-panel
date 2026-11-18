'use strict';
const settings = require('./settings');
const { retailRatePaise, toPaiseCeil, fromPaise } = require('../utils/money');
const { fmt } = require('../utils/time');
const { pick } = require('../integrations/parentClient');

const PLATFORMS = ['instagram', 'telegram', 'facebook', 'whatsapp', 'youtube', 'twitter', 'tiktok'];
const platformOf = (s) => PLATFORMS.find((p) => String(s).toLowerCase().includes(p)) || 'other';

// Tolerant of several list shapes because the parent response format is not yet verified.
function normalizeServices(payload) {
  const list = Array.isArray(payload) ? payload : pick(payload, 'services', 'data.services', 'items') || [];
  if (!Array.isArray(list)) throw new Error('Unrecognized services response');
  const out = []; out.skipped = 0;
  for (const s of list) {
    const type = String(pick(s, 'type') || 'default').toLowerCase();
    if (type !== 'default') { out.skipped++; continue; } // only the Default type is supported
    const id = pick(s, 'id', 'service', 'service_id'); const name = pick(s, 'name', 'title');
    const rate = pick(s, 'rate', 'price', 'price_per_1000', 'wholesale_rate');
    if (id === undefined || !name || rate === undefined) continue;
    let paise; try { paise = toPaiseCeil(rate); } catch { continue; }
    const category = String(pick(s, 'category', 'category_name') || 'General').slice(0, 80);
    out.push({ parentId: String(id), name: String(name).slice(0, 200), category, platform: pick(s, 'platform') ? String(pick(s, 'platform')).toLowerCase().slice(0, 30) : platformOf(`${category} ${name}`),
      type, min: parseInt(pick(s, 'min', 'min_quantity') ?? 1, 10) || 1,
      max: parseInt(pick(s, 'max', 'max_quantity') ?? 1000000, 10) || 1000000, paise, currency: String(pick(s, 'currency') || 'INR'),
      description: pick(s, 'description', 'desc') ? String(pick(s, 'description', 'desc')).slice(0, 2000) : null });
  }
  return out;
}

function syncServices(db, payload, now = new Date()) {
  const list = normalizeServices(payload);
  if (!list.length) throw new Error('Parent returned no usable services; catalog left unchanged');
  return db.transaction(() => {
    const seen = new Set();
    for (const s of list) {
      db.prepare('INSERT OR IGNORE INTO service_categories(platform,name) VALUES(?,?)').run(s.platform, s.category);
      const cat = db.prepare('SELECT id FROM service_categories WHERE platform=? AND name=?').get(s.platform, s.category);
      db.prepare(`INSERT INTO services(parent_service_id,category_id,name,type,min_qty,max_qty,wholesale_paise_per_1000,currency,description,available,synced_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(parent_service_id) DO UPDATE SET category_id=excluded.category_id,name=excluded.name,type=excluded.type,
        min_qty=excluded.min_qty,max_qty=excluded.max_qty,wholesale_paise_per_1000=excluded.wholesale_paise_per_1000,currency=excluded.currency,
        description=COALESCE(services.description,excluded.description),available=1,synced_at=excluded.synced_at`)
        .run(s.parentId, cat.id, s.name, s.type, s.min, s.max, s.paise, s.currency, s.description, fmt(now));
      seen.add(s.parentId);
    }
    let gone = 0;
    for (const r of db.prepare('SELECT parent_service_id p FROM services WHERE available=1').all()) {
      if (!seen.has(r.p)) { db.prepare('UPDATE services SET available=0 WHERE parent_service_id=?').run(r.p); gone++; }
    }
    settings.set(db, 'last_service_sync', fmt(now));
    return { synced: list.length, markedUnavailable: gone, skippedUnsupportedType: list.skipped };
  })();
}

const globalMarkupBp = (db) => settings.getInt(db, 'global_markup_bp', 3000);
function effectiveRate(svc, globalBp) {
  if (svc.custom_rate_paise) return svc.custom_rate_paise;
  return retailRatePaise(svc.wholesale_paise_per_1000, svc.markup_bp ?? globalBp);
}

// Customer-facing: NO wholesale rates and NO parent service IDs.
function publicServices(db) {
  const g = globalMarkupBp(db);
  return db.prepare(`SELECT s.*,c.name category,c.platform FROM services s LEFT JOIN service_categories c ON c.id=s.category_id WHERE s.enabled=1 AND s.available=1 ORDER BY c.platform,c.name,s.name`).all()
    .map((s) => ({ id: s.id, name: s.name, category: s.category, platform: s.platform, min: s.min_qty, max: s.max_qty,
      rate: fromPaise(effectiveRate(s, g)), description: s.description }));
}
module.exports = { normalizeServices, syncServices, effectiveRate, publicServices, globalMarkupBp };
