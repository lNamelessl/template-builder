# Template Builder

Describe an app — an AI agent **builds the repo, deploys it and publishes it as a one-click Railway template on your own account**. No research phase, no confirm gate: submit an idea and the build loop starts immediately.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/template-builder)

This repo is the deployable source of the **Template Builder** template. See [TEMPLATE_OVERVIEW.md](TEMPLATE_OVERVIEW.md) for the marketplace listing (quickstart, credential sourcing, honest limits).

## Architecture

One Node 22 + Fastify service, better-sqlite3 (WAL) on a `/data` volume, vanilla-JS dark 3-pane UI over SSE.

```
src/
  server.js         Fastify app: /health (dotless, unauth), login gate, setup wizard
                    (provider step + token steps, live-validated), builds API + SSE,
                    workspace file browser, settings
  llm/              PROVIDER-AGNOSTIC LLM layer — three protocol adapters behind ONE
                    normalized event stream (text-delta / reasoning-delta / tool-call /
                    usage / citations):
    core.js           shared SSE retry mechanics, typed errors, cost estimate
    deepseek.js       native DeepSeek (thinking + standard client function-calling)
    openai-compat.js  generic OpenAI-compatible (OpenAI, OpenRouter, Groq, Together,
                      Ollama, vLLM — standard tools/tool_calls)
    anthropic-compat.js /v1/messages shape (thinking deltas, tool_use/tool_result blocks)
    index.js          registry + capability matrix (function_calling + thinking) +
                      save-time probes (1-token + 1-tool function-calling probe —
                      the build loop REQUIRES it)
  builder.js        tool-loop executor: sandboxed write_file/read_file/list_dir/
                    run_shell, secret redaction, caps (turns/spend/time),
                    publish verification
  promptgen.js      builder system prompt: RUNTIME-LOADED knowledge pack (ops
                    distillation of 50+ published-template workflows), publish SOP,
                    six validator headings
  vault.js          AES-256-GCM secret vault (key file 0600 on the volume, masked
                    display, redaction list)
  auth.js           APP_ACCESS_PASSWORD gate + first-login banner + marker-guarded seed
  telegram.js       optional push on DONE/FAILED
  config.js         env parsing; ZERO required prompts
public/             dark 3-pane dsh-lookalike UI (builds list / build detail +
                    ALWAYS-VISIBLE idea composer / workspace files + result card)
                    + setup wizard
spike/              zero-deploy proofs: MOCKED OpenAI + Anthropic servers, adapter
                    normalization tests, vault round-trip, 3-turn tool-loop writing
                    + running a real Fastify app
```

## Spike proofs (no keys needed)

```sh
npm ci
node spike/test-adapters.js     # both non-DeepSeek adapters normalize vs mocked servers
node spike/test-toolloop.js     # 3-turn loop writes + runs a hello-world Fastify app
node spike/test-vault.js        # AES-256-GCM round trip, masking, redaction, tamper
```

## Deploying

Deploy from the template (zero prompts — the password is generated and printed in the deploy log), then follow the 3-step setup wizard (provider + Railway token + GitHub token). Everything is validated live and stored encrypted on the instance volume. Type an app idea in the composer — the build loop streams progress and ends with the live template URL.
