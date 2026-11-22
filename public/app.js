// public/app.js — builder UI logic (vanilla JS, SSE progress, no frameworks).
// 3-pane dark workspace: LEFT builds list; CENTER build detail (report +
// uniqueness table + trajectory + composer + confirm/result cards); RIGHT
// workspace files + result + log tail. Setup wizard: provider step (type/base/
// key/model [+Tavily for non-DeepSeek]) with a live capability matrix, then the
// Railway/GitHub token boxes with deep links + live validation.
'use strict';
const $ = (id) => document.getElementById(id);
const state = {
  builds: [], selected: null, filter: '', es: null, poll: null,
  reasoningLive: '', me: null, provTypes: [], provType: null, wsPoll: null,
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function rich(s) {
  let v = s;
  if (v !== null && typeof v === 'object') v = JSON.stringify(v, null, 1);
  let h = esc(v);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(https?:\/\/[^\s<)"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return h;
}

async function api(path, opts = {}) {
  const init = { ...opts };
  if (init.body && !init.headers) init.headers = { 'Content-Type': 'application/json' };
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || res.statusText);
    err.envelope = body;
    err.status = res.status;
    throw err;
  }
  return body;
}

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.display = 'none'; }, 6000);
}

// ---------- builds list ----------
async function loadBuilds() {
  try {
    const q = new URLSearchParams();
    if (state.filter) q.set('filter', state.filter);
    const data = await api(`/api/builds?${q}`);
    const sig = JSON.stringify(data.builds);
    if (sig !== state._sig) {
      state._sig = sig;
      state.builds = data.builds;
      renderList();
    }
  } catch (e) {
    if (e.status === 401) window.location.href = '/login';
  }
}

function renderList() {
  const list = $('build-list');
  if (!state.builds.length) {
    list.innerHTML = '<div class="list-empty">No builds yet.<br>Describe an app idea in the composer below.</div>';
    $('list-count').textContent = '';
    return;
  }
  list.innerHTML = state.builds.map((b) => {
    const badges = [
      b.cost_usd != null ? `<span class="badge cost">$${Number(b.cost_usd).toFixed(3)}</span>` : '',
      b.turns ? `<span class="badge">${b.turns} turns</span>` : '',
      b.error ? '<span class="badge err">error</span>' : '',
    ].filter(Boolean).join('');
    return `<div class="build-card ${state.selected === b.id ? 'sel' : ''}" data-id="${b.id}">
      <div class="nm"><span class="name" title="${esc(b.idea)}">${esc(b.idea.slice(0, 44))}</span>
      <span class="chip-status st-${esc(b.status)}">${esc(b.status)}</span></div>
      <div class="badges">${badges}</div>
    </div>`;
  }).join('');
  $('list-count').textContent = `${state.builds.length} build${state.builds.length === 1 ? '' : 's'} · polling every 6s`;
  list.querySelectorAll('.build-card').forEach((el) => {
    el.onclick = () => selectBuild(Number(el.dataset.id));
  });
}

// ---------- build detail ----------
async function selectBuild(id) {
  state.selected = id;
  renderList();
  stopSSE();
  let b;
  try { b = await api(`/api/builds/${id}`); } catch (e) { toast(e.message, true); return; }
  $('empty-center').style.display = 'none';
  $('build-view').style.display = 'flex';
  renderBuild(b);
  loadWorkspace(id);
  if (['RESEARCHING', 'BUILDING', 'PUBLISHING'].includes(b.status) || (b.status === 'SETUP' && b.running)) {
    connectSSE(id);
  }
}

function capabilityChips(me) {
  if (!me || !me.matrix) return '';
  const m = me.matrix;
  const chip = (on, label, cls = '') => `<span class="hdr-chip ${on ? cls : ''}">${label}</span>`;
  return [
    chip(true, `${esc(m.provider)} · ${esc(m.model)}`, 'model'),
    chip(m.server_search, m.server_search ? 'server search on' : `web: ${esc(m.web_research)}`),
    chip(m.function_calling === 'ok', m.function_calling === 'ok' ? 'tools on' : `tools: ${esc(m.function_calling)}`),
  ].join('');
}

