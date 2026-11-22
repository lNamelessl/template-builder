// src/server.js — Fastify app: /api/health (dotless, unauth, zero upstream calls),
// password gate, setup wizard (live-validated token boxes), builds API + SSE,
// workspace file browser, settings, static UI. Boots healthy with ZERO tokens:
// every build op returns a guided 503-shape naming the missing token + its deep
// link. The 3 user tokens NEVER appear as env vars or in responses — they are
// entered via the wizard and stored AES-256-GCM by src/vault.js.
// Flow: describe an app -> build (tool-loop) -> publish. No research phase.
'use strict';
const fs = require('fs');
const path = require('path');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const cookie = require('@fastify/cookie');
const formbody = require('@fastify/formbody');

const config = require('./config');
const vault = require('./vault');
const llm = require('./llm');
const { isAuthed, tokenFor, TOKEN, writeFirstLoginFile, bootBanner, sha256 } = require('./auth');
const { buildStmts, kvGet, kvSet, now } = require('./db');
const builder = require('./builder');
const { bus, emit } = require('./bus');
const { pushTelegram } = require('./telegram');

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 1024 * 1024 });
app.register(cookie);
app.register(formbody);

// ---------- static assets (open: css/js only, no secrets) ----------
app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public'), prefix: '/public/' });

// ---------- auth gate ----------
app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0];
  const open = url === '/health' || url === '/api/health' || url === '/login' || url === '/api/me' || url.startsWith('/public/');
  if (open) return;
  if (url.startsWith('/api/') && !isAuthed(req)) {
    reply.code(401).send({
      error: 'unauthorized',
      message: 'This builder is password-gated.',
      next_action: config.appPassword
        ? 'Log in at /login (password = APP_ACCESS_PASSWORD) or send the x-platform-password header.'
        : 'Set APP_ACCESS_PASSWORD (Railway -> Variables) to enable the gate.',
    });
  }
  // '/' is handled by its own route (redirects to /login when gated)
});

// ---------- health (dotless, unauth, NO upstream calls) ----------
function healthPayload() {
  const counts = {};
  try {
    for (const r of require('./db').db.prepare('SELECT status, COUNT(*) AS n FROM builds GROUP BY status').all()) counts[r.status] = r.n;
  } catch (e) { /* db not ready yet */ }
  const tokens = vault.status();
  const providerCfg = llm.loadProviderConfig();
  return {
    status: 'ok',
    service: 'template-builder',
    tokens: tokens.map((t) => ({ name: t.name, set: t.set, masked: t.masked })),
    missing_tokens: tokens.filter((t) => !t.set && !t.optional).map((t) => t.name),
    provider_configured: llm.isConfigured(),
    provider: providerCfg ? { type: providerCfg.type, model: providerCfg.model, base_url: providerCfg.baseUrl } : null,
    matrix: llm.matrixView(),
    password_gate: Boolean(config.appPassword),
    telegram: Boolean(config.telegramToken && config.telegramChat),
    wizard_done: kvGet('wizard_done') === '1',
    builds: counts,
    caps: { max_turns: config.maxTurns, spend_cap_usd: config.spendCapUsd, build_timeout_min: config.buildTimeoutMin },
    uptime_s: Math.round(process.uptime()),
  };
}
app.get('/health', async () => healthPayload());
app.get('/api/health', async () => healthPayload());

