// src/researcher.js — Phase 1 research agent (ADAPTER-BLIND).
// Ported from template-harness src/researcher.js @ 4251ab5 and refactored onto
// the src/llm/ provider layer: the SAME normalized event stream drives research
// regardless of provider. Research depth varies honestly per capability matrix:
//  - deepseek native   = ONE streaming call with server-side `deepseek_web_search`
//                        + thinking (real web results, citations, reasoning);
//  - openai-compat /   = model knowledge + OPTIONAL Tavily key (web parity:
//    anthropic-compat    tavily.js results injected into the prompt + become
//                        citations) + the provider-independent LIVE marketplace
//                        scan (marketscan.js) which is real for every provider.
// After the report JSON lands, the LIVE marketplace uniqueness scan runs and
// both land on the build row before the confirm card.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const llm = require('./llm');
const marketscan = require('./marketscan');
const tavily = require('./tavily');
const { emit } = require('./bus');
const { buildStmts, now } = require('./db');
const { pushTelegram } = require('./telegram');

const DEEPSEEK_PRICES = {
  priceSearchPer1k: config.priceSearchPer1k,
  priceInPerM: config.priceInPerM,
  priceOutPerM: config.priceOutPerM,
};

// ---------- research prompt ----------
function buildResearchPrompt(ideaText, { serverSearch, tavilyContext, providerLabel }) {
  const tooling = serverSearch
    ? 'using web search (this call runs server-side web search: search, open pages, read URLs)'
    : tavilyContext
      ? 'using the Tavily web-research results injected below (your only web access this call)'
      : 'from your model knowledge (no web access is configured for this provider — the LIVE marketplace scan below is provider-independent real data)';
  const tavBlock = tavilyContext
    ? `\nTAVILY WEB-RESEARCH RESULTS (live, fetched just now):\n${JSON.stringify(tavilyContext).slice(0, 8000)}\n`
    : '';
  return `You are a Railway-template research agent for Template Builder: the user described an app idea and wants it built, deployed and PUBLISHED as a one-click Railway template. Research the idea below ${tooling} and produce a build-potential report as ONE strict JSON object.

User idea:
${String(ideaText).slice(0, 4000)}
${tavBlock}
Context: we will produce a working repo + Railway deployment + a published marketplace template for this idea. A "build now" verdict = real demand AND feasible as a single-container (or small multi-service) Railway deployment AND legally deployable AND not already saturated on the marketplace.

Steps to perform:
1. Identify WHAT the user is describing (named product? generic app class? a URL they pasted = research that URL's product). Quantify demand (GitHub stars, downloads, search interest, community size) as far as your sources allow; say so when a number is an estimate.
2. Existing solutions: what self-hostable/open-source software already implements it, and what Railway marketplace templates already cover it (railway.com/deploy). Note the closest template names and rough deploy counts if visible.
3. Feasibility: pick the concrete implementation path — best upstream image or source build, Dockerfile quality, volume paths, ports, env vars, healthcheck endpoint, single-service vs multi-service. Prefer official/distro images with digest pins. Effort S/M/L.
4. ToS/legal flags: license issues, trademark limits, terms-of-service constraints for one-click hosting (e.g. game servers vs EULA, media servers, geo/DMCA risks, API-embedding rules).
5. Naming: suggest a short template listing name (<= 30 chars) + marketplace slug (<= 40 chars, lowercase hyphenated, no em-dashes) that would claim a clean slug.

Output STRICTLY this JSON object and NOTHING ELSE. Wrap it in a single \`\`\`json fenced block. All 10 keys required; keep string values under 120 words each; rating is an integer 1-5 (5 = build now):

\`\`\`json
{
  "verdict": "BUILD NOW | BUILD SOON | WATCH | SKIP — one sentence why",
  "rating": 1,
  "demand": "measured demand summary with numbers",
  "coverage_check": "is it already on the Railway marketplace? which templates, how many deploys?",
  "competitor_scan": "closest alternatives and the win/lose case for a fresh template",
  "uniqueness": "what a fresh template adds; uniqueness rating in words",
  "tos_legal_flags": "license + ToS + legal flags or 'none found'",
  "implementation_sketch": "image, volumes, ports, env, healthcheck, effort S/M/L",
  "suggested_name_slug": "Template listing name (<= 30 chars) + slug (<= 40 chars, hyphenated)",
  "risks": "top risks of building/publishing this",
  "confidence": "HIGH|MEDIUM|LOW + one sentence"
}
\`\`\`

Remember: ONLY the fenced JSON block in your final answer.${serverSearch ? ' Use the web search tool extensively before answering.' : ''} (research provider: ${providerLabel})`;
}

