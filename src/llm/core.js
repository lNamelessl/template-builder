// src/llm/core.js — shared provider-adapter mechanics.
// Typed errors, SSE retry loop, citation merge, usage normalization, strict-JSON
// extraction — refactored from template-harness src/researcher.js @ 4251ab5
// (532-line DeepSeek client) into provider-neutral helpers used by ALL adapters
// in src/llm/. Every adapter normalizes to ONE event stream:
//   text-delta | reasoning-delta | tool-call | usage | citations | retrying
// and ONE result shape: { content, reasoning, toolCalls, citations, usage,
// finishReason, refusalText }.
'use strict';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const REASONING_CAP = 80000; // chars of trajectory reasoning persisted (head+tail)

// ---------- typed failures (each maps to ONE envelope shape in routes) ----------
class NotConfiguredError extends Error {
  constructor(missing) {
    const m = missing || 'the LLM API key';
    super(`${m} is not set on this deployment.`);
    this.code = 'not_configured';
    this.http = 503;
    this.missing = m;
    this.nextAction = 'Open the setup wizard and paste your token (it is validated live and stored AES-encrypted).';
  }
}
class BusyError extends Error {
  constructor(active) {
    super(`A build is already running (concurrency ${active}).`);
    this.code = 'busy';
    this.http = 429;
    this.nextAction = 'Wait for the current build to finish; the queue drains one build at a time.';
  }
}
class RiskError extends Error {
  constructor(msg) {
    super(msg || 'The request was rejected before generation (HTTP 400).');
    this.code = 'risk_rejected';
    this.http = 422;
    this.nextAction = 'The idea text may have tripped a provider-side filter. Re-submit after editing the idea text.';
  }
}
class UpstreamError extends Error {
  constructor(msg, retryable = false) {
    super(msg);
    this.code = 'upstream_error';
    this.http = 502;
    this.retryable = retryable;
    this.nextAction = 'Transient upstream failures retry automatically. If this persists, check your provider status page and the deploy logs.';
  }
}
class CapabilityError extends Error {
  constructor(msg) {
    super(msg);
    this.code = 'capability_missing';
    this.http = 400;
    this.nextAction = 'This provider cannot tool-call — the build loop requires it. Choose a function-calling-capable model/provider in the setup wizard.';
  }
}

function upstreamErrorText(status, body, providerLabel) {
  let msg = '';
  try {
    const data = JSON.parse(body || '{}');
    const err = data && data.error;
    if (typeof err === 'string') msg = err;
    else if (err && typeof err === 'object') msg = err.message || '';
    else if (data && typeof data.message === 'string') msg = data.message;
    else if (data && typeof data.error_message === 'string') msg = data.error_message;
  } catch (e) { /* raw */ }
  if (status === 401 && !msg) msg = `Upstream rejected the configured LLM API key — re-paste it in the setup wizard.`;
  return `${providerLabel || 'Upstream'} error (HTTP ${status}): ${msg || (body || '').slice(0, 200)}`;
}

// ---------- SSE body reader: yields `data:` payload strings ----------
async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      yield data;
    }
  }
}

// ---------- retry wrapper for a streaming POST ----------
// doFetch(attempt) must return a Response (already awaited). Streams 200s via
// consume(res). Retries retryable statuses + network errors with backoff.
async function streamWithRetries({ doFetch, consume, onEvent, maxRetries = MAX_RETRIES, providerLabel }) {
  const emit = (type, data = {}) => { if (onEvent) try { onEvent(type, data); } catch (e) { /* */ } };
  let lastStatus = null;
  let lastNetworkError = null;
  let lastBodyText = null;
  let streamed = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (attempt - 1), 8000)));
    let res;
    try {
      res = await doFetch();
    } catch (e) {
      lastNetworkError = `Upstream connection failed: ${e.name || e.code || 'Error'}`;
      if (attempt < maxRetries) { emit('retrying', { note: lastNetworkError }); continue; }
      throw new UpstreamError(lastNetworkError, true);
    }
    lastStatus = res.status;
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      if (Number.isFinite(ra)) await new Promise((r) => setTimeout(r, Math.min(ra * 1000, 30000)));
      emit('retrying', { note: `upstream HTTP ${res.status}` });
      continue;
    }
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      lastBodyText = text.slice(0, 300);
      throw new RiskError(`${providerLabel || 'Provider'} rejected the request (HTTP 400): ${lastBodyText}`);
    }
    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      throw new UpstreamError(upstreamErrorText(res.status, text, providerLabel), RETRYABLE_STATUS.has(res.status));
    }
    await consume(res); // may throw UpstreamError on mid-stream body errors
    streamed = true;
    lastBodyText = null;
    break;
  }
  return { lastStatus, lastNetworkError, lastBodyText, streamed };
}