function renderBuild(b) {
  $('build-title').textContent = String(b.idea).slice(0, 90);
  const st = $('build-status');
  st.textContent = b.status;
  st.className = `chip-status st-${b.status}`;

  const chips = [];
  chips.push(capabilityChips(state.me));
  if (b.cost_usd != null) chips.push(`<span class="hdr-chip cost">cost $${Number(b.cost_usd).toFixed(3)}</span>`);
  if (b.input_tokens != null) chips.push(`<span class="hdr-chip">${b.input_tokens ?? '?'} in / ${b.output_tokens ?? '?'} out tokens</span>`);
  if (b.turns) chips.push(`<span class="hdr-chip">${b.turns} turns</span>`);
  if (b.citations && b.citations.length) chips.push(`<span class="hdr-chip">sources ${b.citations.length}</span>`);
  if (b.researched_at) chips.push(`<span class="hdr-chip">${esc(b.researched_at.slice(0, 16).replace('T', ' '))}Z</span>`);
  $('build-chips').innerHTML = chips.filter(Boolean).join('');

  // thinking / trajectory panel
  const traj = b.trajectory || {};
  const btraj = b.build_trajectory || {};
  const reasoning = state.reasoningLive || (traj.reasoning || '');
  const re = $('reasoning');
  re.textContent = reasoning || (btraj.turns && btraj.turns.length ? `(build phase — ${btraj.turns.length} reasoning turns captured)` : '(no trajectory yet — submit an idea)');
  const toolCalls = traj.tool_calls ?? 0;
  const queries = traj.queries || [];
  $('tool-list').innerHTML = [
    traj.web_research ? `<li>&#127760; web research: <b>${esc(traj.web_research)}</b>${toolCalls ? ` — ${toolCalls} server tool calls${queries.length ? ` — last queries: ${esc(queries.slice(-3).join(' · '))}` : ''}` : ''}</li>` : '',
    b.usage || b.input_tokens != null ? `<li>&#9650;&#65039; usage: ${b.input_tokens ?? '?'} in / ${b.output_tokens ?? '?'} out tokens${b.cost_usd != null ? ` · cost $${Number(b.cost_usd).toFixed(4)}` : ''}</li>` : '',
    traj.finish_reason ? `<li>&#127919; research finish_reason: ${esc(traj.finish_reason)}</li>` : '',
    btraj.file_diffs && btraj.file_diffs.length ? `<li>&#128196; files written: ${btraj.file_diffs.map((f) => `${esc(f.path)} (${f.bytes} B)`).join(', ').slice(0, 400)}</li>` : '',
    btraj.shell_cmds ? `<li>&#128187; shell commands run: ${btraj.shell_cmds}</li>` : '',
  ].filter(Boolean).join('');
  const cites = b.citations || [];
  $('cite-cards').innerHTML = cites.length
    ? cites.slice(0, 40).map((c) => `<a class="cite-card" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer"><span class="t">${esc((c.title || '').slice(0, 110))}</span>${esc(c.url)}</a>`).join('')
    : '';
  $('thinking-meta').textContent = `${reasoning.length} chars reasoning · ${cites.length} citations`;

  // uniqueness table + report + confirm/result cards
  let html = '';
  if (b.research_error || b.error) {
    html += `<div class="report-section"><h3>Error</h3><div class="val" style="color:var(--red)">${rich(b.research_error || b.error)}</div>
      <div class="val" style="color:var(--fg-dim);font-size:12px;margin-top:6px">Use <b>Re-research</b> (research phase) or <b>Resume</b> (build phase) to retry — the workspace keeps its files.</div></div>`;
  }
  if (b.uniqueness) {
    const u = b.uniqueness;
    html += `<div class="report-section"><h3>Marketplace uniqueness (LIVE — ${u.found} matches for "${esc(u.query_used)}")</h3>`;
    if (u.competitors && u.competitors.length) {
      html += `<table class="uni-table"><tr><th>Template</th><th>Creator</th><th>Deploys</th><th>Health</th></tr>`;
      for (const c of u.competitors) {
        const hcls = (c.health ?? 0) === 0 ? 'hl0' : ((c.health ?? 100) < 80 ? 'lh' : 'hl');
        html += `<tr><td class="nm">${esc(c.name)}</td><td>${esc(c.creator || '?')}</td><td>${c.deploys ?? '?'}</td><td class="${hcls}">${c.health ?? '?'}%</td></tr>`;
      }
      html += '</table>';
    } else {
      html += `<div class="val" style="color:var(--green)">No competing templates found for this query — clear field.</div>`;
    }
    html += '</div>';
  }
  const rep = b.research;
  if (rep) {
    if (rep.verdict !== undefined) {
      html += `<div class="verdict-box"><span class="stars">${'&#9733;'.repeat(Number(rep.rating) || 0)}${'&#9734;'.repeat(Math.max(0, 5 - (Number(rep.rating) || 0)))}</span>
        <div class="v">${rich(rep.verdict)}</div></div>`;
    }
    const secs = [
      ['demand', 'Demand'], ['coverage_check', 'Coverage check (vs marketplace)'],
      ['competitor_scan', 'Competitor scan'], ['uniqueness', 'Uniqueness'],
      ['tos_legal_flags', 'ToS / legal flags'], ['implementation_sketch', 'Implementation sketch'],
      ['suggested_name_slug', 'Suggested name / slug'], ['risks', 'Risks'], ['confidence', 'Confidence'],
    ];
    for (const [k, label] of secs) {
      if (rep[k] === undefined || rep[k] === null || rep[k] === '') continue;
      html += `<div class="report-section"><h3>${label}</h3><div class="val">${rich(k === 'rating' ? `${rep.rating}/5` : rep[k])}</div></div>`;
    }
  } else if (!b.research_error && !['SETUP', 'RESEARCHING'].includes(b.status)) {
    html += `<div class="report-section"><div class="val" style="color:var(--fg-faint)">No research yet.</div></div>`;
  }
  $('uniqueness').innerHTML = '';
  $('report').innerHTML = html;

  // confirm card (AWAITING_CONFIRM)
  const cc = $('confirm-card');
  if (b.status === 'AWAITING_CONFIRM' && rep) {
    cc.style.display = 'block';
    cc.innerHTML = `<h3>&#9888;&#65039; Confirm build &amp; publish</h3>
      <div class="row"><span>Verdict <b>${'&#9733;'.repeat(Number(rep.rating) || 0)} (${rep.rating}/5)</b></span>
      <span>Similar templates found: <b>${b.uniqueness ? b.uniqueness.found : '?'}</b></span>
      <span>Est. first cost: <b>${b.cost_usd != null ? `$${Number(b.cost_usd).toFixed(3)}` : 'tokens on your provider account'}</b></span></div>
      <div class="row" style="font-size:11.5px">Build = repo pushed to YOUR GitHub + deployed on YOUR Railway + PUBLISHED as a template on your account. Check the ToS/legal flags above before publishing.</div>
      <div class="row"><button class="act primary" id="cc-build">Build &amp; publish</button>
      <button class="act" id="cc-dismiss">Not now</button></div>`;
    $('cc-build').onclick = () => confirmBuild(b.id);
    $('cc-dismiss').onclick = () => { cc.style.display = 'none'; toast('Confirm dismissed — the build stays in AWAITING_CONFIRM; use Build & publish any time.'); };
  } else {
    cc.style.display = 'none';
  }

  // result card (DONE/FAILED)
  const rc = $('result-card');
  if (b.status === 'DONE') {
    rc.style.display = 'block';
    rc.className = '';
    rc.innerHTML = `<h3>&#9989; Build published</h3>
      <div class="url-row">Template: <a href="${esc(b.template_url)}" target="_blank" rel="noopener noreferrer">${esc(b.template_url)}</a></div>
      <div class="url-row">Repo: <a href="${esc(b.repo_url)}" target="_blank" rel="noopener noreferrer">${esc(b.repo_url)}</a></div>
      <div class="meta">cost ${b.cost_usd != null ? `$${Number(b.cost_usd).toFixed(4)}` : 'n/a (tokens tracked)'} · ${b.turns} turns · published ${esc((b.published_at || '').slice(0, 16).replace('T', ' '))}Z</div>`;
  } else if (b.status === 'FAILED' && b.error) {
    rc.style.display = 'block';
    rc.className = 'failed';
    rc.innerHTML = `<h3>&#10060; Build failed</h3>
      <div class="meta">${rich(String(b.error).slice(0, 400))}</div>
      ${b.resumable ? '<div class="url-row"><button class="act" id="rc-resume">Resume build</button> <span class="meta">workspace files + logs are kept on the volume</span></div>' : ''}`;
    const rbtn = $('rc-resume');
    if (rbtn) rbtn.onclick = () => resumeBuild(b.id);
  } else {
    rc.style.display = 'none';
  }

  // log tail (right panel)
  $('log-tail').textContent = b.log_tail || '(no build log yet)';

  // side result
  $('result-side').innerHTML = b.template_url
    ? `Template: <a href="${esc(b.template_url)}" target="_blank" rel="noopener noreferrer">${esc(b.template_url)}</a><br>Repo: <a href="${esc(b.repo_url)}" target="_blank" rel="noopener noreferrer">${esc(b.repo_url)}</a>`
    : (b.status === 'FAILED' ? 'Build failed — see the log tail.' : 'No result yet.');

  // action buttons state
  $('act-confirm').disabled = b.status !== 'AWAITING_CONFIRM';
  $('act-confirm').style.display = b.status === 'AWAITING_CONFIRM' ? '' : 'none';
  $('act-cancel').disabled = !b.running;
  $('act-resume').style.display = (b.status === 'FAILED' && b.resumable) ? '' : 'none';
  $('act-research').style.display = '';
  $('act-research').disabled = b.running || ['RESEARCHING', 'BUILDING', 'PUBLISHING'].includes(b.status);

  // artifacts in workspace panel footer
  const arts = b.artifacts || [];
  if (arts.length) {
    const wsEl = $('workspace');
    const note = document.createElement('div');
    note.innerHTML = `<div class="panel-title">artifacts</div>` + arts.map((a) => `<div class="rt-note"><a href="${esc(a.path)}" download>${esc(a.name)}</a> (${a.bytes} B)</div>`).join('');
    wsEl.appendChild(note);
  }
}

