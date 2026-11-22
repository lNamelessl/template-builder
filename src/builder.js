// src/builder.js — Phase 2 build loop: PROVIDER-AGNOSTIC function-calling tool
// executor. Tools: write_file / read_file / list_dir / run_shell, all jailed to
// the build's sandbox root /data/builds/<id> (path traversal blocked). Tool defs
// are CANONICAL ({name, description, parameters}) — each protocol adapter maps
// them (OpenAI tools/tool_calls, Anthropic tool_use/tool_result); the loop and
// the researcher are adapter-blind. Shell env is allowlisted with
// RAILWAY_TOKEN/GITHUB_TOKEN injected per call; every output/arg that crosses
// the log/SSE boundary passes the redactor (vault values + PAT-in-URL patterns).
// Caps (env-tunable): MAX_TURNS (default 40), SPEND_CAP_USD (default 5, DeepSeek
// providers only — token-priced cost; others cap on turns), BUILD_TIMEOUT_MIN
// (default 60) — hitting any cap = graceful FAILED + resume.
'use strict';
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const config = require('./config');
const vault = require('./vault');
const llm = require('./llm');
const { buildSystemPrompt, knowledgeVersion } = require('./promptgen');
const { emit } = require('./bus');
const { buildStmts, now, kvGet } = require('./db');
const { pushTelegram } = require('./telegram');

const LOG_TAIL_CAP = 32 * 1024;
const SHELL_TIMEOUT_MS = 240 * 1000;
const SHELL_OUTPUT_CAP = 8000;
const READ_CAP = 16 * 1024;
const FILE_BROWSE_CAP = 400 * 1024;

// The container is Linux (/bin/sh). Windows dev boxes run the spike through
// Git Bash's POSIX sh so the same command syntax is exercised end to end.
const POSIX_SH = process.platform === 'win32'
  ? (fs.existsSync('C:/Program Files/Git/bin/sh.exe') ? 'C:/Program Files/Git/bin/sh.exe' : (process.env.COMSPEC || 'cmd.exe'))
  : '/bin/sh';

const running = new Map(); // buildId -> {cancel: false, startedAt}
function isRunning(buildId) { return running.has(buildId); }
function isRunningAny() { return running.size > 0; }
function cancel(buildId) { const r = running.get(buildId); if (r) r.cancel = true; }

function sandboxRoot(buildId) { return path.join(config.dataDir, 'builds', String(buildId)); }

