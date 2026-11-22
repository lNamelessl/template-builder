// src/llm/index.js — provider registry: ONE normalized client over THREE protocol
// adapters (deepseek native / generic openai-compat / anthropic-compat).
// - resolve(): reads the provider config (settings table) + secrets (vault) and
//   returns an adapter-bound client; researcher + builder are adapter-blind.
// - capability matrix per provider, enforced honestly:
//     server-side search  = DeepSeek only
//     thinking trajectory = when the provider emits reasoning
//     function-calling    = REQUIRED for the build loop (validated at save-time
//                           with a 1-token probe + a 1-tool probe call)
//     web research parity = server-side (DeepSeek) | optional Tavily key (others)
// - probeProvider(cfg): the wizard's live validation — typed errors on failure,
//   capability matrix snapshot on success.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { kvGet, kvSet, db, now } = require('../db');

const deepseek = require('./deepseek');
const openaiCompat = require('./openai-compat');
const anthropicCompat = require('./anthropic-compat');
const core = require('./core');

const ADAPTERS = { 'deepseek': deepseek, 'openai-compat': openaiCompat, 'anthropic-compat': anthropicCompat };

// wizard prefills per provider type (base URL + model placeholder)
const PROVIDER_TYPES = [
  { type: 'deepseek', label: 'DeepSeek (native — server-side web search + thinking)', base: 'https://api.deepseek.com', model: 'deepseek-flash', tavily: false },
  { type: 'openai-compat', label: 'OpenAI-compatible (OpenAI, OpenRouter, Groq, Together, Ollama, vLLM…)', base: 'https://api.openai.com', model: 'gpt-4.1', tavily: true },
  { type: 'anthropic-compat', label: 'Anthropic-compatible (Claude, /v1/messages gateways)', base: 'https://api.anthropic.com', model: 'claude-sonnet-4', tavily: true },
];

// ---------- provider config persistence (settings table + vault secrets) ----------
function saveProviderConfig({ type, baseUrl, model, caps }) {
  kvSet('llm_type', type);
  kvSet('llm_base_url', baseUrl);
  kvSet('llm_model', model);
  kvSet('llm_caps', JSON.stringify(caps || {}));
  kvSet('llm_saved_at', now());
}

function loadProviderConfig() {
  const type = kvGet('llm_type');
  if (!type) return null;
  let caps = {};
  try { caps = JSON.parse(kvGet('llm_caps') || '{}'); } catch (e) { caps = {}; }
  return {
    type,
    baseUrl: kvGet('llm_base_url') || '',
    model: kvGet('llm_model') || '',
    tavily: Boolean(kvGet('tavily_set') === '1'),
    caps,
    saved_at: kvGet('llm_saved_at') || null,
  };
}

// bind the adapter + inject secrets at CALL time (never cached, never logged)
function resolve() {
  const cfg = loadProviderConfig();
  if (!cfg) return null;
  const vault = require('../vault');
  cfg.apiKey = vault.get('LLM_API_KEY');
  cfg.tavilyKey = vault.get('TAVILY_API_KEY');
  if (cfg.tavilyKey) cfg.tavily = true;
  const adapter = ADAPTERS[cfg.type];
  if (!adapter) return null;
  const caps = adapter.capabilities(cfg);
  return {
    cfg,
    caps,
    chat: (opts) => adapter.chat(cfg, opts),
    complete: (opts) => adapter.complete(cfg, opts),
  };
}

function isConfigured() {
  const cfg = loadProviderConfig();
  if (!cfg) return false;
  const vault = require('../vault');
  return Boolean(vault.get('LLM_API_KEY'));
}

// ---------- capability probes (wizard save-time validation) ----------
const PROBE_TOOL = {
  name: 'tb_probe_tool',
  description: 'Capability probe: call this tool exactly once with {"marker": "ok"} to confirm tool-calling works.',
  parameters: { type: 'object', properties: { marker: { type: 'string', description: 'always the literal string ok' } }, required: ['marker'] },
};