// ---------- SSE progress ----------
function connectSSE(id) {
  stopSSE();
  state.reasoningLive = '';
  const es = new EventSource(`/api/builds/${id}/events`);
  state.es = es;
  const phase = $('phase-line');
  phase.style.display = 'block';
  es.addEventListener('progress', (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.type === 'reasoning') {
      state.reasoningLive = `${state.reasoningLive}${d.delta || ''}`.slice(-9000);
      const re = $('reasoning');
      re.textContent = state.reasoningLive;
      re.scrollTop = re.scrollHeight;
      $('thinking-meta').textContent = `${state.reasoningLive.length}+ chars streaming · live`;
    } else if (d.type === 'tools') {
      $('tool-list').innerHTML = `<li>&#128269; deep search running — <b>${d.count ?? '?'} server tool calls</b>${d.queries?.length ? ` — ${esc(d.queries.join(' · '))}` : ''}</li>`;
    } else if (d.type === 'tool') {
      const tl = $('tool-list');
      const row = document.createElement('li');
      row.innerHTML = `&#128295; <b>${esc(d.name)}</b> ${esc(d.args || '')} ${d.ok ? '&#9989;' : `&#10060; ${esc((d.error || '').slice(0, 120))}`}`;
      tl.appendChild(row);
      tl.scrollTop = tl.scrollHeight;
    } else if (d.type === 'file') {
      loadWorkspace(id);
    } else if (d.type === 'cost') {
      const chips = $('build-chips');
      const found = Array.from(chips.children).find((c) => c.textContent.includes('turns'));
      const label = `${d.turns} turns${d.cost_usd != null ? '' : ''}`;
      if (found) found.textContent = label;
    } else if (d.type === 'phase') {
      phase.textContent = `phase: ${d.phase}${d.turn ? ` (turn ${d.turn}/${d.max_turns})` : ''}${d.note ? ` — ${d.note}` : ''}${d.status ? ` [${d.status}]` : ''}`;
    } else if (d.type === 'log') {
      $('log-tail').textContent = d.tail || $('log-tail').textContent;
    } else if (d.type === 'done' || d.type === 'failed') {
      es.close(); state.es = null;
      phase.style.display = 'none';
      loadBuilds();
      selectBuild(id);
      toast(d.type === 'done'
        ? `Build DONE — template published: ${d.template_url || ''}`
        : `Build failed: ${(d.error || '').slice(0, 140)}`, d.type !== 'done');
    }
  });
  es.onerror = () => { /* stream closed by server or build finished */ };
}