// ---------- redaction ----------
function buildRedactor() {
  const secrets = vault.redactionList();
  const patterns = [
    /sk-[A-Za-z0-9]{16,}/g,
    /ghp_[A-Za-z0-9]{30,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /(x-access-token:)[^@\s]+(@)/g,
    /(Bearer\s+)[A-Za-z0-9._-]{20,}/g,
  ];
  return function redact(text) {
    let out = String(text || '');
    for (const s of secrets) {
      if (s && s.length >= 6) out = out.split(s).join('***REDACTED***');
    }
    for (const re of patterns) out = out.replace(re, (m, p1, p2) => (p1 !== undefined ? `${p1}***REDACTED***${p2}` : '***REDACTED***'));
    return out;
  };
}

// ---------- sandboxed fs helpers ----------
function resolveIn(ws, rel) {
  const p = path.resolve(ws, String(rel || '.'));
  const normWs = path.resolve(ws);
  if (p !== normWs && !p.startsWith(normWs + path.sep)) {
    const err = new Error(`path "${rel}" escapes the workspace sandbox — refused`);
    err.code = 'sandbox_escape';
    throw err;
  }
  return p;
}

function toolWriteFile(ws, rel, content) {
  const p = resolveIn(ws, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (buf.length > FILE_BROWSE_CAP) throw new Error(`file too large for one write (${buf.length} bytes > ${FILE_BROWSE_CAP}) — split it`);
  fs.writeFileSync(p, buf);
  return { path: String(rel), bytes: buf.length };
}

function toolReadFile(ws, rel) {
  const p = resolveIn(ws, rel);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error(`${rel} is a directory — use list_dir`);
  if (st.size > READ_CAP) {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(READ_CAP);
    fs.readSync(fd, buf, 0, READ_CAP, 0);
    fs.closeSync(fd);
    return { content: buf.toString('utf8'), bytes: st.size, truncated: true };
  }
  return { content: fs.readFileSync(p, 'utf8'), bytes: st.size, truncated: false };
}

function toolListDir(ws, rel) {
  const p = resolveIn(ws, rel);
  const out = [];
  const walk = (dir, depth, prefix) => {
    if (depth > 3 || out.length >= 200) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' && depth === 0) { out.push(`${prefix}${e.name}/ (git dir, elided)`); continue; }
      if (['node_modules', '.home', '.tmp'].includes(e.name)) { out.push(`${prefix}${e.name}/ (elided)`); continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(`${prefix}${e.name}/`);
        walk(full, depth + 1, `${prefix}  `);
      } else {
        let sz = 0;
        try { sz = fs.statSync(full).size; } catch (e2) { /* */ }
        out.push(`${prefix}${e.name} (${sz} B)`);
      }
    }
  };
  walk(p, 0, '');
  return { listing: out.join('\n').slice(0, 6000) };
}

// ---------- shell runner (allowlisted env + injected secrets) ----------
function toolRunShell(ws, command, redact, timeoutMs = SHELL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const home = path.join(ws, '.home');
    fs.mkdirSync(home, { recursive: true });
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: path.join(ws, '.tmp'),
      LANG: 'en_US.UTF-8',
      CI: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      DEBIAN_FRONTEND: 'noninteractive',
      SHELL: '/bin/sh',
    };
    try { fs.mkdirSync(env.TMPDIR, { recursive: true }); } catch (e) { /* */ }
    const gh = vault.get('GITHUB_TOKEN');
    const rtk = vault.get('RAILWAY_TOKEN');
    if (gh) env.GITHUB_TOKEN = gh;
    if (rtk) env.RAILWAY_TOKEN = rtk;

    const child = exec(String(command || '').slice(0, 20000), {
      cwd: ws, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: POSIX_SH, killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : (err.killed ? 'TIMEOUT' : 1)) : 0;
      const so = redact(String(stdout || '')).slice(0, SHELL_OUTPUT_CAP);
      const se = redact(String(stderr || '')).slice(0, SHELL_OUTPUT_CAP);
      resolve({ exit_code: code, stdout: so, stderr: se, truncated: String(stdout || '').length > SHELL_OUTPUT_CAP });
    });
    return child;
  });
}

// ---------- history collapsing (keep last turn verbatim, elide older results) ----------
function collapseHistory(messages, keepLast = 2) {
  // find indices of tool result messages; elide all but the newest `keepLast` groups
  const toolIdx = [];
  messages.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
  const keep = new Set(toolIdx.slice(-keepLast));
  for (const i of toolIdx) {
    if (keep.has(i)) continue;
    const m = messages[i];
    const content = String(m.content || '');
    if (content.length > 220) m.content = `${content.slice(0, 180)}\n[elided: earlier tool result, ${content.length} chars]`;
  }
  return messages;
}

