// src/auth.js — APP_ACCESS_PASSWORD gate (harness pattern, adapted banner).
// sha256-derived session token; accepted via cookie, x-platform-password header
// (raw password), or Authorization Bearer. Empty password = gate disabled.
// First-login self-service (playbook rule 5): deploy-log banner + marker-guarded
// /data/first-login.txt seed that never re-fires; banner says change-it-now.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const vault = require('./vault');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function tokenFor(password) { return sha256(`tb-v1:${password}`); }

const TOKEN = config.appPassword ? tokenFor(config.appPassword) : null;

function requestToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)builder_token=([A-Za-z0-9]+)/);
  if (m) return m[1];
  const header = req.headers['x-platform-password'];
  if (header) return tokenFor(String(header));
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return tokenFor(auth.slice(7));
  return null;
}

function isAuthed(req) {
  if (!config.appPassword) return true; // gate disabled
  return requestToken(req) === TOKEN;
}

// ---------- first-login self-service (playbook rule 5) ----------
// Marker-guarded: rewrites first-login.txt only when the password hash changes.
function writeFirstLoginFile() {
  if (!config.appPassword) return;
  try {
    const marker = path.join(config.dataDir, '.first-login-marker');
    const prev = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    const cur = sha256(config.appPassword);
    if (prev === cur) return;
    fs.writeFileSync(path.join(config.dataDir, 'first-login.txt'),
      `Template Builder first login\n============================\n\nLogin password (from APP_ACCESS_PASSWORD):\n\n    ${config.appPassword}\n\nChange it NOW via the APP_ACCESS_PASSWORD variable (Railway -> your service -> Variables).\nThen complete the setup wizard in the UI: paste your DeepSeek, Railway and GitHub tokens (each is validated live and stored AES-encrypted on this volume).\nThis file refreshes only when the password changes.\n`);
    fs.writeFileSync(marker, cur);
  } catch (e) { /* non-fatal */ }
}

function bootBanner() {
  const lines = [];
  if (config.appPassword) {
    lines.push('==============================================================');
    lines.push('  TEMPLATE BUILDER FIRST LOGIN');
    lines.push(`  UI password = value of APP_ACCESS_PASSWORD:  ${config.appPassword}`);
    lines.push('  (also written to /data/first-login.txt on the volume)');
    lines.push('  CHANGE IT NOW: Railway -> your service -> Variables -> APP_ACCESS_PASSWORD');
    lines.push('==============================================================');
  } else {
    lines.push('[auth] APP_ACCESS_PASSWORD empty — UI gate DISABLED. Set the variable (e.g. ${{secret(24)}}) to protect your builder.');
  }
  const missing = vault.status().filter((t) => !t.set && !t.optional).map((t) => t.name);
  const providerCfg = (() => { try { return require('./llm').loadProviderConfig(); } catch (e) { return null; } })();
  if (missing.length || !providerCfg) {
    lines.push('==============================================================');
    lines.push('  SETUP INCOMPLETE — the guided setup wizard is pending');
    if (!providerCfg) {
      lines.push('  Step 1 - LLM provider (type + base URL + key + model; live-probed');
      lines.push('  incl. a function-calling probe before anything saves):');
      lines.push('  - deepseek (default):  https://platform.deepseek.com/api_keys');
      lines.push('  - openai-compat:       OpenAI/OpenRouter/Groq/Together/Ollama/vLLM key');
      lines.push('  - anthropic-compat:    Anthropic-compatible key (/v1/messages)');
    }
    if (missing.includes('RAILWAY_TOKEN')) {
      lines.push('  Step 2 - RAILWAY_TOKEN: https://railway.com/account/tokens  ("New Token")');
    }
    if (missing.includes('GITHUB_TOKEN')) {
      lines.push('  Step 3 - GITHUB_TOKEN:  https://github.com/settings/tokens/new (classic PAT, repo scope)');
    }
    lines.push('  Exact next action: open the service domain -> setup wizard (bolt icon).');
    lines.push('  Tokens are AES-256-GCM encrypted on the volume; builds stay in a guided');
    lines.push('  state until each one is saved.');
    lines.push('==============================================================');
  }
  for (const l of lines) console.log(l);
}

module.exports = { isAuthed, tokenFor, TOKEN, writeFirstLoginFile, bootBanner, sha256 };