function stopSSE() {
  if (state.es) { state.es.close(); state.es = null; }
  state.reasoningLive = '';
  $('phase-line').style.display = 'none';
}

// ---------- workspace files (right panel) ----------
async function loadWorkspace(id) {
  try {
    const data = await api(`/api/builds/${id}/files`);
    const el = $('workspace');
    if (!data.files || !data.files.length) {
      el.innerHTML = '<div class="rt-note">The live build tree appears here once the build loop starts.</div>';
      return;
    }
    el.innerHTML = `<div class="ws-tree">${data.files.map((f) => `<span class="fl" data-p="${esc(f.trim())}">${esc(f)}</span>`).join('')}</div>`;
    el.querySelectorAll('.fl').forEach((el2) => {
      el2.onclick = () => openFile(id, el2.dataset.p);
    });
  } catch (e) { /* ignore */ }
}

async function openFile(id, p) {
  const m = /^(.*?\/)?([A-Za-z0-9._ -]+)$/.exec(p);
  $('file-name').textContent = p;
  $('file-content').textContent = 'loading…';
  $('modal-file').classList.remove('hidden');
  try {
    const res = await fetch(`/api/builds/${id}/file?path=${encodeURIComponent(p)}`);
    const text = await res.text();
    $('file-content').textContent = res.ok ? text : `${res.status}: ${text.slice(0, 300)}`;
  } catch (e) {
    $('file-content').textContent = String(e.message || e);
  }
}

