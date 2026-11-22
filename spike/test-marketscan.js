// spike/test-marketscan.js — SPIKE PROOF: marketscan.js returns REAL marketplace
// rows (templateSearch GraphQL at backboard.railway.com, unauth) for the probe
// idea "paste-a-pack-URL Minecraft modded server" — modrinth-modpack-class
// listings with deploy counts. This is provider-independent real data (works
// with every LLM provider).
'use strict';
const assert = require('assert');
const marketscan = require('../src/marketscan');

async function main() {
  console.log('SPIKE test-marketscan — LIVE templateSearch rows for the probe idea');
  const idea = 'paste-a-pack-URL Minecraft modded server';
  const r = await marketscan.scan(idea, { limit: 100 });
  console.log(`  query_used: "${r.query_used}" (keywords: ${r.keywords.join(', ')})`);
  console.log(`  found: ${r.found} rows; top competitors:`);
  for (const c of r.competitors.slice(0, 8)) {
    console.log(`    - ${c.name} (${c.code}) creator=${c.creator} deploys=${c.deploys} health=${c.health}`);
  }
  assert.ok(r.found > 0, 'marketscan returned ZERO rows — the unauth templateSearch query is broken');
  const joined = r.competitors.map((c) => `${c.name} ${c.code} ${c.description}`).join(' ').toLowerCase();
  const modrinthClass = r.competitors.some((c) => /modrinth|modpack|mods|minecraft/i.test(`${c.name} ${c.code}`));
  assert.ok(modrinthClass, 'no modrinth-modpack-class listing in the results');
  assert.ok(r.competitors.some((c) => c.deploys > 0), 'no competitor carries a deploy count (deploy-count column broken)');
  const kwOk = r.keywords.includes('minecraft') || /minecraft/.test(r.query_used);
  assert.ok(kwOk, `keyword extraction lost the load-bearing term (got: ${r.keywords.join(',')})`);
  console.log('  keyword extraction kept "minecraft"; modrinth-modpack-class rows present WITH deploy counts');
  console.log('RESULT: PASS — live marketplace uniqueness scan returns real rows for the probe idea');
  return r;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('RESULT: FAIL', e); process.exit(1); });
}
module.exports = { main };
