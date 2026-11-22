// spike/test-toolloop.js — SPIKE PROOF: the builder tool-loop path over a MOCKED
// provider (zero keys). 3 LLM turns: write_file (hello-world Fastify app) ->
// run_shell (npm i fastify + node app.js — the app self-verifies /health and
// exits) -> final text. Uses the REAL builder primitives (toolDefs + execTool +
// redactor) with the REAL adapter, sandboxed into .data-spike/builds/spike-loop.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), `tb-spike-${Date.now()}`);
const openaiMock = require('./mock-openai');
const openaiCompat = require('../src/llm/openai-compat');
const builder = require('../src/builder');

const PORT = 8983;
const cfg = { type: 'openai-compat', baseUrl: `http://127.0.0.1:${PORT}`, apiKey: 'mock-sk-key', model: 'mock-gpt', label: 'mock-openai' };

function startMock() {
  return new Promise((resolve) => openaiMock.server.listen(PORT, '127.0.0.1', resolve));
}

async function main() {
  await startMock();
  try {
    console.log('SPIKE test-toolloop — 3-turn build loop over the MOCKED openai-compat provider');
    const ws = path.join(process.env.DATA_DIR, 'builds', 'spike-loop');
    fs.mkdirSync(ws, { recursive: true });
    const redact = builder.buildRedactor();
    const tools = builder.toolDefs();
    assert.deepStrictEqual(tools.map((t) => t.name), ['write_file', 'read_file', 'list_dir', 'run_shell'], 'canonical tool set changed');
    assert.ok(tools.every((t) => t.name && t.description && t.parameters), 'canonical tool defs need name+description+parameters (adapters map them)');

    const messages = [
      { role: 'system', content: 'You build apps. Use the tools.' },
      { role: 'user', content: 'build a hello-world fastify app that self-checks /health' },
    ];
    const turns = [];
    let finalText = '';
    let shellStdout = '';
    for (let turn = 1; turn <= 6; turn++) {
      const r = await openaiCompat.chat(cfg, { messages, tools, maxTokens: 4000, onEvent: () => {} });
      if (!r.toolCalls.length) { finalText = r.content; turns.push({ turn, kind: 'final' }); break; }
      const asst = { role: 'assistant', content: r.content || null, tool_calls: r.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) };
      messages.push(asst);
      for (const call of asst.tool_calls) {
        const args = JSON.parse(call.arguments);
        const result = await builder.execTool(ws, call.name, args, redact);
        turns.push({ turn, tool: call.name, ok: result.ok, detail: String(result.detail || '').slice(0, 90) });
        const content = result.ok ? JSON.stringify(result.result) : JSON.stringify({ error: result.error });
        messages.push({ role: 'tool', tool_call_id: call.id, content });
        if (call.name === 'run_shell') shellStdout = result.result.stdout || '';
      }
    }

    // ---- assertions: the loop wrote, ran, and the app served /health
    assert.ok(finalText.includes('Build complete'), `final text missing (got: ${finalText.slice(0, 120)})`);
    assert.strictEqual(turns.filter((t) => t.tool === 'write_file').length, 1, 'write_file turn missing');
    assert.strictEqual(turns.filter((t) => t.tool === 'run_shell').length, 1, 'run_shell turn missing');
    const shellTurn = turns.find((t) => t.tool === 'run_shell');
    assert.ok(shellTurn.ok, `run_shell failed: ${JSON.stringify(shellTurn)}`);
    assert.ok(shellStdout.includes('HELLO-OK'), `app did not print HELLO-OK (stdout: ${shellStdout.slice(0, 200)})`);
    assert.ok(shellStdout.includes('"status":"ok"'), 'health JSON missing from app stdout');
    assert.ok(fs.existsSync(path.join(ws, 'app.js')), 'app.js missing from the sandbox');
    console.log(`  turns: ${turns.map((t) => `${t.turn}:${t.tool || 'final'}${t.ok === false ? '!ok' : ''}`).join(' -> ')}`);
    console.log(`  app stdout captured: ${shellStdout.split('\n').filter(Boolean).join(' | ')}`);
    console.log('RESULT: PASS — sandboxed write_file + run_shell executed a real fastify hello-world (npm install + self-checking /health run) in 3 LLM turns, zero keys');
  } finally {
    await new Promise((r) => openaiMock.server.close(r));
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('RESULT: FAIL', e); process.exit(1); });
}
module.exports = { main };