// ---------- actions ----------
async function submitIdea() {
  const idea = $('idea-input').value.trim();
  if (idea.length < 8) { toast('Describe your idea in at least a sentence (8+ characters).', true); return; }
  try {
    const r = await api('/api/builds', { method: 'POST', body: JSON.stringify({ idea }) });
    $('idea-input').value = '';
    toast(r.auto_build ? 'Build queued (auto-build mode: research + build run straight through)' : 'Research queued — streaming progress below');
    loadBuilds();
    selectBuild(r.id);
  } catch (e) {
    const env = e.envelope || {};
    if (env.missing && env.missing.length) openWizard();
    toast(`${e.message}${env.next_action ? ` — ${env.next_action}` : ''}`, true);
  }
}

async function confirmBuild(id) {
  try {
    await api(`/api/builds/${id}/confirm`, { method: 'POST' });
    toast('Confirmed — build loop starting (trajectory + files stream below)');
    loadBuilds();
    selectBuild(id);
  } catch (e) {
    toast(`Confirm failed: ${e.message}`, true);
  }
}

async function resumeBuild(id) {
  try {
    await api(`/api/builds/${id}/resume`, { method: 'POST' });
    toast('Resumed — continuing from the existing workspace');
    loadBuilds();
    selectBuild(id);
  } catch (e) {
    toast(`Resume failed: ${e.message}`, true);
  }
}

