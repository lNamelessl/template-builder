// src/llm/deepseek.js — NATIVE DeepSeek adapter (api.deepseek.com).
// Extends the generic OpenAI-compatible protocol with the DeepSeek-specific
// extras (verified live across the deepseek-* builds, STATUS rows 43/47/55):
//  - server-side `deepseek_web_search` tool (research = real web results:
//    search, open_page, find_in_page) + citations via delta.annotations[]
//    (.url_citation) AND delta.server_tool_calls[].calls[].sources[] (quirk 46a:
//    citations do NOT ride message.annotations while streaming), merged by URL;
//  - `thinking` param (reasoning deltas ride delta.reasoning_content, quirk 50e);
//  - authoritative server-tool counters in usage.server_tool_use (quirk 50d);
//  - cost estimate from measured DeepSeek prices.
// Build phase: standard client function-calling (tools/tool_calls) through the
// same normalized event stream — the researcher and builder stay adapter-blind.
'use strict';
const openaiCompat = require('./openai-compat');
const core = require('./core');

const TYPE = 'deepseek';

function capabilities(cfg) {
  return {
    type: TYPE,
    label: `DeepSeek native (${cfg.model || 'deepseek-flash'})`,
    serverSearch: true, // the ONLY provider with server-side web search
    reasoningStream: true,
    functionCalling: (cfg.caps && cfg.caps.functionCalling) || 'untested', // probed at save-time
    webResearch: 'server-side',
  };
}

// ---------- one streaming chat call ----------
async function chat(cfg, opts) {
  const key = cfg.apiKey;
  if (!key) throw new core.NotConfiguredError('DeepSeek API key');
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const label = 'DeepSeek';

  const payload = {
    model: cfg.model,
    messages: openaiCompat.toProviderMessages(opts.messages),
    stream: true,
    max_tokens: opts.maxTokens || 8000,
    thinking: { type: opts.thinking || 'enabled' },
  };
  if (opts.serverSearch !== false) payload.tools = [{ type: 'deepseek_web_search' }];
  const fnTools = openaiCompat.toProviderTools(opts.tools);
  if (fnTools) payload.tools = [...(payload.tools || []), ...fnTools];
  if (opts.temperature !== undefined) payload.temperature = opts.temperature;

  const parts = [];
  const reasoningChunks = [];
  const fnCalls = new Map(); // index -> {id, name, arguments}
  const annotations = [];
  const stcRecords = [];
  const queries = [];
  const seenCallIds = new Set();
  let usage = null;
  let finishReason = null;
  let refusalText = null;
  let sawBodyError = null;
  const emit = (type, data = {}) => { if (opts.onEvent) try { opts.onEvent(type, data); } catch (e) { /* */ } };

  await core.streamWithRetries({
    providerLabel: label,
    onEvent: opts.onEvent,
    maxRetries: opts.maxRetries,
    doFetch: () => fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs || 900000),
    }),
    consume: async (res) => {
      for await (const data of core.sseData(res)) {
        if (data === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(data); } catch (e) { continue; }
        if (chunk.error) { sawBodyError = JSON.stringify(chunk.error).slice(0, 300); break; }
        const choice = (chunk.choices || [{}])[0] || {};
        const delta = choice.delta || {};
        if (delta.content) {
          parts.push(delta.content);
          emit('text-delta', { text: delta.content });
        }
        if (delta.reasoning_content) {
          reasoningChunks.push(delta.reasoning_content);
          emit('reasoning-delta', { text: delta.reasoning_content });
        }
        if (delta.refusal) refusalText = delta.refusal;
        if (delta.annotations) {
          if (Array.isArray(delta.annotations)) annotations.push(...delta.annotations);
          else annotations.push(delta.annotations);
        }
        if (delta.server_tool_calls) {
          const stc = Array.isArray(delta.server_tool_calls) ? delta.server_tool_calls : [delta.server_tool_calls];
          stcRecords.push(...stc);
          let newCalls = 0;
          for (const block of stc) {
            for (const call of (block.calls || [])) {
              if (!call || typeof call !== 'object') continue;
              if (call.id) {
                if (seenCallIds.has(call.id)) continue;
                seenCallIds.add(call.id);
              }
              newCalls++;
              const inp = (call.input && typeof call.input === 'object') ? call.input : {};
              const q = inp.queries || call.queries;
              if (Array.isArray(q)) queries.push(...q.slice(0, 2).map(String));
            }
          }
          if (newCalls) emit('server-tool', { count: seenCallIds.size || undefined, queries: queries.slice(-2) });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number.isFinite(tc.index) ? tc.index : 0;
            const slot = fnCalls.get(idx) || { id: null, name: '', arguments: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function && tc.function.name) slot.name = tc.function.name;
            if (tc.function && tc.function.arguments) slot.arguments += tc.function.arguments;
            fnCalls.set(idx, slot);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
    },
  });

  if (sawBodyError) throw new core.UpstreamError(`Upstream reported an error mid-stream: ${sawBodyError}`, false);
  core.throwIfNeverStreamed({}, Boolean(parts.length || reasoningChunks.length || fnCalls.size || annotations.length), label);

  const toolCalls = [...fnCalls.values()].filter((c) => c.name);
  for (const tc of toolCalls) emit('tool-call', { id: tc.id, name: tc.name });
  const serverToolCalls = seenCallIds.size || stcRecords.reduce((n, b) => n + ((b.calls || []).length), 0);
  const usageNorm = core.usageOut(usage, serverToolCalls);
  emit('usage', usageNorm);
  const citations = core.mergeCitations(core.citationsFromAnnotations(annotations), core.citationsFromToolCalls(stcRecords));
  if (citations.length) emit('citations', { citations });

  return {
    content: parts.join(''),
    reasoning: reasoningChunks.join(''),
    toolCalls,
    citations,
    usage: usageNorm,
    rawUsage: usage || null,
    finishReason: finishReason || (toolCalls.length ? 'tool_calls' : null),
    refusalText,
    // deepseek-only extras for the research trajectory
    server_tool_calls: serverToolCalls,
    queries: queries.slice(0, 20),
  };
}

// ---------- non-streaming single-shot (probes + JSON repair) ----------
async function complete(cfg, { messages, tools, maxTokens = 4000, thinking = 'disabled', temperature, timeoutMs = 120000 }) {
  const key = cfg.apiKey;
  if (!key) throw new core.NotConfiguredError('DeepSeek API key');
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const payload = {
    model: cfg.model,
    messages: openaiCompat.toProviderMessages(messages),
    stream: false,
    max_tokens: maxTokens,
    thinking: { type: thinking },
  };
  const fnTools = openaiCompat.toProviderTools(tools);
  if (fnTools) { payload.tools = fnTools; payload.tool_choice = 'auto'; }
  if (temperature !== undefined) payload.temperature = temperature;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    throw new core.UpstreamError(core.upstreamErrorText(res.status, text, 'DeepSeek'));
  }
  const data = await res.json();
  const msg = (data.choices || [{}])[0]?.message || {};
  return {
    content: msg.content || '',
    reasoning: msg.reasoning_content || '',
    toolCalls: (msg.tool_calls || []).map((c, i) => ({
      id: c.id || `call_${i}`, name: c.function?.name || '', arguments: c.function?.arguments || '{}',
    })),
    usage: core.usageOut(data.usage, 0),
    rawUsage: data.usage || null,
    finishReason: (data.choices || [{}])[0]?.finish_reason || null,
  };
}

module.exports = { TYPE, capabilities, chat, complete };