// ---------- artifacts ----------
function artifactDir(buildId) { return path.join(config.dataDir, 'artifacts', String(buildId)); }
function writeArtifact(buildId, name, content) {
  const dir = artifactDir(buildId);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return { name, path: `/api/builds/${buildId}/artifacts/${encodeURIComponent(name)}`, bytes: Buffer.byteLength(content), created_at: now() };
}

// ---------- main research pipeline ----------
async function runResearch(buildId, ideaText) {
  const client = llm.resolve();
  if (!client || !client.cfg.apiKey) throw new llm.core.NotConfiguredError('LLM provider key');

  buildStmts.setStatus.run('RESEARCHING', now(), buildId);
  emit(buildId, 'phase', { phase: 'thinking', status: 'RESEARCHING' });

  // normalized events -> build SSE (adapter-blind)
  const onEvent = (type, data) => {
    if (type === 'text-delta') emit(buildId, 'text', { chars: undefined });
    else if (type === 'reasoning-delta') emit(buildId, 'reasoning', data);
    else if (type === 'server-tool') emit(buildId, 'tools', data);
    else if (type === 'retrying') emit(buildId, 'phase', { phase: 'retrying', note: data.note });
    // text-delta char counting handled via closure below
  };
  let contentChars = 0;
  const onEventFull = (type, data) => {
    if (type === 'text-delta') { contentChars += (data.text || '').length; emit(buildId, 'text', { chars: contentChars }); }
    else onEvent(type, data);
  };

  try {
    const caps = client.caps;
    const serverSearch = caps.serverSearch === true;

    // web-research parity for non-DeepSeek: optional Tavily context
    let tavilyContext = null;
    let tavilyError = null;
    if (!serverSearch && client.cfg.tavilyKey) {
      emit(buildId, 'phase', { phase: 'tavily', note: 'fetching web research (Tavily)' });
      try {
        const kw = marketscan.keywordsFromIdea(ideaText, 5);
        const r = await tavily.researchContext(client.cfg.tavilyKey, ideaText, kw.length ? kw : [String(ideaText).slice(0, 40)]);
        if (r.used) tavilyContext = r.results;
        if (r.errors.length) tavilyError = r.errors.join(' | ');
        emit(buildId, 'phase', { phase: 'tavily_done', note: `${r.results.length} web results` });
      } catch (e) {
        tavilyError = String(e.message || e).slice(0, 200);
        emit(buildId, 'phase', { phase: 'tavily_error', note: tavilyError });
      }
    }

    emit(buildId, 'phase', { phase: 'searching', note: serverSearch ? 'server-side deep search streaming' : `${client.cfg.type} streaming (research depth: ${caps.webResearch})` });

    // DEGENERATE-EARLY-STOP RETRY (measured live 2026-11-22): with thinking +
    // server-side search enabled, the provider occasionally ends the stream
    // after ~20-200 completion tokens (finish=stop, zero server tool calls,
    // thinking never engaged). Same payload re-issued works. Detect: no JSON
    // AND no server tool activity AND tiny content -> re-issue the whole call
    // (max 3 attempts) before falling to the prose-repair path.
    const hasReportKeys = (o) => o && typeof o === 'object' && (o.verdict || o.implementation_sketch) && (o.demand || o.coverage_check);
    let r = null;
    let report = null;
    let repairUsed = false;
    let attempts = 0;
    for (;;) {
      attempts++;
      r = await client.chat({
        messages: [{ role: 'user', content: buildResearchPrompt(ideaText, { serverSearch, tavilyContext, providerLabel: `${client.cfg.type}/${client.cfg.model}` }) }],
        maxTokens: config.maxTokens,
        onEvent: onEventFull,
      });
      if (r.finishReason === 'content_filter' || r.refusalText) {
        throw new llm.core.RiskError(r.refusalText || 'The request was declined by the provider safety review.');
      }
      emit(buildId, 'phase', { phase: 'parsing', note: 'extracting report JSON' });
      report = llm.core.extractJson(r.content);
      if (hasReportKeys(report)) break;
      const degenerate = (r.usage.tool_calls || 0) === 0
        && (r.server_tool_calls || 0) === 0
        && String(r.content || '').length < 400
        && attempts < 3;
      if (degenerate) {
        emit(buildId, 'phase', { phase: 'retrying', note: `degenerate upstream response (attempt ${attempts}: ${String(r.content || '').length} chars, no tool activity) — re-issuing the research call` });
        continue;
      }
      if (!report && r.content) {
        try {
          const msg = await client.complete({
            messages: [{
              role: 'user',
              content: `The text below was supposed to be ONE strict JSON object for a template-research report but had extra prose or was missing keys. Return ONLY the corrected JSON object with ALL required keys (verdict, rating, demand, coverage_check, competitor_scan, uniqueness, tos_legal_flags, implementation_sketch, suggested_name_slug, risks, confidence) — no prose, no fences, no explanation.\n\nText:\n${r.content.slice(0, 12000)}`,
            }],
            maxTokens: 6000,
          });
          const repaired = llm.core.extractJson(msg.content || '');
          if (hasReportKeys(repaired)) { report = repaired; repairUsed = true; }
        } catch (e) { /* repair failed -> graceful failure below */ }
      }
      break;
    }
    if (!hasReportKeys(report)) {
      const artifacts = [writeArtifact(buildId, 'raw-output.txt', r.content || '(empty response)')];
      const err = `Report JSON could not be parsed after ${attempts} attempt(s)${repairUsed ? ' + repair' : ''} — raw model output kept as artifact raw-output.txt. Upstream finish=${r.finishReason}, server tool calls=${r.server_tool_calls || 0}, content chars=${String(r.content || '').length}.`;
      buildStmts.saveFailure.run(err, now(), now(), buildId);
      buildStmts.saveArtifacts.run(JSON.stringify(artifacts), buildId);
      emit(buildId, 'failed', { error: err });
      return;
    }

    // LIVE marketplace uniqueness scan (unauth, real rows w/ deploy counts — provider-independent)
    emit(buildId, 'phase', { phase: 'marketscan', note: 'scanning the live Railway marketplace' });
    let uniqueness = null;
    let scanError = null;
    try {
      uniqueness = await marketscan.scan(ideaText, { limit: config.marketscanLimit });
      emit(buildId, 'phase', { phase: 'marketscan_done', note: `${uniqueness.found} matching templates for "${uniqueness.query_used}"` });
    } catch (e) {
      scanError = String(e.message || e).slice(0, 300);
      emit(buildId, 'phase', { phase: 'marketscan_error', note: scanError });
    }

    const ratingRaw = parseInt(report.rating, 10);
    const rating = Number.isFinite(ratingRaw) ? Math.min(5, Math.max(1, ratingRaw)) : null;
    // citations: DeepSeek server citations; Tavily results as citations for compat providers
    const citations = (r.citations && r.citations.length)
      ? r.citations
      : (tavilyContext || []).map((t) => ({ title: t.title, url: t.url }));
    const usage = r.usage;
    const cost = client.cfg.type === 'deepseek' ? llm.core.estimateCost(usage, DEEPSEEK_PRICES) : null;
    const trajectory = {
      provider: client.cfg.type,
      model: client.cfg.model,
      web_research: caps.webResearch,
      reasoning: llm.core.capReasoning(r.reasoning),
      tool_calls: r.usage.tool_calls || 0,
      server_tool_calls: r.server_tool_calls || 0,
      queries: r.queries || [],
      finish_reason: r.finishReason,
      repair_used: repairUsed,
      tavily_error: tavilyError,
      scan_error: scanError,
    };

    const artifacts = [writeArtifact(buildId, 'research.md', reportToMarkdown(ideaText, report, uniqueness, citations, usage, cost, trajectory))];
    buildStmts.saveResearch.run(
      JSON.stringify({ ...report, rating }), JSON.stringify(uniqueness), JSON.stringify(citations),
      JSON.stringify(trajectory), now(), now(), buildId,
    );
    buildStmts.saveArtifacts.run(JSON.stringify(artifacts), buildId);
    buildStmts.saveCost.run(cost, usage.input_tokens, usage.output_tokens, now(), buildId);
    buildStmts.appendError.run(null, buildId);
    const nextStatus = 'AWAITING_CONFIRM';
    buildStmts.setStatus.run(nextStatus, now(), buildId);
    emit(buildId, 'done', {
      status: nextStatus, rating, cost_usd: cost,
      input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
      citations: citations.length, tool_calls: trajectory.tool_calls,
      competitors: uniqueness ? uniqueness.found : null,
    });
    pushTelegram(`research READY — build #${buildId}\nverdict: ${report.verdict || '(none)'} | rating: ${'★'.repeat(rating || 0)} | competitors: ${uniqueness ? uniqueness.found : '?'} | provider: ${client.cfg.type}`).catch(() => {});
  } catch (err) {
    const typed = err instanceof llm.core.NotConfiguredError || err instanceof llm.core.BusyError
      || err instanceof llm.core.RiskError || err instanceof llm.core.UpstreamError;
    const errText = String(err.message || err).slice(0, 500);
    buildStmts.saveFailure.run(errText, now(), now(), buildId);
    emit(buildId, 'failed', { error: errText, code: typed ? err.code : 'internal_error' });
    pushTelegram(`research FAILED — build #${buildId}\n${errText.slice(0, 200)}`).catch(() => {});
    if (!typed) throw err;
  }
}