$('act-submit').onclick = submitIdea;
$('idea-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitIdea();
});
$('act-confirm').onclick = () => { if (state.selected) confirmBuild(state.selected); };
$('act-resume').onclick = () => { if (state.selected) resumeBuild(state.selected); };
$('act-cancel').onclick = async () => {
  if (!state.selected) return;
  try { await api(`/api/builds/${state.selected}/cancel`, { method: 'POST' }); toast('Cancel signalled — the loop stops at the next turn boundary'); }
  catch (e) { toast(`Cancel failed: ${e.message}`, true); }
};
$('act-research').onclick = async () => {
  if (!state.selected) return;
  try {
    const r = await api(`/api/builds/${state.selected}/research`, { method: 'POST' });
    if (r.queued) { toast('Re-research queued'); loadBuilds(); selectBuild(state.selected); }
  } catch (e) {
    toast(`${e.message}`, true);
  }
};

// ---------- filter ----------
$('filter').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  loadBuilds();
});

// ---------- thinking collapse ----------
$('thinking-toggle').onclick = () => {
  const p = $('thinking-panel');
  p.classList.toggle('open');
  $('thinking-meta').textContent = p.classList.contains('open') ? 'expanded' : 'collapsed';
};

// ---------- setup wizard ----------
function openWizard() {
  $('modal-wizard').classList.remove('hidden');
  refreshWizard();
}
async function refreshWizard() {
  try {
    const me = await api('/api/me');
    state.me = me;
    state.provTypes = me.provider_types || [];
    renderProvTypes();
    // token boxes state
    for (const t of me.tokens || []) {
      if (t.optional) continue;
      const box = $(`tok-${t.name}`);
      const st = $(`st-${t.name}`);
      if (!box || !st) continue;
      if (t.set) { box.classList.add('ok'); st.className = 'tok-state ok'; st.textContent = `saved (${t.masked}) — validated live on save`; }
      else { box.classList.remove('ok'); st.className = 'tok-state'; st.textContent = ''; }
    }
  } catch (e) { /* ignore */ }
}

function renderProvTypes() {
  const wrap = $('prov-types');
  if (!state.provTypes.length) { wrap.innerHTML = '<div class="rt-note">loading provider types…</div>'; return; }
  const current = state.provType || (state.me && state.me.provider ? state.me.provider.type : null);
  if (!state.provType && state.me && state.me.provider) state.provType = state.me.provider.type;
  wrap.innerHTML = state.provTypes.map((t) => `<button class="prov-type ${state.provType === t.type ? 'sel' : ''}" data-type="${t.type}">
    <b>${esc(t.label)}</b>
    <span class="sub">base ${esc(t.base)} · model e.g. ${esc(t.model)} · server-side web search: ${t.type === 'deepseek' ? 'YES (research is web-grounded)' : 'no (optional Tavily key restores web research)'}</span>
  </button>`).join('');
  wrap.querySelectorAll('.prov-type').forEach((btn) => {
    btn.onclick = () => {
      state.provType = btn.dataset.type;
      const t = state.provTypes.find((x) => x.type === state.provType);
      $('prov-base').value = t.base;
      $('prov-model').value = t.model;
      $('tavily-box').style.display = t.tavily ? 'block' : 'none';
      renderProvTypes();
    };
  });
  if (state.provType) {
    const t = state.provTypes.find((x) => x.type === state.provType);
    if (t && !$('prov-base').value) $('prov-base').value = t.base;
    if (t && !$('prov-model').value) $('prov-model').value = t.model;
    if (t) $('tavily-box').style.display = t.tavily ? 'block' : 'none';
  }
}