// ---------- main build loop ----------
async function runBuildLoop(buildId, { resume = false } = {}) {
  const redact = buildRedactor();
  const ws = sandboxRoot(buildId);
  const row = buildStmts.byId.get(buildId);
  if (!row) throw new Error('build not found');
  const ghLogin = getGhLogin();

  buildStmts.setStatus.run('BUILDING', now(), buildId);
  emit(buildId, 'phase', { phase: 'building', status: 'BUILDING' });
  fs.mkdirSync(ws, { recursive: true });

  const state = { cancel: false, startedAt: Date.now() };
  running.set(buildId, state);

  let logTail = row.log_tail || '';
  const appendLog = (line) => {
    logTail = `${logTail}${line}\n`;
    if (logTail.length > LOG_TAIL_CAP) logTail = logTail.slice(-LOG_TAIL_CAP);
  };
  const flushLog = (extra = {}) => {
    buildStmts.saveBuildProgress.run(
      JSON.stringify(trajectorySummary), costSoFar, turnCount, logTail, now(), buildId,
    );
    if (extra.persist) emit(buildId, 'log', { tail: logTail.slice(-2000), ...extra });
  };

  let costSoFar = row.cost_usd || 0;
  let totalIn = Number(row.input_tokens || 0);
  let totalOut = Number(row.output_tokens || 0);
  let turnCount = row.turns || 0;
  const turnStart = turnCount; // turn cap applies PER RUN — a resumed build gets a fresh budget
  const trajectorySummary = safeParse(row.build_trajectory) || { turns: [], file_diffs: [], shell_cmds: 0 };
  trajectorySummary.knowledge_version = knowledgeVersion(); // record the pack the agent runs on

  const started = Date.now();
  let stopReason = null;
  let finalText = '';
  let errored = false;

  try {
    const client = llm.resolve();
    if (!client || !client.cfg.apiKey) throw new llm.core.NotConfiguredError('LLM provider key');

    // ---- deterministic publish-completion check (anti-drift stop condition) ----
    // The model sometimes keeps "improving" the workspace after the publish SOP
    // has actually completed, burning turns and re-capping. At loop start (and
    // resume) detect the finished state directly and short-circuit to DONE.
    if (resume) {
      const done = await detectPublished(ws, redact);
      if (done) {
        appendLog(`[auto] publish already complete (repo=${done.repoUrl}, template=${done.templateUrl}) — finishing without further model turns`);
        finalText = `RESULT: template_url=${done.templateUrl} repo_url=${done.repoUrl} health=passed notes=publish SOP verified complete by the builder loop stop-condition`;
        running.delete(buildId);
        await finishDone(buildId, row, done, costSoFar, turnCount, logTail, trajectorySummary);
        return { done: true, templateUrl: done.templateUrl, repoUrl: done.repoUrl };
      }
    }

    const sys = buildSystemPrompt({
      idea: row.idea,
      research: row.research ? safeParse(row.research) : null,
      uniqueness: row.uniqueness ? safeParse(row.uniqueness) : null,
      workspace: ws,
      ghLogin,
      resume,
      provider: `${client.cfg.type}/${client.cfg.model}`,
      railwayScope: kvGet('railway_token_scope') || 'account',
      railwayWorkspaceId: kvGet('railway_workspace_id') || null,
    });
    const messages = [{ role: 'system', content: sys }];
    if (resume) {
      messages.push({ role: 'user', content: 'Resume the build. Inspect the workspace first, then continue the publish SOP from where it stopped. End with the RESULT line.' });
    } else {
      messages.push({ role: 'user', content: `Build and publish this idea now, following the system contract. Idea:\n${row.idea.slice(0, 3000)}` });
    }

    const tools = toolDefs(); // canonical shape; the adapter maps protocol details

    for (;;) {
      // ---- caps ----
      if (state.cancel) { stopReason = 'cancelled'; break; }
      if (turnCount - turnStart >= config.maxTurns) { stopReason = `turn cap reached (${config.maxTurns} this run)`; break; }
      if (costSoFar != null && costSoFar >= config.spendCapUsd) { stopReason = `spend cap reached ($${config.spendCapUsd.toFixed(2)})`; break; }
      if (Date.now() - started > config.buildTimeoutMin * 60 * 1000) { stopReason = `timeout reached (${config.buildTimeoutMin} min)`; break; }

      turnCount++;
      emit(buildId, 'phase', { phase: 'turn', turn: turnCount, max_turns: config.maxTurns });

      collapseHistory(messages, 2);
      // normalized event stream -> build SSE (adapter-blind)
      let contentChars = 0;
      const r = await client.chat({
        messages,
        tools,
        maxTokens: 16000,
        timeoutMs: 480000,
        onEvent: (type, data) => {
          if (type === 'text-delta') { contentChars += (data.text || '').length; emit(buildId, 'text', { chars: contentChars }); }
          else if (type === 'reasoning-delta') emit(buildId, 'reasoning', data);
          else if (type === 'retrying') emit(buildId, 'phase', { phase: 'retrying', note: data.note });
        },
      });

      const usage = r.usage;
      const isDeepseek = client.cfg.type === 'deepseek';
      const turnCost = isDeepseek
        ? llm.core.estimateCost(usage, { priceSearchPer1k: 0, priceInPerM: config.priceInPerM, priceOutPerM: config.priceOutPerM })
        : null;
      costSoFar = turnCost != null ? (costSoFar || 0) + turnCost : null;
      totalIn += Number(usage.input_tokens || 0);
      totalOut += Number(usage.output_tokens || 0);
      appendLog(`[turn ${turnCount}] in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'} cost=${turnCost != null ? `$${turnCost.toFixed(4)}` : 'n/a'} finish=${r.finishReason}`);
      emit(buildId, 'cost', { cost_usd: costSoFar, turns: turnCount, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });

      if (r.reasoning) {
        trajectorySummary.turns.push({ turn: turnCount, reasoning_chars: r.reasoning.length });
      }

      // ---- assistant message + tool dispatch ----
      if (r.toolCalls.length) {
        const asstMsg = {
          role: 'assistant',
          content: r.content || null,
          tool_calls: r.toolCalls.map((c, i) => ({ id: c.id || `call_${turnCount}_${i}`, name: c.name, arguments: c.arguments || '{}' })),
        };
        messages.push(asstMsg);
        for (const call of asstMsg.tool_calls) {
          let result;
          try {
            const args = safeParse(call.arguments) || {};
            result = await execTool(ws, call.name, args, redact);
            appendLog(`[turn ${turnCount}] ${call.name} ${summarizeArgs(call.name, args)} -> ${result.ok ? 'ok' : `ERR ${String(result.error).slice(0, 120)}`}`);
            emit(buildId, 'tool', {
              turn: turnCount, name: call.name,
              args: summarizeArgs(call.name, args),
              ok: result.ok,
              detail: result.detail || null,
              error: result.ok ? null : String(result.error).slice(0, 300),
            });
            if (call.name === 'run_shell' && result.ok) {
              trajectorySummary.shell_cmds++;
              maybePublishPhase(buildId, args.command);
            }
            if (call.name === 'write_file' && result.ok) {
              trajectorySummary.file_diffs.push({ path: result.detail.path, bytes: result.detail.bytes, turn: turnCount });
              emit(buildId, 'file', { path: result.detail.path, bytes: result.detail.bytes, turn: turnCount });
            }
          } catch (e) {
            result = { ok: false, error: redact(String(e.message || e)).slice(0, 500) };
          }
          const toolContent = result.ok
            ? JSON.stringify(result.result).slice(0, 12000)
            : JSON.stringify({ error: result.error });
          messages.push({ role: 'tool', tool_call_id: call.id, content: redact(toolContent).slice(0, 12000) });
        }
        flushLog();
        continue; // next turn
      }

      // ---- no tool calls: final message ----
      finalText = r.content || '';
      appendLog(`[turn ${turnCount}] final message (${finalText.length} chars)`);
      emit(buildId, 'text_done', { chars: finalText.length });
      break;
    }
  } catch (err) {
    errored = true;
    const typed = err instanceof llm.core.NotConfiguredError || err instanceof llm.core.BusyError
      || err instanceof llm.core.RiskError || err instanceof llm.core.UpstreamError;
    const errText = String(err.message || err).slice(0, 400);
    appendLog(`[error] ${errText}`);
    finishFailed(buildId, errText, costSoFar, turnCount, logTail, trajectorySummary, !typed);
  }

  running.delete(buildId);
  if (errored) return { failed: true };

  // ---- caps / cancel reached: graceful FAILED with resume ----
  if (stopReason && !finalText) {
    finishFailed(buildId, `${stopReason} — resume continues from the existing workspace`, costSoFar, turnCount, logTail, trajectorySummary, false, true);
    return { stopped: stopReason };
  }

  // ---- post-loop verification ----
  buildStmts.saveBuildProgress.run(JSON.stringify(trajectorySummary), costSoFar, turnCount, logTail, now(), buildId);
  buildStmts.saveCost.run(costSoFar, totalIn, totalOut, now(), buildId);
  buildStmts.setStatus.run('PUBLISHING', now(), buildId);
  emit(buildId, 'phase', { phase: 'verifying', status: 'PUBLISHING' });

  const ver = await verifyBuild(ws, redact, finalText);
  appendLog(`[verify] template=${ver.templateUrl || 'MISSING'} repo=${ver.repoUrl || 'MISSING'} health=${ver.health}`);

  if (ver.templateUrl && ver.repoUrl) {
    await finishDone(buildId, row, ver, costSoFar, turnCount, logTail, trajectorySummary, totalIn, totalOut);
    return { done: true, ...ver };
  }

  const why = ver.problem || `verification failed — template URL or repo URL missing (health=${ver.health})`;
  finishFailed(buildId, `${why} — resume to retry the publish SOP from the existing workspace`, costSoFar, turnCount, logTail, trajectorySummary, false, true);
  return { stopped: why };
}