// ---------- login (same pattern as harness) ----------
function loginPage(message = '') {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Template Builder login</title><style>
body{background:#101014;color:#e8e8ef;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1a1a22;border:1px solid #2c2c38;border-radius:14px;padding:34px;width:340px}
h1{font-size:17px;margin:0 0 4px}.sub{color:#8b8ba0;font-size:12.5px;margin-bottom:18px}
input{width:100%;box-sizing:border-box;background:#0e0e12;border:1px solid #2c2c38;color:#e8e8ef;border-radius:9px;padding:11px 13px;font-size:14px;outline:none}
input:focus{border-color:#4d6bfe}
button{width:100%;margin-top:12px;background:#4d6bfe;color:#fff;border:0;border-radius:9px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#3f5ce0}
.msg{color:#ff8a8a;font-size:12.5px;margin-top:10px;white-space:pre-wrap}
.brand{color:#6d6d84;font-size:11px;margin-top:16px;text-align:center}
</style></head><body><div class="card"><h1>&#9678; Template Builder</h1>
<div class="sub">describe an app &rarr; build &rarr; publish</div>
<form method="post" action="/login"><input type="password" name="password" placeholder="Access password" autofocus autocomplete="current-password">
<button type="submit">Unlock builder</button>${message ? `<div class="msg">${esc(message)}</div>` : ''}</form>
<div class="brand">password = APP_ACCESS_PASSWORD (Railway &rarr; Variables, or /data/first-login.txt)</div></div></body></html>`;
}

app.get('/login', async (req, reply) => {
  if (!config.appPassword) return reply.redirect('/');
  reply.type('text/html').send(loginPage());
});

app.post('/login', async (req, reply) => {
  if (!config.appPassword) return reply.redirect('/');
  const body = req.body || {};
  const supplied = body.password || req.headers['x-platform-password'] || '';
  if (sha256(String(supplied)) !== sha256(config.appPassword)) {
    reply.code(401).type('text/html').send(loginPage('Wrong password — it is the APP_ACCESS_PASSWORD variable value (Railway → your service → Variables, or /data/first-login.txt).'));
    return;
  }
  reply.setCookie('builder_token', TOKEN, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 });
  reply.redirect('/');
});

app.post('/logout', async (req, reply) => {
  reply.clearCookie('builder_token', { path: '/' });
  reply.send({ ok: true });
});

// ---------- UI ----------
app.get('/', async (req, reply) => {
  if (config.appPassword && !isAuthed(req)) return reply.redirect('/login');
  reply.type('text/html').send(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html')));
});

// ---------- me (wizard state) ----------
app.get('/api/me', async () => {
  const tokens = vault.status();
  const pcfg = llm.loadProviderConfig();
  return {
    password_enabled: Boolean(config.appPassword),
    tokens,
    missing: tokens.filter((t) => !t.set && !t.optional).map((t) => t.name),
    provider_types: llm.PROVIDER_TYPES,
    provider: pcfg ? { type: pcfg.type, base_url: pcfg.baseUrl, model: pcfg.model, saved_at: pcfg.saved_at } : null,
    provider_configured: llm.isConfigured(),
    matrix: llm.matrixView(),
    wizard_done: kvGet('wizard_done') === '1',
  };
});

// ---------- token live-validators (server-side; typed errors) ----------
async function validateRailway(token) {
  // Two live token classes exist (measured 2026-11-22):
  //  - ACCOUNT tokens answer `query { me { id email name } }`
  //  - WORKSPACE tokens (rlwy_wksp_*) CANNOT answer `me` (Not Authorized) but
  //    CAN list the workspace's projects — which is exactly what the builder
  //    needs (project create/deploy/publish inside that workspace).
  // Validate with `me` first; fall back to the projects query so workspace
  // tokens are accepted with an honest scope disclosure.
  const gql = (query) => fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000),
  }).then((r) => r.json().catch(() => null));

  const me = await gql('query { me { id email name } }');
  if (me && me.data && me.data.me && me.data.me.id) {
    return { ok: true, login: me.data.me.email || me.data.me.name || 'railway', scope: 'account' };
  }
  const proj = await gql('query { projects(first: 1) { edges { node { id workspaceId } } } }');
  if (proj && proj.data && proj.data.projects && Array.isArray(proj.data.projects.edges)) {
    const wsId = ((proj.data.projects.edges[0] || {}).node || {}).workspaceId || null;
    return { ok: true, login: 'workspace-scoped token (projects readable)', scope: 'workspace', workspaceId: wsId };
  }
  const msgs = ((me && me.errors) || (proj && proj.errors) || []).map((e) => e && e.message).filter(Boolean).join('; ');
  const msg = (msgs || 'unauthorized').slice(0, 160);
  return { ok: false, code: 'invalid_railway_token', message: `Railway rejected this token (${msg}).`, next_action: 'Create a NEW token at railway.com/account/tokens — it is shown once; paste it here immediately (account tokens and workspace tokens are both accepted).' };
}

async function validateGitHub(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'template-builder' },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) return { ok: false, code: 'github_token_invalid', message: 'GitHub rejected this token (HTTP 401).', next_action: 'Create a classic PAT at github.com/settings/tokens/new with the repo scope and paste it again.' };
  if (res.status !== 200) return { ok: false, code: 'github_upstream', message: `GitHub returned HTTP ${res.status}.`, next_action: 'Check github.com/status and retry.' };
  const scopes = String(res.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const data = await res.json().catch(() => ({}));
  if (!scopes.includes('repo')) {
    return { ok: false, code: 'github_scope_missing', message: `Token works (login ${data.login || '?'}) but the repo scope is missing (scopes: ${scopes.join(', ') || 'none'}).`, next_action: 'Create a CLASSIC PAT at github.com/settings/tokens/new with the repo scope checked — fine-grained tokens without repo contents access will fail to push.' };
  }
  return { ok: true, login: data.login || 'github' };
}

const VALIDATORS = {
  RAILWAY_TOKEN: validateRailway,
  GITHUB_TOKEN: validateGitHub,
  // the LLM key is validated by the PROVIDER step (probeProvider below), not here
};

// ---------- setup wizard: PROVIDER step (type + base URL + key + model) ----------
app.get('/api/setup/provider-types', async () => ({ types: llm.PROVIDER_TYPES }));

app.post('/api/setup/provider', async (req, reply) => {
  const body = req.body || {};
  const type = String(body.type || '').trim();
  const baseUrl = String(body.base_url || '').trim().replace(/\/+$/, '');
  const apiKey = String(body.api_key || '').trim();
  const model = String(body.model || '').trim();
  const meta = llm.PROVIDER_TYPES.find((t) => t.type === type);
  if (!meta) {
    return reply.code(400).send({ error: 'unknown_provider_type', message: `Unknown provider type "${type}".`, next_action: 'Pick one of: deepseek, openai-compat, anthropic-compat.' });
  }
  if (!apiKey) return reply.code(400).send({ error: 'empty_value', message: 'Paste the provider API key first.', next_action: 'Create the key at your provider and paste it here — it is live-probed before anything is stored.' });
  if (!model) return reply.code(400).send({ error: 'empty_model', message: 'Enter the model name.', next_action: `Use the suggested model "${meta.model}" or type your provider's exact model id.` });
  if (!baseUrl) return reply.code(400).send({ error: 'empty_base_url', message: 'Enter the provider base URL.', next_action: `Use the suggested base URL ${meta.base} (editable for OpenRouter/Groq/Ollama/vLLM gateways).` });

  // LIVE probe: 1-token connectivity + tool-call capability (REQUIRED for the build loop)
  let probe;
  try {
    probe = await llm.probeProvider({ type, baseUrl, apiKey, model });
  } catch (e) {
    return reply.code(502).send({ error: 'probe_network', message: `Could not reach the provider: ${String(e.message || e).slice(0, 160)}`, next_action: 'Check network/egress and the base URL, then retry — nothing was stored.' });
  }
  if (!probe.ok) {
    return reply.code(400).send({ error: probe.code, message: probe.message, next_action: probe.next_action, matrix: probe.matrix || null });
  }

  // persist: provider config (settings) + secrets (vault, AES-256-GCM)
  llm.saveProviderConfig({ type, baseUrl, model, caps: probe.caps });
  vault.set('LLM_API_KEY', apiKey);
  if (vault.missing().length === 0) kvSet('wizard_done', '1');
  emit(0, 'provider_saved', { type, model });
  return {
    ok: true, type, model, base_url: baseUrl, masked: vault.mask(apiKey),
    matrix: probe.matrix, caps: probe.caps,
    wizard_done: vault.missing().length === 0,
  };
});

app.delete('/api/setup/provider', async () => {
  kvSet('llm_type', '');
  vault.del('LLM_API_KEY');
  return { ok: true, note: 'Provider config cleared — guided states return until the provider step is completed again.' };
});

app.post('/api/setup/token', async (req, reply) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const value = String(body.value || '').trim();
  if (!VALIDATORS[name]) {
    return reply.code(400).send({ error: 'unknown_token', message: `Unknown token name "${name}".`, next_action: 'Use RAILWAY_TOKEN or GITHUB_TOKEN here; the LLM key is saved via the provider step (POST /api/setup/provider).' });
  }
  if (!value) {
    return reply.code(400).send({ error: 'empty_value', message: 'Paste the token value first.', next_action: 'Follow the deep link, create the token, paste it here.' });
  }
  let v;
  try { v = await VALIDATORS[name](value); } catch (e) {
    return reply.code(502).send({ error: 'validation_network', message: `Live validation could not reach the ${name} provider: ${String(e.message || e).slice(0, 160)}`, next_action: 'Check network/egress and retry — nothing was stored.' });
  }
  if (!v.ok) {
    return reply.code(400).send({ error: v.code, message: v.message, next_action: v.next_action, link: (vault.KNOWN_TOKENS.find((t) => t.name === name) || {}).link });
  }
  const masked = vault.set(name, value);
  if (name === 'RAILWAY_TOKEN') {
    if (v.workspaceId) kvSet('railway_workspace_id', v.workspaceId);
    kvSet('railway_token_scope', v.scope || 'account');
  }
  if (vault.missing().length === 0) kvSet('wizard_done', '1');
  emit(0, 'token_saved', { name, masked }); // header chips refresh via polling anyway
  return { ok: true, name, masked, wizard_done: vault.missing().length === 0, login: v.login || null, scope: v.scope || null };
});

app.delete('/api/setup/token/:name', async (req, reply) => {
  const name = String(req.params.name || '');
  if (!VALIDATORS[name]) return reply.code(400).send({ error: 'unknown_token', message: `Unknown token name "${name}".` });
  vault.del(name);
  kvSet('wizard_done', '0');
  return { ok: true, name, wizard_done: false };
});

app.post('/api/setup/skip', async (req, reply) => {
  kvSet('wizard_done', '1');
  return { ok: true, note: 'Wizard dismissed — guided 503 states appear on every DeepSeek/build op until all 3 tokens are saved.' };
});

// ---------- builds ----------
const safeParse = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } };

function listRow(r) {
  return {
    id: r.id, idea: String(r.idea).slice(0, 160), status: r.status, cost_usd: r.cost_usd, turns: r.turns,
    repo_url: r.repo_url, template_url: r.template_url, error: r.error ? String(r.error).slice(0, 200) : null,
    created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at,
  };
}

app.get('/api/builds', async () => ({ builds: buildStmts.list.all().map(listRow) }));

app.post('/api/builds', async (req, reply) => {
  const idea = String((req.body || {}).idea || '').trim();
  if (idea.length < 8 || idea.length > 4000) {
    return reply.code(400).send({ error: 'bad_idea', message: 'Describe your idea in 8-4000 characters (a paragraph or a URL).', next_action: 'Add a sentence or two about what the app should do.' });
  }
  const missing = vault.missing();
  if (missing.length) {
    return reply.code(503).send({
      error: 'not_configured',
      message: `${missing.length} token(s) missing: ${missing.map((m) => m.token).join(', ')}.`,
      missing,
      next_action: 'Open the setup wizard (gear icon) and paste each token — each is live-validated and stored AES-encrypted on this volume.',
    });
  }
  if (builder.isRunningAny()) {
    return reply.code(429).send({ error: 'busy', message: 'A build is already running (concurrency 1).', next_action: 'Wait for it to finish or cancel it, then submit again.' });
  }
  const r = buildStmts.insert.run(idea, now(), now());
  const id = Number(r.lastInsertRowid);
  reply.code(202).send({ queued: true, id, status: 'SETUP' });
  // straight-build pipeline: no research phase, no confirm gate
  builder.runBuildLoop(id, { resume: false }).catch((e) => console.error(`[build ${id}] build error`, e));
});

app.get('/api/builds/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const r = buildStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such build.', next_action: 'Pick one from the sidebar list.' });
  return {
    ...listRow(r),
    idea: r.idea,
    build_trajectory: safeParse(r.build_trajectory, null),
    log_tail: r.log_tail || null,
    running: builder.isRunning(id),
    resumable: r.status === 'FAILED' && fs.existsSync(builder.sandboxRoot(id)) && (r.error || '').includes('[resumable]'),
    artifacts: safeParse(r.artifacts, []),
    published_at: r.published_at,
  };
});