async function saveProvider() {
  const type = state.provType;
  if (!type) { toast('Pick a provider type first.', true); return; }
  const body = {
    type,
    base_url: $('prov-base').value.trim(),
    api_key: $('prov-key').value.trim(),
    model: $('prov-model').value.trim(),
    tavily_key: $('prov-tavily').value.trim(),
  };
  const st = $('prov-state');
  st.className = 'tok-state';
  st.textContent = 'probing live: 1-token connectivity + function-calling capability…';
  try {
    const r = await api('/api/setup/provider', { method: 'POST', body: JSON.stringify(body) });
    st.className = 'tok-state ok';
    st.textContent = `Saved (${r.masked}). Probes passed: connectivity + tool-call.`;
    $('prov-key').value = '';
    $('prov-tavily').value = '';
    $('prov-clear').style.display = '';
    renderMatrix($('prov-matrix'), r.matrix);
    await refreshWizard();
    bootMeta();
  } catch (e) {
    st.className = 'tok-state err';
    const env = e.envelope || {};
    st.textContent = `${e.message}${env.next_action ? ` — ${env.next_action}` : ''}`;
    if (env.matrix) renderMatrix($('prov-matrix'), env.matrix);
  }
}

function renderMatrix(el, m) {
  if (!m || !el) { if (el) el.innerHTML = ''; return; }
  const chip = (on, label) => `<span class="caps-chip ${on ? 'on' : 'off'}">${label}</span>`;
  el.innerHTML = `
    <span class="caps-chip ${m.server_search ? 'on' : 'warn'}">${m.server_search ? 'server-side web search: yes' : `web research: ${esc(m.web_research)}`}</span>
    ${chip(m.thinking, m.thinking ? 'thinking trajectory: yes' : 'thinking: no')}
    ${chip(m.function_calling === 'ok', m.function_calling === 'ok' ? 'function-calling: probed OK' : `function-calling: ${esc(m.function_calling)}`)}`;
}

$('prov-save').onclick = saveProvider;
$('prov-clear').onclick = async () => {
  try {
    await api('/api/setup/provider', { method: 'DELETE' });
    state.provType = null;
    $('prov-state').textContent = 'Provider cleared — pick a type and save again.';
    $('prov-clear').style.display = 'none';
    renderProvTypes();
    bootMeta();
  } catch (e) { toast(e.message, true); }
};

async function saveToken(name) {
  const input = $(`in-${name}`);
  const st = $(`st-${name}`);
  const value = input.value.trim();
  if (!value) { st.className = 'tok-state err'; st.textContent = 'Paste the token value first.'; return; }
  st.className = 'tok-state';
  st.textContent = 'validating live…';
  try {
    const r = await api('/api/setup/token', { method: 'POST', body: JSON.stringify({ name, value }) });
    st.className = 'tok-state ok';
    st.textContent = `saved (${r.masked})${r.login ? ` — ${r.login}` : ''} — validated live`;
    input.value = '';
    $(`tok-${name}`).classList.add('ok');
    await refreshWizard();
    bootMeta();
  } catch (e) {
    st.className = 'tok-state err';
    const env = e.envelope || {};
    st.textContent = `${e.message}${env.next_action ? ` — ${env.next_action}` : ''}`;
  }
}
document.querySelectorAll('.save-tok[data-name]').forEach((btn) => {
  btn.onclick = () => saveToken(btn.dataset.name);
});

$('btn-wizard').onclick = openWizard;
$('btn-wizard2').onclick = openWizard;
$('wizard-close').onclick = () => $('modal-wizard').classList.add('hidden');

