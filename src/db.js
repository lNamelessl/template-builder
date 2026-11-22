// src/db.js — better-sqlite3 (WAL) on the /data volume: builds + settings + vault.
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'builder.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SETUP',
  research TEXT,
  uniqueness TEXT,
  citations TEXT,
  trajectory TEXT,
  build_trajectory TEXT,
  repo_url TEXT,
  template_url TEXT,
  template_slug TEXT,
  repo_name TEXT,
  log_tail TEXT,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  turns INTEGER DEFAULT 0,
  error TEXT,
  artifacts TEXT,
  auto_build INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  research_at TEXT,
  confirmed_at TEXT,
  published_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_builds_status ON builds(status);
CREATE TABLE IF NOT EXISTS vault_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
`);

// migration guard for DBs created before the token columns existed
try {
  const cols = db.prepare('PRAGMA table_info(builds)').all().map((c) => c.name);
  if (!cols.includes('input_tokens')) db.exec('ALTER TABLE builds ADD COLUMN input_tokens INTEGER');
  if (!cols.includes('output_tokens')) db.exec('ALTER TABLE builds ADD COLUMN output_tokens INTEGER');
  if (!cols.includes('cost_usd')) db.exec('ALTER TABLE builds ADD COLUMN cost_usd REAL');
} catch (e) { /* fresh db */ }

const now = () => new Date().toISOString();

// ---------- builds ----------
// NOTE: legacy research-era columns (research/uniqueness/citations/trajectory/
// auto_build/research_at/confirmed_at) stay in the schema for backward
// compatibility with existing volumes but no code reads or writes them.
const buildStmts = {
  insert: db.prepare(`INSERT INTO builds (idea, status, created_at, updated_at)
    VALUES (?, 'SETUP', ?, ?)`),
  byId: db.prepare('SELECT * FROM builds WHERE id = ?'),
  list: db.prepare(`SELECT id, idea, status, cost_usd, turns, repo_url, template_url, error,
    created_at, updated_at, finished_at FROM builds ORDER BY id DESC`),
  setStatus: db.prepare('UPDATE builds SET status = ?, updated_at = ? WHERE id = ?'),
  saveBuildProgress: db.prepare(`UPDATE builds SET build_trajectory = ?, cost_usd = ?, turns = ?,
    log_tail = ?, updated_at = ? WHERE id = ?`),
  saveCost: db.prepare('UPDATE builds SET cost_usd = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?'),
  saveUrls: db.prepare(`UPDATE builds SET repo_url = ?, repo_name = ?, template_url = ?, template_slug = ?,
    published_at = ?, updated_at = ? WHERE id = ?`),
  saveFailure: db.prepare(`UPDATE builds SET status = 'FAILED', error = ?, finished_at = ?, updated_at = ? WHERE id = ?`),
  saveDone: db.prepare(`UPDATE builds SET status = 'DONE', error = NULL, finished_at = ?, updated_at = ? WHERE id = ?`),
  saveArtifacts: db.prepare('UPDATE builds SET artifacts = ? WHERE id = ?'),
  appendError: db.prepare('UPDATE builds SET error = ? WHERE id = ?'),
};

// ---------- vault ciphertexts ----------
const vaultStmts = {
  upsert: db.prepare(`INSERT INTO vault_secrets (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
  byName: db.prepare('SELECT value FROM vault_secrets WHERE name = ?'),
  delete: db.prepare('DELETE FROM vault_secrets WHERE name = ?'),
};

// ---------- settings (auto-build toggle) ----------
function kvGet(k) { const r = db.prepare('SELECT v FROM settings WHERE k = ?').get(k); return r ? r.v : null; }
function kvSet(k, v) { db.prepare(`INSERT INTO settings (k, v) VALUES (?, ?)
  ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, String(v)); }

module.exports = { db, buildStmts, vaultStmts, kvGet, kvSet, now };
