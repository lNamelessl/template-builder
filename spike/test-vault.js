// spike/test-vault.js — SPIKE PROOF: AES-256-GCM vault round-trip, masked
// display, key-file permissions, redaction list. Isolated DATA_DIR (no /data
// on this dev box — config falls back to the repo .data dir; the spike pins its
// own tmp dir so the proofs never touch real state).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), `tb-spike-vault-${Date.now()}`);

const vault = require('../src/vault');
const builder = require('../src/builder');

async function main() {
  console.log('SPIKE test-vault — AES-256-GCM round trip + masking + redaction');
  // 1. key file auto-generated with 0600
  const keyPath = path.join(process.env.DATA_DIR, 'vault.key');
  assert.ok(fs.existsSync(keyPath), 'vault.key not auto-generated');
  const mode = fs.statSync(keyPath).mode & 0o777;
  console.log(`  key file: ${keyPath} mode=${mode.toString(8)}`);
  if (process.platform !== 'win32') assert.strictEqual(mode, 0o600, 'vault.key must be 0600');
  else console.log('  (windows dev box: mode check skipped — enforced on the Linux container)');

  // 2. round trip
  const secret = 'sk-probe-abcdef1234567890WXYZ';
  vault.set('LLM_API_KEY', secret);
  assert.strictEqual(vault.get('LLM_API_KEY'), secret, 'round trip failed');
  const row = require('../src/db').vaultStmts.byName.get('LLM_API_KEY');
  assert.ok(!String(row.value).includes(secret), 'CIPHERTEXT CONTAINS PLAINTEXT — not encrypted');
  assert.ok(Buffer.from(row.value, 'base64').length > 30, 'ciphertext too short (iv+tag+ct)');
  console.log('  round trip: set -> get identical; ciphertext on disk is NOT the plaintext (AES-256-GCM iv+tag+ct) — ENCRYPTED AT REST');

  // 3. masked display
  const st = vault.status().find((t) => t.name === 'LLM_API_KEY');
  assert.ok(st.set && st.masked, 'status missing masked');
  assert.ok(st.masked.includes('…'), 'mask missing ellipsis');
  assert.ok(!st.masked.includes(secret.slice(4, -4)), 'mask leaks middle chars');
  console.log(`  masked display: "${st.masked}" — MASK OK`);

  // 4. optional tokens excluded from missing()
  vault.set('RAILWAY_TOKEN', 'railway-token-abcdef123456');
  vault.set('GITHUB_TOKEN', 'ghp_abcdef1234567890uvwxyzabc');
  const missing = vault.missing().map((m) => m.token);
  assert.deepStrictEqual(missing, [], 'missing() must be empty when the 3 required tokens are set (TAVILY stays optional)');
  vault.set('TAVILY_API_KEY', 'tvly-optional-123');
  assert.deepStrictEqual(vault.missing().map((m) => m.token), [], 'TAVILY must stay optional in missing()');
  console.log('  guided-state logic: 3 required tokens -> missing=[]; TAVILY optional — GUIDED STATES OK');

  // 5. redaction list (used by the builder log redactor)
  const rl = vault.redactionList();
  assert.ok(rl.length >= 4 && rl.includes(secret), 'redaction list missing a stored secret');
  const sample = `pushing with x-access-token:ghp_abcdef1234567890uvwxyzabc@github.com/x/y.git and Bearer sk-probe-abcdef1234567890WXYZ`;
  const red = builder.buildRedactor()(sample);
  assert.ok(!red.includes('ghp_abcdef1234567890uvwxyzabc'), 'PAT-in-URL leaked through the redactor');
  assert.ok(!red.includes(secret), 'LLM key leaked through the redactor');
  console.log(`  redactor: "${red.slice(0, 120)}…" — SECRETS REDACTED`);

  // 6. tampered ciphertext -> get() returns null (GCM auth tag fails), no throw
  const dbm = require('../src/db');
  dbm.vaultStmts.upsert.run('RAILWAY_TOKEN', Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef').toString('base64'), new Date().toISOString());
  assert.strictEqual(vault.get('RAILWAY_TOKEN'), null, 'tampered ciphertext must yield null (auth-tag failure), not a throw');
  console.log('  tampered ciphertext -> null (typed degraded state, no crash) — GCM AUTH OK');
  console.log('RESULT: PASS — AES-256-GCM round trip, 0600 key file, masked display, optional-token guided states, redaction, auth-tag tamper resistance');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('RESULT: FAIL', e); process.exit(1); });
}
module.exports = { main };