// ---------- settings modal ----------
$('btn-settings').onclick = async () => {
  try {
    const s = await api('/api/settings');
    const m = s.matrix || {};
    const rows = [
      ['Provider', s.provider ? `${s.provider.type} · ${s.provider.model}` : 'NOT CONFIGURED (guided state)'],
      ['Base URL', s.provider ? s.provider.base_url : '-'],
      ['Server-side web search', m.server_search === true ? 'yes (DeepSeek native)' : `no — web research: ${m.web_research || 'model-knowledge'}`],
      ['Thinking trajectory', m.thinking ? 'captured' : 'not emitted by this provider'],
      ['Function-calling (build loop)', m.function_calling || 'untested'],
      ['Tavily key', m.tavily_set ? 'set (web research parity)' : 'not set'],
      ['Max turns / spend cap / timeout', `${s.caps.max_turns} / $${s.caps.spend_cap_usd} / ${s.caps.build_timeout_min} min`],
      ['Auto-build', s.auto_build ? 'ON (research auto-confirms)' : 'off (confirm card after research)'],
      ['Cost estimate basis', s.price_note],
    ];
    $('settings-rows').innerHTML = rows.map(([k, v]) => `<div class="set-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('');
    $('modal-settings').classList.remove('hidden');
  } catch (e) { toast(e.message, true); }
};
$('settings-close').onclick = () => $('modal-settings').classList.add('hidden');
$('file-close').onclick = () => $('modal-file').classList.add('hidden');

// ---------- auto-build toggle ----------
$('auto-switch').onclick = async () => {
  const next = !(state.me && state.me.auto_build);
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ auto_build: next }) });
    await bootMeta();
    toast(next ? 'Auto-build ON — new builds skip the confirm card' : 'Auto-build off — confirm card returns');
  } catch (e) { toast(e.message, true); }
};

// ---------- header status + guided banner ----------
async function bootMeta() {
  let me;
  try { me = await api('/api/me'); } catch (e) { return; }
  state.me = me;
  const llmChip = $('hdr-llm');
  const m = me.matrix;
  if (m) {
    llmChip.textContent = `${m.provider} · ${m.model} · tools ${m.function_calling === 'ok' ? 'on' : m.function_calling}`;
    llmChip.style.color = m.function_calling === 'ok' ? 'var(--green)' : 'var(--amber)';
  } else {
    llmChip.textContent = 'provider: NOT SET — open the wizard';
    llmChip.style.color = 'var(--amber)';
  }
  for (const [id, name] of [['hdr-rw', 'RAILWAY_TOKEN'], ['hdr-gh', 'GITHUB_TOKEN']]) {
    const t = (me.tokens || []).find((x) => x.name === name);
    const el = $(id);
    el.textContent = t && t.set ? `${name.replace('_TOKEN', '').toLowerCase()}: set` : `${name.replace('_TOKEN', '').toLowerCase()}: missing`;
    el.style.color = t && t.set ? 'var(--green)' : 'var(--amber)';
  }
  const sw = $('auto-switch');
  const tag = $('auto-tag');
  sw.className = `switch ${me.auto_build ? 'on' : ''}`;
  tag.className = `tag ${me.auto_build ? 'on' : 'off'}`;
  tag.textContent = me.auto_build ? 'on' : 'off';

  const banner = $('gate-banner');
  const missing = me.missing || [];
  if (missing.length || !me.provider_configured) {
    const bits = [];
    if (!me.provider_configured) bits.push('<b>Step 1 — LLM provider</b> (open the <b>wizard</b> bolt icon): pick DeepSeek (default, server-side web search), any OpenAI-compatible or Anthropic-compatible provider — base URL + key + model are live-probed (incl. a function-calling probe) before anything saves. <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">DeepSeek keys</a>');
    if (missing.includes('RAILWAY_TOKEN')) bits.push('<b>Step 2 — RAILWAY_TOKEN</b>: <a href="https://railway.com/account/tokens" target="_blank" rel="noopener noreferrer">railway.com/account/tokens</a> → New Token → paste in the wizard (shown once, copies immediately)');
    if (missing.includes('GITHUB_TOKEN')) bits.push('<b>Step 3 — GITHUB_TOKEN</b>: <a href="https://github.com/settings/tokens/new?description=template-builder&scopes=repo" target="_blank" rel="noopener noreferrer">github.com/settings/tokens/new</a> (classic PAT, repo scope pre-checked) → paste in the wizard');
    banner.innerHTML = `<b>Guided setup:</b> ${bits.join(' &nbsp;·&nbsp; ')}`;
    banner.style.display = 'block';
    $('empty-hint').textContent = 'Complete the wizard above — every field is live-validated and stored AES-encrypted on this volume.';
  } else {
    banner.style.display = 'none';
    $('empty-hint').textContent = '';
  }
}

// ---------- boot ----------
$('btn-wizard').onclick = openWizard;
loadBuilds();
bootMeta();
refreshWizard();
state.poll = setInterval(loadBuilds, 6000);
setInterval(bootMeta, 30000);