app.post('/api/builds/:id/resume', async (req, reply) => {
  const id = Number(req.params.id);
  const r = buildStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such build.' });
  if (r.status !== 'FAILED') return reply.code(409).send({ error: 'bad_status', message: `Build is ${r.status}; resume applies to FAILED.` });
  const missing = vault.missing();
  if (missing.length) return reply.code(503).send({ error: 'not_configured', message: `${missing.map((m) => m.token).join(', ')} missing.`, missing, next_action: 'Complete the setup wizard first.' });
  buildStmts.setStatus.run('BUILDING', now(), id);
  buildStmts.appendError.run(null, id);
  builder.runBuildLoop(id, { resume: true }).catch((e) => console.error(`[build ${id}] resume error`, e));
  return { resumed: true, id, status: 'BUILDING' };
});

app.post('/api/builds/:id/cancel', async (req, reply) => {
  const id = Number(req.params.id);
  if (!builder.isRunning(id)) return reply.code(409).send({ error: 'not_running', message: 'This build is not running.' });
  builder.cancel(id);
  return { cancelling: true, id };
});

// ---------- SSE per build ----------
app.get('/api/builds/:id/events', async (req, reply) => {
  const id = Number(req.params.id);
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(`event: hello\ndata: ${JSON.stringify({ build: id })}\n\n`);
  const listener = (payload) => {
    try { reply.raw.write(`event: progress\ndata: ${payload}\n\n`); } catch (e) { /* closed */ }
  };
  bus.on(`build:${id}`, listener);
  const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch (e) { /* */ } }, 15000);
  req.raw.on('close', () => { clearInterval(ping); bus.off(`build:${id}`, listener); });
});