// 1-token probe: connectivity + key + model. 1-tool probe: function-calling.
async function probeProvider({ type, baseUrl, apiKey, model, tavilyKey }) {
  const adapter = ADAPTERS[type];
  if (!adapter) {
    return { ok: false, code: 'unknown_provider_type', message: `Unknown provider type "${type}".`, next_action: 'Pick one of: deepseek, openai-compat, anthropic-compat.' };
  }
  const cfg = {
    type, baseUrl, apiKey, model,
    label: `${type} (${model})`,
    caps: {},
    tavilyKey: tavilyKey || null,
  };

  // --- probe 1: 1-token connectivity (key + model live) ---
  let ping;
  try {
    ping = await adapter.complete(cfg, {
      messages: [{ role: 'user', content: 'Reply with the single character 1.' }],
      maxTokens: 200,
      timeoutMs: 45000,
    });
  } catch (e) {
    return typedProbeError(e, 'connectivity probe');
  }
  if (!ping.content && !ping.reasoning && !ping.toolCalls) {
    return { ok: false, code: 'empty_probe', message: 'The provider responded 200 but returned no content for a trivial prompt.', next_action: `Check that model "${model}" exists at ${baseUrl} and can answer a 1-token prompt.` };
  }

  // --- probe 2: function-calling (REQUIRED for the build loop) ---
  let toolOk = false;
  let toolNote = '';
  try {
    const t = await adapter.complete(cfg, {
      messages: [
        { role: 'user', content: 'You must answer by CALLING the tb_probe_tool tool with {"marker":"ok"}. Do not answer in plain text.' },
      ],
      tools: [PROBE_TOOL],
      maxTokens: 400,
      timeoutMs: 45000,
    });
    toolOk = t.toolCalls && t.toolCalls.some((c) => c.name === PROBE_TOOL.name);
    if (!toolOk) toolNote = t.content ? `model replied with text instead of a tool call: "${String(t.content).slice(0, 80)}"` : 'no tool call in the response';
  } catch (e) {
    const pe = typedProbeError(e, 'tool-call probe');
    return {
      ok: false, code: 'tool_call_probe_failed',
      message: `The 1-token probe PASSED (key + model work) but the tool-call probe FAILED: ${pe.message}`,
      next_action: 'The build loop REQUIRES function-calling. Pick a tool-calling-capable model (e.g. gpt-4.1, claude-sonnet-4, deepseek-chat) or a provider that implements the standard tools parameter.',
    };
  }
  if (!toolOk) {
    return {
      ok: false, code: 'tool_call_missing',
      message: `The 1-token probe PASSED (key + model work) but the model did not call the probe tool (${toolNote}).`,
      next_action: 'The build loop REQUIRES function-calling. Pick a tool-calling-capable model or provider.',
    };
  }

  const caps = { functionCalling: 'ok', probed_at: new Date().toISOString(), ping_tokens: ping.usage || null };
  return { ok: true, caps, matrix: adapter.capabilities({ ...cfg, caps }) };
}

function typedProbeError(e, which) {
  if (e instanceof core.UpstreamError) {
    if (/HTTP 401/.test(e.message)) {
      return { ok: false, code: 'invalid_api_key', message: `The provider rejected this API key (HTTP 401) during the ${which}.`, next_action: 'Create a fresh API key and paste it again (keys are shown once).' };
    }
    if (/HTTP 404/.test(e.message)) {
      return { ok: false, code: 'model_or_url_not_found', message: `${e.message} — the model name or base URL looks wrong.`, next_action: 'Check the base URL (no /v1 needed for openai-compat; anthropic-compat needs the bare host) and the exact model id.' };
    }
    return { ok: false, code: 'upstream_error', message: e.message, next_action: 'Check the provider status page and the base URL, then retry.' };
  }
  if (e instanceof core.RiskError) {
    return { ok: false, code: 'provider_rejected', message: e.message, next_action: 'The provider refused the probe request; check its dashboard for model access.' };
  }
  return { ok: false, code: 'probe_network', message: `Could not reach the provider during the ${which}: ${String(e.message || e).slice(0, 160)}`, next_action: 'Check network/egress from this instance and the base URL, then retry — nothing was stored.' };
}

// ---------- capability matrix view (UI + /health) ----------
function matrixView() {
  const client = resolve();
  if (!client) return null;
  const m = client.caps;
  return {
    provider: client.cfg.type,
    model: client.cfg.model,
    base_url: client.cfg.baseUrl,
    server_search: m.serverSearch === true,
    thinking: m.reasoningStream === true,
    function_calling: m.functionCalling || 'untested', // 'ok' | 'missing' | 'untested'
    web_research: m.webResearch || 'model-knowledge', // 'server-side' | 'tavily' | 'model-knowledge'
    tavily_set: Boolean(client.cfg.tavilyKey),
  };
}

// full matrix when no provider is configured yet (for the wizard step)
function matrixFor(type, model, baseUrl) {
  const adapter = ADAPTERS[type];
  if (!adapter) return null;
  return adapter.capabilities({ model, baseUrl, caps: {} });
}

module.exports = {
  ADAPTERS, PROVIDER_TYPES, PROBE_TOOL,
  saveProviderConfig, loadProviderConfig, resolve, isConfigured,
  probeProvider, matrixView, matrixFor,
  core,
};
