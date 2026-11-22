// src/server.js — Fastify app: /api/health (dotless, unauth, zero upstream calls),
// password gate, setup wizard (live-validated token boxes), builds API + SSE,
// workspace file browser, settings, static UI. Boots healthy with ZERO tokens:
// every DeepSeek/build op returns a guided 503-shape naming the missing token
// + its deep link. The 3 user tokens NEVER appear as env vars or in responses —
// they are entered via the wizard and stored AES-256-GCM by src/vault.js.
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
const researcher = require('./researcher');
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
    auto_build: kvGet('auto_build') === '1',
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
<div class="sub">describe an app &rarr; research &rarr; confirm &rarr; build &rarr; publish</div>
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
    auto_build: kvGet('auto_build') === '1',
  };
});

// ---------- token live-validators (server-side; typed errors) ----------
async function validateRailway(token) {
  // NB: the backboard schema dropped `viewer` (drift, quirk-62f class) — the
  // caller identity query is now `query { me { id email name } }`; a bad token
  // returns an auth-level "Not Authorized" error (schema-valid), a good token
  // returns the account row.
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query { me { id email name } }' }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => null);
  if (json && json.data && json.data.me && json.data.me.id) return { ok: true, login: json.data.me.email || json.data.me.name || 'railway' };
  const msgs = (json && json.errors ? json.errors : []).map((e) => e && e.message).filter(Boolean).join('; ');
  const msg = (msgs || (res.status !== 200 ? `HTTP ${res.status}` : 'unauthorized')).slice(0, 160);
  if (/not authorized/i.test(msg) || res.status === 401 || res.status === 403) {
    return { ok: false, code: 'invalid_railway_token', message: 'Railway rejected this token (Not Authorized).', next_action: 'Create a NEW token at railway.com/account/tokens — it is shown once; paste it here immediately.' };
  }
  return { ok: false, code: 'invalid_railway_token', message: `Railway rejected this token (${msg}).`, next_action: 'Create a NEW token at railway.com/account/tokens — it is shown once; paste it here immediately.' };
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

// ---------- setup wizard: PROVIDER step (type + base URL + key + model [+ tavily]) ----------
app.get('/api/setup/provider-types', async () => ({ types: llm.PROVIDER_TYPES }));

app.post('/api/setup/provider', async (req, reply) => {
  const body = req.body || {};
  const type = String(body.type || '').trim();
  const baseUrl = String(body.base_url || '').trim().replace(/\/+$/, '');
  const apiKey = String(body.api_key || '').trim();
  const model = String(body.model || '').trim();
  const tavilyKey = String(body.tavily_key || '').trim();
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
    probe = await llm.probeProvider({ type, baseUrl, apiKey, model, tavilyKey });
  } catch (e) {
    return reply.code(502).send({ error: 'probe_network', message: `Could not reach the provider: ${String(e.message || e).slice(0, 160)}`, next_action: 'Check network/egress and the base URL, then retry — nothing was stored.' });
  }
  if (!probe.ok) {
    return reply.code(400).send({ error: probe.code, message: probe.message, next_action: probe.next_action, matrix: probe.matrix || null });
  }

  // persist: provider config (settings) + secrets (vault, AES-256-GCM)
  llm.saveProviderConfig({ type, baseUrl, model, caps: probe.caps });
  vault.set('LLM_API_KEY', apiKey);
  if (tavilyKey) { vault.set('TAVILY_API_KEY', tavilyKey); kvSet('tavily_set', '1'); }
  else if (vault.get('TAVILY_API_KEY') && type !== 'deepseek') kvSet('tavily_set', '1');
  if (vault.missing().length === 0) kvSet('wizard_done', '1');
  emit(0, 'provider_saved', { type, model });
  return {
    ok: true, type, model, base_url: baseUrl, masked: vault.mask(apiKey),
    matrix: probe.matrix, caps: probe.caps,
    tavily_saved: Boolean(tavilyKey),
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
  if (vault.missing().length === 0) kvSet('wizard_done', '1');
  emit(0, 'token_saved', { name, masked }); // header chips refresh via polling anyway
  return { ok: true, name, masked, wizard_done: vault.missing().length === 0, login: v.login || null };
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
    auto_build: Boolean(r.auto_build), created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at,
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
  const auto = (req.body || {}).auto_build === true || kvGet('auto_build') === '1';
  const r = buildStmts.insert.run(idea, auto ? 1 : 0, now(), now());
  const id = Number(r.lastInsertRowid);
  reply.code(202).send({ queued: true, id, status: 'SETUP', auto_build: auto });
  kickPipeline(id);
});

function kickPipeline(id) {
  const row = buildStmts.byId.get(id);
  if (!row) return;
  if (row.auto_build === 1) {
    // auto mode: straight through research -> build
    researcher.runResearch(id, row.idea)
      .then(() => {
        const fresh = buildStmts.byId.get(id);
        if (fresh && (fresh.status === 'AWAITING_CONFIRM' || fresh.status === 'RESEARCHING')) {
          buildStmts.saveConfirm.run(now(), now(), id);
          return builder.runBuildLoop(id, { resume: false });
        }
        return null;
      })
      .catch((e) => console.error(`[build ${id}] pipeline error`, e));
  } else {
    researcher.runResearch(id, row.idea).catch((e) => console.error(`[build ${id}] research error`, e));
  }
}

app.get('/api/builds/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const r = buildStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such build.', next_action: 'Pick one from the sidebar list.' });
  return {
    ...listRow(r),
    idea: r.idea,
    research: safeParse(r.research, null),
    uniqueness: safeParse(r.uniqueness, null),
    citations: safeParse(r.citations, []),
    trajectory: safeParse(r.trajectory, null),
    build_trajectory: safeParse(r.build_trajectory, null),
    log_tail: r.log_tail || null,
    running: builder.isRunning(id),
    resumable: r.status === 'FAILED' && fs.existsSync(builder.sandboxRoot(id)) && (r.error || '').includes('[resumable]'),
    artifacts: safeParse(r.artifacts, []),
    research_at: r.research_at, confirmed_at: r.confirmed_at, published_at: r.published_at,
  };
});

