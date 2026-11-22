// src/tavily.js — optional web-research parity for non-DeepSeek providers.
// DeepSeek researches with server-side web search (capability matrix: DeepSeek
// only). For openai-compat / anthropic-compat providers, a Tavily key (setup
// wizard box, optional) restores web grounding: 2-3 Tavily Search API calls
// (idea keywords + marketplace-coverage angle) are injected into the research
// prompt and their results become the report's citations. Without it, research
// falls back to model knowledge + the provider-independent live marketplace scan.
'use strict';

const ENDPOINT = 'https://api.tavily.com/search';

async function search(apiKey, query, { maxResults = 6, depth = 'basic' } = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: String(query).slice(0, 400),
      search_depth: depth,
      max_results: maxResults,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error('Tavily rejected this API key (HTTP 401/403)');
    e.code = 'tavily_key_invalid';
    throw e;
  }
  if (res.status === 432) { // Tavily quota exceeded (their code for out-of-credits)
    const e = new Error('Tavily quota exceeded (HTTP 432)');
    e.code = 'tavily_quota';
    throw e;
  }
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  const results = (Array.isArray(data.results) ? data.results : []).map((r) => ({
    title: r.title || r.url, url: r.url, content: String(r.content || '').slice(0, 800),
  }));
  return results;
}

// research-context search bundle: [idea keywords, "<idea> railway template"]
async function researchContext(apiKey, ideaText, keywords) {
  const queries = [
    String(ideaText).replace(/https?:\/\/\S+/g, '').slice(0, 120).trim() || keywords.join(' '),
    `${keywords.join(' ')} railway template marketplace`.slice(0, 160),
  ].filter(Boolean).slice(0, 2);
  const settled = await Promise.allSettled(queries.map((q) => search(apiKey, q)));
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const errors = settled.filter((s) => s.status === 'rejected').map((s) => String(s.reason && s.reason.message || s.reason).slice(0, 120));
  // merge by URL, cap 12
  const seen = new Set();
  const merged = [];
  for (const batch of ok) {
    for (const r of batch) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      merged.push(r);
      if (merged.length >= 12) break;
    }
    if (merged.length >= 12) break;
  }
  return { queries, results: merged, errors, used: merged.length > 0 };
}

module.exports = { search, researchContext, ENDPOINT };