// ---------- DONE completion (shared by the model path + the stop-condition path) ----------
async function finishDone(buildId, row, ver, cost, turns, logTail, trajectory, totalIn = null, totalOut = null) {
  buildStmts.saveUrls.run(ver.repoUrl, ver.repoName, ver.templateUrl, ver.templateSlug, now(), now(), buildId);
  const artifacts = [];
  for (const name of ['research.md', 'result.md']) {
    const p = path.join(config.dataDir, 'artifacts', String(buildId), name);
    if (fs.existsSync(p)) artifacts.push({ name, path: `/api/builds/${buildId}/artifacts/${encodeURIComponent(name)}`, bytes: fs.statSync(p).size, created_at: now() });
  }
  buildStmts.saveArtifacts.run(JSON.stringify(artifacts), buildId);
  writeArtifact(buildId, 'result.md', resultMarkdown(row, ver, cost, turns, ver.health));
  buildStmts.saveDone.run(now(), now(), buildId);
  buildStmts.saveBuildProgress.run(JSON.stringify(trajectory), cost, turns, logTail, now(), buildId);
  if (totalIn != null) buildStmts.saveCost.run(cost, totalIn, totalOut, now(), buildId);
  emit(buildId, 'done', {
    status: 'DONE', template_url: ver.templateUrl, repo_url: ver.repoUrl,
    cost_usd: cost, turns, health: ver.health,
  });
  pushTelegram(`build #${buildId} DONE\n${ver.templateUrl}\nrepo: ${ver.repoUrl}\ncost ${cost != null ? `$${Number(cost).toFixed(3)}` : 'n/a (tokens tracked)'} · ${turns} turns`).catch(() => {});
}

