// src/llm/openai-compat.js — GENERIC OpenAI-compatible adapter.
// Covers OpenAI, OpenRouter, Groq, Together, Ollama, vLLM, any /chat/completions
// server. Client function-calling via standard tools/tool_calls (accumulated by
// index from streaming deltas); reasoning captured when the provider emits
// `reasoning_content`; usage from the final chunk. Normalizes to the shared
// event stream + result shape (see core.js). The deepseek adapter extends this.
'use strict';
const core = require('./core');
const { NotConfiguredError, UpstreamError, RiskError } = core;

const TYPE = 'openai-compat';

// ---------- message mapping (canonical -> OpenAI) ----------
// canonical: {role, content, tool_calls?[{id,name,arguments(str)}], tool_call_id?}
function toProviderMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content ?? '') };
    return { role: m.role, content: m.content };
  });
}

// ---------- tool mapping (canonical -> OpenAI) ----------
// canonical tools: {name, description, parameters(JSON schema)}
function toProviderTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
  }));
}

function capabilities(cfg) {
  return {
    type: TYPE,
    label: `OpenAI-compatible (${cfg.model || 'model'})`,
    reasoningStream: true, // captured when the provider emits reasoning_content
    functionCalling: (cfg.caps && cfg.caps.functionCalling) || 'untested', // probed at save-time
  };
}

// ---------- one streaming chat call ----------
// opts: {messages, tools, maxTokens, temperature?, onEvent, timeoutMs, maxRetries}
async function chat(cfg, opts) {
  const key = cfg.apiKey;
  if (!key) throw new NotConfiguredError(`${cfg.label || TYPE} API key`);
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new UpstreamError('No base URL configured for the LLM provider.');
  const label = cfg.label || TYPE;

  const payload = {
    model: cfg.model,
    messages: toProviderMessages(opts.messages),
    stream: true,
    max_tokens: opts.maxTokens || 8000,
  };
  const tools = toProviderTools(opts.tools);
  if (tools) { payload.tools = tools; payload.tool_choice = 'auto'; }
  if (opts.temperature !== undefined) payload.temperature = opts.temperature;

  const parts = [];
  const reasoningChunks = [];
  const fnCalls = new Map(); // index -> {id, name, arguments}
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

  if (sawBodyError) throw new UpstreamError(`Upstream reported an error mid-stream: ${sawBodyError}`, false);
  core.throwIfNeverStreamed({}, Boolean(parts.length || reasoningChunks.length || fnCalls.size), label);

  const toolCalls = [...fnCalls.values()].filter((c) => c.name);
  for (const tc of toolCalls) emit('tool-call', { id: tc.id, name: tc.name });
  const usageNorm = core.usageOut(usage, 0);
  emit('usage', usageNorm);

  return {
    content: parts.join(''),
    reasoning: reasoningChunks.join(''),
    toolCalls,
    citations: [],
    usage: usageNorm,
    rawUsage: usage || null,
    finishReason: finishReason || (toolCalls.length ? 'tool_calls' : null),
    refusalText,
  };
}

// ---------- non-streaming single-shot (probes + JSON repair) ----------
async function complete(cfg, { messages, tools, maxTokens = 4000, temperature, timeoutMs = 120000 }) {
  const key = cfg.apiKey;
  if (!key) throw new NotConfiguredError(`${cfg.label || TYPE} API key`);
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  const payload = {
    model: cfg.model,
    messages: toProviderMessages(messages),
    stream: false,
    max_tokens: maxTokens,
  };
  const t = toProviderTools(tools);
  if (t) { payload.tools = t; payload.tool_choice = 'auto'; }
  if (temperature !== undefined) payload.temperature = temperature;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new UpstreamError(core.upstreamErrorText(401, text, cfg.label), false);
    throw new UpstreamError(core.upstreamErrorText(res.status, text, cfg.label));
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

module.exports = { TYPE, capabilities, chat, complete, toProviderMessages, toProviderTools };