app.post('/api/builds/:id/confirm', async (req, reply) => {
  const id = Number(req.params.id);
  const r = buildStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such build.' });
  if (r.status !== 'AWAITING_CONFIRM') return reply.code(409).send({ error: 'bad_status', message: `Build is ${r.status}; confirm applies to AWAITING_CONFIRM.`, next_action: 'Reload the build.' });
  const missing = vault.missing();
  if (missing.length) {
    return reply.code(503).send({ error: 'not_configured', message: `${missing.map((m) => m.token).join(', ')} missing.`, missing, next_action: 'Complete the setup wizard first.' });
  }
  buildStmts.saveConfirm.run(now(), now(), id);
  builder.runBuildLoop(id, { resume: false }).catch((e) => console.error(`[build ${id}] build error`, e));
  return { confirmed: true, id, status: 'BUILDING' };
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

app.post('/api/builds/:id/research', async (req, reply) => {
  const id = Number(req.params.id);
  const r = buildStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such build.' });
  if (builder.isRunning(id)) return reply.code(429).send({ error: 'busy', message: 'This build is running.' });
  if (!llm.isConfigured()) {
    return reply.code(503).send({ error: 'not_configured', message: 'The LLM provider is not configured on this deployment.', next_action: 'Open the setup wizard (gear icon) and complete the provider step — type, base URL, API key and model are live-probed before anything is stored.' });
  }
  researcher.runResearch(id, r.idea).catch((e) => console.error(`[build ${id}] research error`, e));
  reply.code(202).send({ queued: true, id });
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
  if (!artifacts.find((a) => a.name === wanted)) return reply.code(404).send({ error: 'not_found', message: `No artifact named ${wanted} for this build.`, next_action: 'Research generates research.md; a finished build generates result.md.' });
  const p = path.join(config.dataDir, 'artifacts', String(id), wanted);
  if (!fs.existsSync(p)) return reply.code(410).send({ error: 'gone', message: 'Artifact file missing from the volume.' });
  reply.header('Content-Type', 'text/markdown; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${wanted}"`);
  reply.send(fs.readFileSync(p));
});

// ---------- settings ----------
app.get('/api/settings', async () => ({
  provider: llm.loadProviderConfig(),
  matrix: llm.matrixView(),
  deep_search_available: (llm.matrixView() || {}).server_search === true,
  max_output_tokens: config.maxTokens,
  caps: { max_turns: config.maxTurns, spend_cap_usd: config.spendCapUsd, build_timeout_min: config.buildTimeoutMin },
  auto_build: kvGet('auto_build') === '1',
  tokens: vault.status(),
  price_note: 'DeepSeek providers: estimates use peak list prices ($0.75/1k server-tool uses, $0.30/M in, $1.20/M out; off-peak half). Non-DeepSeek providers: token counts tracked, provider billing on your account.',
}));

app.post('/api/settings', async (req, reply) => {
  const body = req.body || {};
  if (typeof body.auto_build === 'boolean') {
    kvSet('auto_build', body.auto_build ? '1' : '0');
    return { ok: true, auto_build: body.auto_build };
  }
  return reply.code(400).send({ error: 'bad_setting', message: 'Only auto_build is writable here; caps are env-tunable (MAX_TURNS, SPEND_CAP_USD, BUILD_TIMEOUT_MIN).' });
});

// ---------- boot ----------
writeFirstLoginFile();
bootBanner();

app.listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`[builder] listening on :${config.port}`))
  .catch((e) => { console.error('[builder] listen failed', e); process.exit(1); });

module.exports = app;
