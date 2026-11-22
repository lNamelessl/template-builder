// spike/mock-anthropic.js — MOCKED Anthropic-compatible server (/v1/messages):
// scripted SSE with the real event grammar (message_start -> content_block_start
// thinking -> thinking_delta -> text_delta -> tool_use block + input_json_delta ->
// message_delta(stop_reason, usage) -> message_stop) and a strict round-trip
// validator: tool results MUST arrive as tool_result blocks inside a user
// message whose tool_use_id matches the prior assistant tool_use block.
'use strict';
const http = require('http');

const APP_JS = `const fastify = require('fastify')();
fastify.get('/health', async () => ({ status: 'ok' }));
fastify.listen({ port: 3099, host: '127.0.0.1' }).then(async () => {
  console.log('HELLO-OK /health ready');
  const res = await fetch('http://127.0.0.1:3099/health');
  console.log('health:', JSON.stringify(await res.json()));
  await fastify.close();
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });`;

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function countToolResults(messages) {
  let n = 0;
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result') n++;
    }
  }
  return n;
}

function validateToolRoundTrip(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          if (!b.tool_use_id) return `tool_result at message ${i} missing tool_use_id`;
          const prev = messages[i - 1];
          if (!prev || prev.role !== 'assistant' || !Array.isArray(prev.content) || !prev.content.some((c) => c.type === 'tool_use' && c.id === b.tool_use_id)) {
            return `tool_result ${b.tool_use_id} not preceded by matching assistant tool_use block`;
          }
          if (typeof b.content !== 'string') return `tool_result content must be a string (got ${typeof b.content})`;
        }
      }
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use' && (!b.id || !b.name || typeof b.input !== 'object')) {
          return `assistant tool_use at message ${i} malformed (need id + name + input object)`;
        }
      }
    }
  }
  // system must be hoisted, never a message
  if (messages.some((m) => m.role === 'system')) return 'system message must be hoisted to the top-level system param (anthropic wire shape)';
  return null;
}

// split tool input JSON for input_json_delta chunks
function jsonDeltaEvents(index, input) {
  const s = JSON.stringify(input);
  const cuts = [Math.ceil(s.length / 2)];
  return [
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: s.slice(0, cuts[0]) } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: s.slice(cuts[0]) } },
  ];
}

const server = http.createServer((req, res) => {
  if (!req.url.includes('/v1/messages')) {
    res.writeHead(404).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'unknown path' } }));
    return;
  }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
    const messages = payload.messages || [];
    const err = validateToolRoundTrip(messages);
    if (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'mock_validation', message: `MOCK ROUND-TRIP VALIDATION FAILED: ${err}` } }));
      return;
    }
    const toolResults = countToolResults(messages);

    if (payload.stream === false) {
      if (Array.isArray(payload.tools) && payload.tools.some((t) => t.name === 'tb_probe_tool')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_probe', type: 'message', role: 'assistant', stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_probe_1', name: 'tb_probe_tool', input: { marker: 'ok' } }],
          usage: { input_tokens: 14, output_tokens: 9 },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_ping', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: '1' }],
        usage: { input_tokens: 5, output_tokens: 1 },
      }));
      return;
    }

    const start = { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 150, output_tokens: 1 } } };
    const stop = [
      { type: 'message_delta', delta: { stop_reason: toolResults >= 2 ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 60 } },
      { type: 'message_stop' },
    ];

    if (toolResults === 0) {
      sse(res, [
        start,
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I will write the hello-world fastify app first.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' Then run it to prove /health works.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Writing the app now.\n' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_write_1', name: 'write_file', input: {} } },
        ...jsonDeltaEvents(2, { path: 'app.js', content: APP_JS }),
        { type: 'content_block_stop', index: 2 },
        ...stop,
      ]);
      return;
    }
    if (toolResults === 1) {
      sse(res, [
        start,
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'App written. Now install fastify and run it.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Installing and running.\n' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_shell_1', name: 'run_shell', input: {} } },
        ...jsonDeltaEvents(2, { command: 'npm init -y >/dev/null 2>&1 && npm i fastify --no-audit --no-fund --silent && node app.js' }),
        { type: 'content_block_stop', index: 2 },
        ...stop,
      ]);
      return;
    }
    sse(res, [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Build complete. The app wrote, installed fastify, ran, and /health returned {"status":"ok"}. HELLO-OK.' } },
      { type: 'content_block_stop', index: 0 },
      ...stop,
    ]);
  });
});

if (require.main === module) {
  const port = parseInt(process.argv[2] || '8972', 10);
  server.listen(port, '127.0.0.1', () => console.log(`mock-anthropic listening on 127.0.0.1:${port}`));
}
module.exports = { server, APP_JS };
