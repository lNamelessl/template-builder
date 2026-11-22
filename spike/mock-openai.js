// spike/mock-openai.js — MOCKED OpenAI-compatible server (the deepseek templates'
// BASE_URL mock trick): scripted SSE responses with reasoning deltas, content
// deltas, SPLIT tool_call deltas (arguments across chunks), usage, and a strict
// round-trip validator: when a tool result arrives it MUST be shaped exactly
// {role:'tool', tool_call_id, content} — a malformed round-trip fails the call.
// Scripted turns (by count of tool results in the request):
//   0 tool results -> tool_call: write_file {"path":"app.js","content":...}
//   1 tool result  -> tool_call: run_shell {"command":"npm i fastify ... && node app.js"}
//   2+ tool results-> final text "Build complete. HELLO-OK."
// Non-streaming (probes): tool-call probe returns tb_probe_tool tool_calls.
'use strict';
const http = require('http');

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const APP_JS = `const fastify = require('fastify')();
fastify.get('/health', async () => ({ status: 'ok' }));
fastify.listen({ port: 3099, host: '127.0.0.1' }).then(async () => {
  console.log('HELLO-OK /health ready');
  const res = await fetch('http://127.0.0.1:3099/health');
  console.log('health:', JSON.stringify(await res.json()));
  await fastify.close();
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });`;

// SPLIT the tool arguments JSON across 3 chunks (adapter accumulation proof);
// each entry rides the real wire envelope {choices:[{delta:{tool_calls:[…]}}]}
function splitToolCall(callId, name, argsJson, baseIndex) {
  const a = argsJson;
  const cuts = [Math.ceil(a.length / 3), Math.ceil((a.length * 2) / 3)];
  return [
    { index: baseIndex, id: callId, type: 'function', function: { name, arguments: a.slice(0, cuts[0]) } },
    { index: baseIndex, function: { arguments: a.slice(cuts[0], cuts[1]) } },
    { index: baseIndex, function: { arguments: a.slice(cuts[1]) } },
  ].map((tc) => ({ choices: [{ delta: { tool_calls: [tc] } }] }));
}

function countToolResults(messages) {
  return messages.filter((m) => m.role === 'tool').length;
}

function validateToolRoundTrip(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) {
        return `tool result at index ${i} is missing tool_call_id (round-trip broken)`;
      }
      const prev = messages[i - 1];
      if (!prev || prev.role !== 'assistant' || !Array.isArray(prev.tool_calls)) {
        return `tool result at index ${i} is not preceded by an assistant tool_calls message`;
      }
      if (!prev.tool_calls.some((c) => c.id === m.tool_call_id)) {
        return `tool result tool_call_id ${m.tool_call_id} does not match any assistant tool_call id`;
      }
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        if (!c.id || !c.function || typeof c.function.name !== 'string' || typeof c.function.arguments !== 'string') {
          return `assistant tool_call at index ${i} malformed (need id + function.name + function.arguments as STRING)`;
        }
      }
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end(JSON.stringify({ error: { message: 'unknown path' } }));
    return;
  }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
    const messages = payload.messages || [];
    const roundTripErr = validateToolRoundTrip(messages);
    if (roundTripErr) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `MOCK ROUND-TRIP VALIDATION FAILED: ${roundTripErr}`, type: 'mock_validation' } }));
      return;
    }
    const toolResults = countToolResults(messages);
    const wantsTools = Array.isArray(payload.tools) && payload.tools.length;

    if (payload.stream === false) {
      // probes: 1-token probe -> content; tool probe -> tool_calls
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (wantsTools && lastUser && /tb_probe_tool/.test(JSON.stringify(payload.tools))) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_probe_1', type: 'function', function: { name: 'tb_probe_tool', arguments: '{"marker":"ok"}' } }] } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '1' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }));
      return;
    }

    // ---- streaming scripts ----
    if (toolResults === 0 && wantsTools) {
      const chunks = [
        { choices: [{ delta: { role: 'assistant' } }] },
        { choices: [{ delta: { reasoning_content: 'I will write the hello-world fastify app first.' } }] },
        { choices: [{ delta: { reasoning_content: ' Then run it to prove /health works.' } }] },
        { choices: [{ delta: { content: 'Writing the app now.\n' } }] },
        ...splitToolCall('call_write_1', 'write_file', JSON.stringify({ path: 'app.js', content: APP_JS }), 0),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [{}], usage: { prompt_tokens: 210, completion_tokens: 190 } },
      ];
      sse(res, chunks);
      return;
    }
    if (toolResults === 1 && wantsTools) {
      const chunks = [
        { choices: [{ delta: { reasoning_content: 'App written. Now install fastify and run it.' } }] },
        { choices: [{ delta: { content: 'Installing and running.\n' } }] },
        ...splitToolCall('call_shell_1', 'run_shell', JSON.stringify({ command: 'npm init -y >/dev/null 2>&1 && npm i fastify --no-audit --no-fund --silent && node app.js' }), 0),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [{}], usage: { prompt_tokens: 480, completion_tokens: 90 } },
      ];
      sse(res, chunks);
      return;
    }
    // final turn
    sse(res, [
      { choices: [{ delta: { content: 'Build complete. The app wrote, installed fastify, ran, and /health returned {"status":"ok"}. HELLO-OK.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [{}], usage: { prompt_tokens: 900, completion_tokens: 45 } },
    ]);
  });
});

if (require.main === module) {
  const port = parseInt(process.argv[2] || '8971', 10);
  server.listen(port, '127.0.0.1', () => console.log(`mock-openai listening on 127.0.0.1:${port}`));
}
module.exports = { server, APP_JS };
