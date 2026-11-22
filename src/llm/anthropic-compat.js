// src/llm/anthropic-compat.js — Anthropic-compatible adapter (/v1/messages).
// Covers Anthropic and any /v1/messages-shaped server. Wire shape: system as a
// top-level param, assistant tool calls as `tool_use` content blocks, tool
// results as `tool_result` blocks inside the NEXT user message, tools as
// {name, description, input_schema}. SSE events: message_start ->
// content_block_start/delta/stop (text_delta | thinking_delta | input_json_delta)
// -> message_delta (stop_reason, usage) -> message_stop. Thinking models emit
// `thinking_delta` — normalized as reasoning-delta. Normalizes to the shared
// event stream + result shape (see core.js).
'use strict';
const core = require('./core');
const { NotConfiguredError, UpstreamError } = core;

const TYPE = 'anthropic-compat';

// ---------- message mapping (canonical -> Anthropic blocks) ----------
function toProviderMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // hoisted to the top-level system param
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const c of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(c.arguments || '{}'); } catch (e) { input = { _raw: c.arguments }; }
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'tool') {
      // tool results ride in a USER message as tool_result blocks; consecutive
      // tool results are merged into one user message below
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content ?? ''),
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content[0] && prev.content[0].type === 'tool_result') {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    out.push({ role: m.role === 'system' ? 'user' : m.role, content: String(m.content ?? '') });
  }
  return out;
}

// ---------- tool mapping (canonical -> Anthropic) ----------
function toProviderTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));
}

function capabilities(cfg) {
  return {
    type: TYPE,
    label: `Anthropic-compatible (${cfg.model || 'model'})`,
    reasoningStream: true, // thinking_delta blocks when the model thinks
    functionCalling: (cfg.caps && cfg.caps.functionCalling) || 'untested', // probed at save-time
  };
}

// ---------- one streaming chat call ----------
async function chat(cfg, opts) {
  const key = cfg.apiKey;
  if (!key) throw new NotConfiguredError(`${cfg.label || TYPE} API key`);
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const label = cfg.label || 'Anthropic-compatible';

  const systemParts = opts.messages.filter((m) => m.role === 'system').map((m) => String(m.content || ''));
  const payload = {
    model: cfg.model,
    max_tokens: opts.maxTokens || 8000,
    stream: true,
    messages: toProviderMessages(opts.messages),
  };
  if (systemParts.length) payload.system = systemParts.join('\n\n');
  const tools = toProviderTools(opts.tools);
  if (tools) payload.tools = tools;

  const parts = [];
  const reasoningChunks = [];
  const blocks = new Map(); // index -> {type, id, name, json}
  let usage = null;
  let stopReason = null;
  let sawBodyError = null;
  const emit = (type, data = {}) => { if (opts.onEvent) try { opts.onEvent(type, data); } catch (e) { /* */ } };

  await core.streamWithRetries({
    providerLabel: label,
    onEvent: opts.onEvent,
    maxRetries: opts.maxRetries,
    doFetch: () => fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        Authorization: `Bearer ${key}`, // compat gateways accept either header
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs || 900000),
    }),
    consume: async (res) => {
      for await (const data of core.sseData(res)) {
        if (data === '[DONE]') break;
        let ev;
        try { ev = JSON.parse(data); } catch (e) { continue; }
        if (ev.error) { sawBodyError = JSON.stringify(ev.error).slice(0, 300); break; }
        if (ev.type === 'message_start' && ev.message && ev.message.usage) {
          usage = { ...usage, input_tokens: ev.message.usage.input_tokens ?? null, output_tokens: ev.message.usage.output_tokens ?? null };
        } else if (ev.type === 'content_block_start') {
          const b = ev.content_block || {};
          blocks.set(ev.index, { type: b.type, id: b.id, name: b.name, json: '' });
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta || {};
          const slot = blocks.get(ev.index) || { type: d.type === 'input_json_delta' ? 'tool_use' : (d.type === 'thinking_delta' ? 'thinking' : 'text'), json: '' };
          if (d.type === 'text_delta' && d.text) {
            parts.push(d.text);
            emit('text-delta', { text: d.text });
          } else if (d.type === 'thinking_delta' && d.thinking) {
            reasoningChunks.push(d.thinking);
            emit('reasoning-delta', { text: d.thinking });
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            slot.json += d.partial_json;
          }
          blocks.set(ev.index, slot);
        } else if (ev.type === 'content_block_stop') {
          const slot = blocks.get(ev.index);
          if (slot && slot.type === 'tool_use') emit('tool-call', { id: slot.id, name: slot.name });
        } else if (ev.type === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.usage) usage = { ...usage, ...ev.usage };
        } else if (ev.type === 'message_stop') {
          break;
        }
      }
    },
  });

  if (sawBodyError) throw new UpstreamError(`Upstream reported an error mid-stream: ${sawBodyError}`, false);
  core.throwIfNeverStreamed({}, Boolean(parts.length || reasoningChunks.length || blocks.size), label);

  const toolCalls = [...blocks.values()]
    .filter((b) => b.type === 'tool_use' && b.name)
    .map((b) => ({ id: b.id || 'toolu_call', name: b.name, arguments: b.json || '{}' }));
  const usageNorm = core.usageOut(usage, 0);
  emit('usage', usageNorm);

  return {
    content: parts.join(''),
    reasoning: reasoningChunks.join(''),
    toolCalls,
    citations: [],
    usage: usageNorm,
    rawUsage: usage || null,
    finishReason: stopReason || (toolCalls.length ? 'tool_use' : null),
    refusalText: null,
  };
}

// ---------- non-streaming single-shot (probes + JSON repair) ----------
async function complete(cfg, { messages, tools, maxTokens = 4000, timeoutMs = 120000 }) {
  const key = cfg.apiKey;
  if (!key) throw new NotConfiguredError(`${cfg.label || TYPE} API key`);
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => String(m.content || ''));
  const payload = {
    model: cfg.model,
    max_tokens: maxTokens,
    stream: false,
    messages: toProviderMessages(messages),
  };
  if (systemParts.length) payload.system = systemParts.join('\n\n');
  const t = toProviderTools(tools);
  if (t) payload.tools = t;
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      Authorization: `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    throw new UpstreamError(core.upstreamErrorText(res.status, text, cfg.label));
  }
  const data = await res.json();
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
  const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
    id: b.id || 'toolu_call', name: b.name || '', arguments: JSON.stringify(b.input || {}),
  }));
  const usageNorm = core.usageOut(data.usage, 0);
  return {
    content: text,
    reasoning: thinking,
    toolCalls,
    usage: usageNorm,
    rawUsage: data.usage || null,
    finishReason: data.stop_reason || null,
  };
}

module.exports = { TYPE, capabilities, chat, complete, toProviderMessages, toProviderTools };