// ---------- workspace files (auth-gated, path-guarded) ----------
app.get('/api/builds/:id/files', async (req, reply) => {
  const id = Number(req.params.id);
  if (!buildStmts.byId.get(id)) return reply.code(404).send({ error: 'not_found', message: 'No such build.' });
  const root = builder.sandboxRoot(id);
  if (!fs.existsSync(root)) return { files: [], note: 'workspace not created yet — it appears when the build loop starts' };
  const out = [];
  const walk = (dir, depth, prefix) => {
    if (depth > 3 || out.length >= 250) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (['.home', '.tmp', 'node_modules', '.git'].includes(e.name)) { out.push(`${prefix}${e.name}/ (elided)`); continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { out.push(`${prefix}${e.name}/`); walk(full, depth + 1, `${prefix}  `); }
      else {
        let sz = 0;
        try { sz = fs.statSync(full).size; } catch (e2) { /* */ }
        out.push(`${prefix}${e.name} (${sz} B)`);
      }
    }
  };
  walk(root, 0, '');
  return { files: out };
});

app.get('/api/builds/:id/file', async (req, reply) => {
  const id = Number(req.params.id);
  if (!buildStmts.byId.get(id)) return reply.code(404).send({ error: 'not_found', message: 'No such build.' });
  const root = builder.sandboxRoot(id);
  let p;
  try { p = builder.resolveIn(root, String(req.query.path || '')); } catch (e) {
    return reply.code(400).send({ error: 'sandbox_escape', message: String(e.message || e), next_action: 'Use a path inside the build workspace.' });
  }
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return reply.code(404).send({ error: 'not_found', message: 'No such file in the workspace.' });
  const st = fs.statSync(p);
  if (st.size > 400 * 1024) return reply.code(413).send({ error: 'too_large', message: `File is ${st.size} B (cap 400 KB preview).`, next_action: 'Use run_shell from the agent, or fetch via the repo.' });
  const buf = fs.readFileSync(p);
  // binary sniff
  const isText = !buf.subarray(0, 8000).includes(0);
  reply.header('Content-Type', isText ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  return isText ? buf.toString('utf8') : buf;
});

// ---------- artifacts (whitelist-only; /data itself is never served) ----------
app.get('/api/builds/:id/artifacts/:name', async (req, reply) => {
  const id = Number(req.params.id);
  const r = buildStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such build.' });
  const wanted = String(req.params.name || '');
  if (!/^[a-z0-9._-]+$/i.test(wanted)) return reply.code(400).send({ error: 'bad_name', message: 'Artifact name restricted to [a-z0-9._-].' });
  const artifacts = safeParse(r.artifacts, []);
  if (!artifacts.find((a) => a.name === wanted)) return reply.code(404).send({ error: 'not_found', message: `No artifact named ${wanted} for this build.`, next_action: 'A finished build generates result.md.' });
  const p = path.join(config.dataDir, 'artifacts', String(id), wanted);
  if (!fs.existsSync(p)) return reply.code(410).send({ error: 'gone', message: 'Artifact file missing from the volume.' });
  reply.header('Content-Type', 'text/markdown; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${wanted}"`);
  reply.send(fs.readFileSync(p));
});

// ---------- settings (view-only; caps are env-tunable) ----------
app.get('/api/settings', async () => ({
  provider: llm.loadProviderConfig(),
  matrix: llm.matrixView(),
  caps: { max_turns: config.maxTurns, spend_cap_usd: config.spendCapUsd, build_timeout_min: config.buildTimeoutMin },
  tokens: vault.status(),
  price_note: 'DeepSeek providers: estimates use peak list prices ($0.30/M in, $1.20/M out; off-peak half). Non-DeepSeek providers: token counts tracked, provider billing on your account.',
}));

// ---------- boot ----------
writeFirstLoginFile();
bootBanner();

// reconcile builds stuck in an active state from a previous container (the old
// loop died with its container during a redeploy): mark FAILED + resumable so
// the stop-condition/resume path can take over. Legacy research-era states
// (AWAITING_CONFIRM / RESEARCHING) can no longer advance — the research phase
// was removed — so they are reconciled to FAILED[resumable] too and resume
// runs the build loop directly on the idea.
try {
  const rows = buildStmts.list.all();
  const stuck = rows.filter((r) => ['BUILDING', 'PUBLISHING'].includes(r.status));
  for (const r of stuck) {
    if (builder.isRunning(r.id)) continue;
    buildStmts.saveFailure.run('stuck-state reconciliation: the build loop died with its container (redeploy) — resume continues from the existing workspace [resumable]', now(), now(), r.id);
    console.log(`[boot] reconciled stuck build #${r.id} (was ${r.status}) -> FAILED [resumable]`);
  }
  const legacy = rows.filter((r) => ['AWAITING_CONFIRM', 'RESEARCHING'].includes(r.status));
  for (const r of legacy) {
    buildStmts.saveFailure.run('legacy research-era build: the research phase was removed — resume runs the build loop directly on the idea [resumable]', now(), now(), r.id);
    console.log(`[boot] reconciled legacy build #${r.id} (was ${r.status}) -> FAILED [resumable]`);
  }
} catch (e) { console.error('[boot] reconciliation failed', e); }

app.listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`[builder] listening on :${config.port}`))
  .catch((e) => { console.error('[builder] listen failed', e); process.exit(1); });

module.exports = app;
