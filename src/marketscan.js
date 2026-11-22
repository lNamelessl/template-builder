// src/marketscan.js — LIVE Railway marketplace uniqueness scan.
// templateSearch GraphQL at backboard.railway.com/graphql/v2 — PUBLIC, unauth
// (pattern copied from the proven watcher/rescan-full.js + workspace rescan_full.js).
// One query per scan using the idea's keywords; returns real competing templates
// with deploymentCount + healthScore for the confirm card's uniqueness table.
'use strict';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEARCH_Q = `
query($q: String!, $first: Int!, $after: String) {
  templateSearch(first: $first, after: $after, query: $q) {
    edges { node { id code name creatorName description deploymentCount healthScore isVerified } }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function gql(query, variables, { retries = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
      return json.data;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

const STOPWORDS = new Set(('a an the and or of for with to in on at by from as is are was were be been being this that these those ' +
  'i my me we our you your it its he she they them their own build builder template templates app apps application service ' +
  'make create deploy deployable railway hosting host hosted server paste pasted url link like want need would should could ' +
  'please something anything new next version two one very really just so than then when what which who how why where all ' +
  'can will may might must not no yes using use used into out up down over under about after before between during through ' +
  'v1 v2 v3 x y z').split(' '));

function keywordsFromIdea(ideaText, max = 4) {
  const toks = String(ideaText || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  // frequency-weighted, longest-first within a frequency band
  const freq = new Map();
  for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
  const scored = [...freq.entries()].map(([t, f]) => ({ t, s: f * 100 + t.length }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, max).map((x) => x.t);
}

function scanRow(n) {
  return {
    code: n.code, name: n.name, creator: n.creatorName || null,
    deploys: n.deploymentCount ?? null, health: n.healthScore ?? null,
    verified: Boolean(n.isVerified), description: (n.description || '').slice(0, 160),
  };
}

// scan(ideaText) -> { query_used, found, competitors[], scanned_at }
// Adaptive narrowing: the marketplace search ANDs query terms, so a 4-keyword
// join can over-narrow to 0 rows (measured live: "pack minecraft modded" -> 0
// while "minecraft modded" -> modrinth-modpack-class rows). Candidates are
// built in keyword-SCORE order (most specific first), tried broadest-join ->
// narrowest, max 3 cheap unauth GraphQL calls (no category paging). A candidate
// only wins if its rows actually mention one of the load-bearing keywords.
async function scan(ideaText, { limit = 100 } = {}) {
  const kws = keywordsFromIdea(ideaText);
  const candidates = [];
  if (kws.length) {
    candidates.push(kws.join(' '));
    if (kws.length > 2) candidates.push(kws.slice(0, 2).join(' '));
    candidates.push(kws[0]);
  }
  const raw = String(ideaText || '').replace(/https?:\/\/\S+/g, ' ').slice(0, 60).trim();
  if (raw && raw.length > 2 && !candidates.includes(raw)) candidates.push(raw);
  if (!candidates.length) candidates.push('');

  const strong = kws.filter((k) => k.length >= 4);
  const relevant = (rows) => rows.some((r) => {
    const hay = `${r.name} ${r.code}`.toLowerCase();
    return kws.some((k) => hay.includes(k)) || (strong.length && strong.some((k) => hay.includes(k)));
  });

  let queryUsed = candidates[0];
  let rows = [];
  for (const q of candidates.slice(0, 3)) {
    const d = await gql(SEARCH_Q, { q, first: limit, after: null });
    const conn = d && d.templateSearch;
    const found = ((conn && conn.edges) || []).map((e) => scanRow(e.node))
      .filter((r) => r.name && r.code)
      .sort((a, b) => (b.deploys || 0) - (a.deploys || 0));
    queryUsed = q;
    rows = found;
    if (found.length && relevant(found)) break;
  }
  return {
    query_used: queryUsed,
    keywords: kws,
    found: rows.length,
    competitors: rows.slice(0, 12),
    scanned_at: new Date().toISOString(),
  };
}

module.exports = { scan, keywordsFromIdea, ENDPOINT };