function throwIfNeverStreamed({ lastStatus, lastNetworkError, lastBodyText }, gotAnyContent, providerLabel) {
  if (lastStatus !== 200 && !gotAnyContent) {
    if (lastNetworkError && lastStatus === null) throw new UpstreamError(lastNetworkError, true);
    throw new UpstreamError(`${providerLabel || 'Upstream'} HTTP ${lastStatus}${lastBodyText ? `: ${lastBodyText}` : ''}`, RETRYABLE_STATUS.has(lastStatus));
  }
}

// ---------- citations (annotations win, merged by URL) — DeepSeek shapes ----------
function citationsFromAnnotations(annotations) {
  const out = [];
  const seen = new Set();
  for (const ann of annotations || []) {
    if (!ann || typeof ann !== 'object') continue;
    const uc = ann.url_citation || ann.web_search_result_location || null;
    if (!uc || typeof uc !== 'object') continue;
    const url = uc.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: uc.title || url, url });
  }
  return out;
}
function citationsFromToolCalls(records) {
  // Streaming shape: sources ride in delta.server_tool_calls[].calls[].sources[]
  // as {type:'url', url, title, snippet}.
  const out = [];
  const seen = new Set();
  for (const stc of records || []) {
    if (!stc || typeof stc !== 'object') continue;
    for (const call of (stc.calls || [])) {
      if (!call || typeof call !== 'object') continue;
      for (const src of (call.sources || [])) {
        if (!src || typeof src !== 'object' || src.type !== 'url') continue;
        const url = src.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const item = { title: src.title || url, url };
        if (src.snippet) item.cited_text = src.snippet;
        out.push(item);
      }
    }
  }
  return out;
}
function mergeCitations(primary, fallback) {
  const out = [...primary];
  const seen = new Set(primary.map((c) => c.url));
  for (const c of fallback || []) {
    if (c && c.url && !seen.has(c.url)) { out.push(c); seen.add(c.url); }
  }
  return out.filter((c) => typeof c.url === 'string' && /^https?:\/\//.test(c.url));
}

// ---------- usage + cost ----------
function usageOut(usage, toolCalls) {
  const u = usage || {};
  const stu = u.server_tool_use || {};
  const out = {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? null,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? null,
    search_calls: stu.tool_search || 0,
    fetch_calls: stu.tool_fetch || 0,
    image_search_calls: stu.tool_image_search || 0,
    tool_calls: toolCalls || 0,
  };
  if (!(out.search_calls || out.fetch_calls || out.image_search_calls)) {
    out.search_calls = out.tool_calls; // best-effort fallback when counters absent
  }
  return out;
}
function estimateCost(usage, prices) {
  if (!prices || !usage) return null; // non-DeepSeek providers: cost unknown, tokens tracked instead
  const p = prices;
  const uses = (usage.search_calls || 0) + (usage.fetch_calls || 0) + (usage.image_search_calls || 0);
  return (uses / 1000.0) * p.priceSearchPer1k
    + ((usage.input_tokens || 0) / 1e6) * p.priceInPerM
    + ((usage.output_tokens || 0) / 1e6) * p.priceOutPerM;
}

// ---------- strict JSON extraction (fenced block + first { to last }) ----------
function extractJson(content) {
  if (!content) return null;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch (e) { return null; }
}
function capReasoning(reasoning) {
  const r = String(reasoning || '');
  if (r.length <= REASONING_CAP) return r;
  const head = r.slice(0, REASONING_CAP / 2);
  const tail = r.slice(-REASONING_CAP / 2);
  return `${head}\n...[trajectory truncated, ${r.length - REASONING_CAP} chars elided]...\n${tail}`;
}

module.exports = {
  RETRYABLE_STATUS, MAX_RETRIES, REASONING_CAP,
  NotConfiguredError, BusyError, RiskError, UpstreamError, CapabilityError,
  upstreamErrorText, sseData, streamWithRetries, throwIfNeverStreamed,
  citationsFromAnnotations, citationsFromToolCalls, mergeCitations,
  usageOut, estimateCost, extractJson, capReasoning,
};
