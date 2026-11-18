'use strict';
const fs = require('fs');
const path = require('path');

class NodeSqliteShim {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    this.raw = new DatabaseSync(file);
    this.depth = 0;
  }
  exec(sql) { this.raw.exec(sql); }
  prepare(sql) {
    const st = this.raw.prepare(sql);
    const n = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
    return { run: (...a) => st.run(...n(a)), get: (...a) => st.get(...n(a)), all: (...a) => st.all(...n(a)) };
  }
  transaction(fn) {
    const make = (mode) => (...args) => {
      if (this.depth > 0) return fn(...args);
      this.exec(`BEGIN ${mode}`); this.depth = 1;
      try { const r = fn(...args); this.exec('COMMIT'); return r; }
      catch (e) { try { this.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
      finally { this.depth = 0; }
    };
    const f = make('DEFERRED'); f.immediate = make('IMMEDIATE'); return f;
  }
  close() { this.raw.close(); }
}

function openRaw(file) {
  try { const D = require('better-sqlite3'); return new D(file); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; return new NodeSqliteShim(file); }
}

function migrate(db, dir = path.join(__dirname, '..', '..', 'migrations')) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try { db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(f); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${f} failed: ${e.message}`); }
  }
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openRaw(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  migrate(db);
  return db;
}

// Holder lets restore swap the connection without restarting the process.
class DbHolder {
  constructor(file) { this.file = file; this.db = openDb(file); }
  reopen() { try { this.db.close(); } catch { /* already closed */ } this.db = openDb(this.file); return this.db; }
  close() { try { this.db.close(); } catch { /* ignore */ } }
}
module.exports = { openDb, openRaw, migrate, DbHolder };
