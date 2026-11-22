// src/vault.js — AES-256-GCM secret vault for the 3 user tokens.
// Key: 32 random bytes auto-generated ONCE into <dataDir>/vault.key (chmod 600),
// never exported, never logged. Ciphertexts live in builder.db (vault_secrets
// table); a stolen DB without the key file decrypts nothing.
// Display is always masked (prefix…last4) — raw values never leave get()/redaction.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const KNOWN_TOKENS = [
  // the LLM key is provider-agnostic (native DeepSeek, any OpenAI-compatible or
  // Anthropic-compatible provider) — the wizard's provider step saves it
  { name: 'LLM_API_KEY', label: 'LLM provider API key', link: null, optional: false },
  { name: 'RAILWAY_TOKEN', label: 'Railway account token', link: 'https://railway.com/account/tokens', optional: false },
  { name: 'GITHUB_TOKEN', label: 'GitHub classic PAT (repo scope)', link: 'https://github.com/settings/tokens/new?description=template-builder&scopes=repo', optional: false },
  { name: 'TAVILY_API_KEY', label: 'Tavily key (optional web research for non-DeepSeek providers)', link: 'https://app.tavily.com/home', optional: true },
];

// ---------- instance key (auto-generated on the volume, 0600) ----------
function loadKey() {
  const keyPath = path.join(config.dataDir, 'vault.key');
  let raw;
  try {
    raw = fs.readFileSync(keyPath, 'utf8').trim();
    if (raw.length < 40) throw new Error('key file too short');
  } catch (e) {
    const key = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
    try { fs.chmodSync(keyPath, 0o600); } catch (e2) { /* windows dev */ }
    raw = key;
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('vault.key is not 32 bytes of base64');
  return buf;
}
const KEY = loadKey();

// ---------- AES-256-GCM round trip ----------
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function decrypt(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  if (raw.length < 29) throw new Error('ciphertext too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------- storage (lazy db import avoids a circular require) ----------
let stmts = null;
function loadStmts() {
  if (stmts) return stmts;
  const { vaultStmts } = require('./db');
  stmts = vaultStmts;
  return stmts;
}

function set(name, value) {
  const v = String(value || '').trim();
  if (!v) throw new Error('empty value');
  const s = loadStmts();
  s.upsert.run(name, encrypt(v), new Date().toISOString());
  return mask(v);
}

function get(name) {
  const s = loadStmts();
  const row = s.byName.get(name);
  if (!row) return null;
  try { return decrypt(row.value); } catch (e) { return null; }
}

function del(name) {
  const s = loadStmts();
  s.delete.run(name);
}

function mask(value) {
  const v = String(value || '');
  if (!v) return null;
  const tail = v.slice(-4);
  const head = v.slice(0, v.includes('-') ? v.indexOf('-') + 1 : 3);
  return `${head}…${tail}`;
}

// status of every known token, in wizard order
function status() {
  return KNOWN_TOKENS.map((t) => {
    const v = get(t.name);
    return { name: t.name, label: t.label, link: t.link, optional: Boolean(t.optional), set: Boolean(v), masked: mask(v) || null };
  });
}

function missing() {
  return KNOWN_TOKENS.filter((t) => !t.optional && !get(t.name)).map((t) => ({
    token: t.name, message: `${t.label} is not set on this deployment.`,
    next_action: `Open the setup wizard and paste your ${t.label}${t.link ? ` — get it at ${t.link}` : ''}`,
    link: t.link,
  }));
}

// every stored raw value — used ONLY by the log redactor (never returned to the UI)
function redactionList() {
  const out = [];
  for (const t of KNOWN_TOKENS) {
    const v = get(t.name);
    if (v) out.push(v);
  }
  return out;
}

module.exports = { KNOWN_TOKENS, set, get, del, mask, status, missing, redactionList, encrypt, decrypt };
