'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openRaw } = require('../database');
const { scrubSecrets } = require('./secrets');

const MAX_BYTES = 100 * 1024 * 1024;
const REQUIRED = ['users', 'customer_wallets', 'customer_transactions', 'deposits', 'orders', 'services', 'admin_settings', 'parent_connection'];
const q = (p) => p.replace(/'/g, "''");

// VACUUM INTO produces a consistent snapshot that already accounts for WAL contents.
function backupToFile(db, file) { db.exec(`VACUUM INTO '${q(file)}'`); }
function backupBuffer(db) {
  const f = path.join(os.tmpdir(), `mk-backup-${process.pid}-${Date.now()}.sqlite`);
  try { backupToFile(db, f); return fs.readFileSync(f); } finally { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

function validateBackupFile(file) {
  const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(16);
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== 'SQLite format 3\0') return 'Not a SQLite database';
  let db;
  try {
    db = openRaw(file);
    const chk = db.prepare('PRAGMA integrity_check').all();
    if (!chk.length || Object.values(chk[0])[0] !== 'ok') return 'Database failed the integrity check';
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const missing = REQUIRED.filter((t) => !have.has(t));
    if (missing.length) return `Missing tables: ${missing.join(', ')}`;
    if (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type IN('trigger','view')").get().c > 0) return 'Backup contains triggers or views, which are not allowed';
    return null;
  } catch (e) { return 'Unreadable database file'; } finally { try { db && db.close(); } catch { /* ignore */ } }
}

function restoreFromBuffer(holder, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4096 || buf.length > MAX_BYTES) throw new Error('Invalid backup size');
  const dir = path.dirname(holder.file);
  const tmp = path.join(dir, `restore-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  const bad = validateBackupFile(tmp);
  if (bad) { fs.unlinkSync(tmp); throw new Error(bad); }
  const safety = `${holder.file}.pre-restore-${Date.now()}`;
  holder.close();
  let hadOld = false;
  try { if (fs.existsSync(holder.file)) { fs.copyFileSync(holder.file, safety); hadOld = true; } } catch { /* best effort */ }
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(holder.file + s); } catch { /* none */ } }
  fs.renameSync(tmp, holder.file);
  try {
    const db = holder.reopen(); // runs migrations
    db.prepare('SELECT 1 FROM users LIMIT 1').all();
    return { restored: true, safetyCopy: hadOld ? safety : null, secretsCleared: scrubSecrets(db) };
  } catch (e) {
    if (hadOld) { try { holder.close(); fs.copyFileSync(safety, holder.file); holder.reopen(); } catch { /* give up */ } }
    throw new Error('Restore failed health check and was rolled back');
  }
}
module.exports = { backupBuffer, backupToFile, validateBackupFile, restoreFromBuffer };