function reportToMarkdown(ideaText, report, uniqueness, citations, usage, cost, trajectory) {
  const L = [];
  L.push(`# Research report — ${String(ideaText).slice(0, 80)}`);
  L.push('');
  L.push(`*provider ${trajectory.provider}/${trajectory.model} · web research: ${trajectory.web_research} · cost ${cost != null ? `$${cost.toFixed(4)}` : 'n/a (non-DeepSeek provider — tokens tracked)'} · tool calls ${trajectory.tool_calls} · ${new Date().toISOString()}*`);
  L.push('');
  for (const [k, label] of [
    ['verdict', 'Verdict'], ['rating', 'Rating'], ['demand', 'Demand'],
    ['coverage_check', 'Coverage check'], ['competitor_scan', 'Competitor scan'],
    ['uniqueness', 'Uniqueness'], ['tos_legal_flags', 'ToS / legal flags'],
    ['implementation_sketch', 'Implementation sketch'], ['suggested_name_slug', 'Suggested name / slug'],
    ['risks', 'Risks'], ['confidence', 'Confidence'],
  ]) {
    if (report[k] === undefined) continue;
    L.push(`## ${label}`);
    L.push(k === 'rating' ? `${'★'.repeat(Number(report.rating) || 0)} (${report.rating}/5)` : String(report[k]));
    L.push('');
  }
  if (uniqueness) {
    L.push(`## Marketplace uniqueness scan (LIVE, query "${uniqueness.query_used}" — ${uniqueness.found} matches)`);
    L.push('');
    L.push('| Template | Creator | Deploys | Health |');
    L.push('|---|---|---|---|');
    for (const c of uniqueness.competitors) {
      L.push(`| ${c.name} (\`${c.code}\`) | ${c.creator || '?'} | ${c.deploys ?? '?'} | ${c.health ?? '?'} |`);
    }
    L.push('');
  }
  if (citations.length) {
    L.push('## Sources');
    for (const c of citations) L.push(`- [${c.title}](${c.url})`);
  }
  return L.join('\n');
}

module.exports = { runResearch, buildResearchPrompt, artifactDir, writeArtifact, DEEPSEEK_PRICES };