// ---------- deterministic publish-completion detection ----------
// Called on resume before any model turn: if the GitHub repo remote exists AND
// the workspace's templates list shows the project's template PUBLISHED, the
// publish SOP is complete — return the real URLs.
async function detectPublished(ws, redact) {
  const remote = await sh(ws, 'git remote get-url origin 2>/dev/null || true', redact, 15000);
  const rm = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?\s*$/.exec(remote || '');
  if (!rm) return null;
  const repoUrl = `https://github.com/${rm[1]}/${rm[2]}`;
  const repoName = rm[2];
  // PRIMARY: the workspace's own templates list (in-app CLI has RAILWAY_TOKEN
  // injected and templates commands are proven to work — the agent itself
  // creates drafts with it).
  const listing = await sh(ws, 'railway templates list 2>/dev/null || true', redact, 60000);
  const lines = String(listing || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([^\s(][^(]*?)\s+\(([^)]+)\)\s*$/.exec(lines[i]);
    if (!m) continue;
    if (m[1].trim().toLowerCase() !== repoName.toLowerCase()) continue;
    const next = (lines[i + 1] || '') + '\n' + (lines[i + 2] || '');
    if (/PUBLISHED/.test(next)) {
      return { repoUrl, repoName, templateUrl: `https://railway.com/deploy/${m[2]}`, templateSlug: m[2], health: 'passed' };
    }
  }
  // FALLBACK: unauth marketplace search (index can lag — verify the record
  // actually resolves before trusting it).
  try {
    const res = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query($q: String!) { templateSearch(first: 10, query: $q) { edges { node { code name } } } }', variables: { q: repoName } }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json();
    const rows = ((j.data && j.data.templateSearch && j.data.templateSearch.edges) || []).map((e) => e.node);
    for (const n of rows) {
      if (!n || String(n.name || '').toLowerCase() !== repoName.toLowerCase() || !n.code) continue;
      const md = await fetch(`https://railway.com/deploy/${n.code}.md`, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (md && md.ok) return { repoUrl, repoName, templateUrl: `https://railway.com/deploy/${n.code}`, templateSlug: n.code, health: 'passed' };
    }
  } catch (e) { /* fall through */ }
  return null;
}

// ---------- tool plumbing ----------
// CANONICAL tool defs — protocol adapters map them per provider
// (OpenAI: {type:'function',function:{...}}; Anthropic: {name,description,input_schema}).
function toolDefs() {
  return [
    { name: 'write_file', description: 'Create or overwrite a file inside your workspace sandbox (parent dirs auto-created). Content is the full file text. Paths are relative to the workspace root; escaping it is refused.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'relative path, e.g. Dockerfile or src/index.js' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    { name: 'read_file', description: 'Read a workspace file (first 16 KB; truncated flag when larger).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'list_dir', description: 'List the workspace tree (3 levels deep, node_modules/.git elided).', parameters: { type: 'object', properties: { path: { type: 'string', description: 'defaults to workspace root' } } } },
    { name: 'run_shell', description: 'Run a POSIX shell command with cwd = workspace root. $GITHUB_TOKEN and $RAILWAY_TOKEN are available in the env — use them for gh/railway/curl auth but NEVER echo or persist them. Output capped 8000 chars per stream.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  ];
}

async function execTool(ws, name, args, redact) {
  switch (name) {
    case 'write_file': {
      const d = toolWriteFile(ws, args.path, args.content);
      return { ok: true, result: d, detail: { path: d.path, bytes: d.bytes } };
    }
    case 'read_file': {
      const d = toolReadFile(ws, args.path);
      const preview = d.content.length > 1200 ? `${d.content.slice(0, 1200)}…` : d.content;
      return { ok: true, result: d, detail: `${d.bytes} B${d.truncated ? ' (truncated)' : ''}: ${preview.slice(0, 160).replace(/\n/g, ' ')}` };
    }
    case 'list_dir': {
      const d = toolListDir(ws, args.path || '.');
      return { ok: true, result: d, detail: d.listing.split('\n').slice(0, 12).join(' | ') };
    }
    case 'run_shell': {
      const d = await toolRunShell(ws, args.command, redact);
      const tail = `${d.truncated ? '[output truncated] ' : ''}${d.stderr ? `STDERR: ${d.stderr}` : ''}${d.stdout}`;
      return { ok: d.exit_code === 0 || d.exit_code === 'TIMEOUT', result: d, detail: redact(tail).slice(0, 400) };
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

function summarizeArgs(name, args) {
  if (name === 'run_shell') return `$ ${String(args.command || '').slice(0, 160)}`;
  if (name === 'write_file') return `${args.path} (${Buffer.byteLength(String(args.content || ''))} B)`;
  return String(args.path || '').slice(0, 120);
}

// PUBLISHING display heuristic: first railway-heavy shell command flips the status chip
function maybePublishPhase(buildId, command) {
  const c = String(command || '');
  if (/\brailway\b/.test(c) && (/\bup\b|\btemplates\b/.test(c))) {
    const row = buildStmts.byId.get(buildId);
    if (row && row.status === 'BUILDING') buildStmts.setStatus.run('PUBLISHING', now(), buildId);
  }
}

// ---------- post-loop verification ----------
async function verifyBuild(ws, redact, finalText) {
  const out = { templateUrl: null, templateSlug: null, repoUrl: null, repoName: null, health: 'unknown', problem: null };
  // 1) parse the RESULT line from the agent's final message
  const m = /RESULT:\s*template_url=(\S+)\s+repo_url=(\S+)/.exec(finalText || '');
  if (m) {
    out.templateUrl = m[1].startsWith('http') ? m[1] : `https://railway.com/deploy/${m[1].split('/').pop()}`;
    out.repoUrl = m[2].startsWith('http') ? m[2] : `https://github.com/${m[2]}`;
  }
  // 2) repo URL fallback: git remote in the workspace
  if (!out.repoUrl) {
    const remote = await sh(ws, 'git remote get-url origin 2>/dev/null || true', redact);
    const rm = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?\s*$/.exec(remote);
    if (rm) { out.repoName = `${rm[2]}`; out.repoUrl = `https://github.com/${rm[1]}/${rm[2]}`; }
  } else {
    out.repoName = (out.repoUrl.split('/').pop() || '').replace(/\.git$/, '');
  }
  // 3) template fallback: railway status --json -> project + templates (best-effort)
  if (!out.templateUrl) {
    const statusJson = await sh(ws, 'railway status --json 2>/dev/null || true', redact);
    try {
      const st = JSON.parse(statusJson);
      const name = st && st.project && st.project.name;
      if (name) {
        out.templateSlug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        out.templateUrl = `https://railway.com/deploy/${out.templateSlug}`;
      }
    } catch (e) { /* no status */ }
  }
  // 4) live template check (unauth .md endpoint / deploy page)
  if (out.templateUrl) {
    try {
      const slug = out.templateUrl.split('/').pop();
      const res = await fetch(`https://railway.com/deploy/${slug}.md`, { signal: AbortSignal.timeout(20000) });
      if (res.ok) { out.health = 'passed'; }
      else { out.health = 'published-md-missing'; out.problem = `template .md endpoint returned HTTP ${res.status}`; }
    } catch (e) {
      out.health = 'unknown'; out.problem = `template check failed: ${String(e.message || e).slice(0, 120)}`;
    }
  }
  return out;
}

function sh(ws, command, redact, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const gh = vault.get('GITHUB_TOKEN');
    const rtk = vault.get('RAILWAY_TOKEN');
    const env = { PATH: process.env.PATH, HOME: path.join(ws, '.home'), CI: '1', GIT_TERMINAL_PROMPT: '0' };
    if (gh) env.GITHUB_TOKEN = gh;
    if (rtk) env.RAILWAY_TOKEN = rtk;
    exec(command, { cwd: ws, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: POSIX_SH }, (err, stdout) => {
      resolve(redact(String(stdout || '')));
      void err;
    });
  });
}

function getGhLogin() {
  try {
    const gh = vault.get('GITHUB_TOKEN');
    if (!gh) return '<unknown>';
    const res = require('child_process').execFileSync('curl', ['-s', '-H', `Authorization: Bearer ${gh}`, 'https://api.github.com/user'], { timeout: 15000, encoding: 'utf8' });
    const j = JSON.parse(res);
    return j.login || '<unknown>';
  } catch (e) { return '<unknown>'; }
}

// ---------- failure / result helpers ----------
function finishFailed(buildId, errText, cost, turns, logTail, trajectory, telegram = true, resumable = true) {
  buildStmts.saveBuildProgress.run(JSON.stringify(trajectory), cost, turns, logTail, now(), buildId);
  buildStmts.saveFailure.run(`${errText}${resumable ? ' [resumable]' : ''}`, now(), now(), buildId);
  emit(buildId, 'failed', { error: errText, cost_usd: cost, turns, resumable });
  if (telegram) pushTelegram(`build #${buildId} FAILED\n${errText.slice(0, 200)}`).catch(() => {});
}

function resultMarkdown(row, ver, cost, turns, health) {
  return `# Build #${row.id} result — ${String(row.idea).slice(0, 80)}

- Template: ${ver.templateUrl}
- Repo: ${ver.repoUrl}
- Health: ${health}
- Cost: ${cost != null ? `$${Number(cost).toFixed(4)} (LLM tokens, peak-list estimate)` : 'n/a for this provider (token counts tracked on the build row)'}
- Turns: ${turns}
- Published: ${new Date().toISOString()}
`;
}

function writeArtifact(buildId, name, content) {
  const dir = path.join(config.dataDir, 'artifacts', String(buildId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

module.exports = { runBuildLoop, cancel, isRunning, isRunningAny, sandboxRoot, resolveIn, buildRedactor, toolDefs, execTool };
