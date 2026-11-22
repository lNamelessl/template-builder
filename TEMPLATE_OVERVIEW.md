Describe an app — an AI agent builds the repo, deploys it and PUBLISHES it as a one-click template on your account.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/template-builder)

**Template Builder** is one Node 22 service with a dark 3-pane workspace: complete a one-time guided setup (instance password + your own LLM provider + your Railway and GitHub tokens), type a template idea or paste a URL, and the agent immediately builds the repo in a sandboxed tool-loop, pushes it to your GitHub, deploys it via the bundled Railway CLI, and publishes it as a one-click template — ending with the live template URL. No research phase, no confirm gate: submit an idea and the build loop starts.

## After deploying

1. Get your instance password: the `TEMPLATE BUILDER FIRST LOGIN` banner in Deployments - View Logs prints it (also `/data/first-login.txt`). Change it now via the `APP_ACCESS_PASSWORD` variable.
2. Open the domain, log in, complete **Setup wizard Step 1 - LLM provider**: pick DeepSeek (default) or any OpenAI-compatible / Anthropic-compatible provider (OpenRouter, Groq, Ollama, vLLM, Claude gateways); base URL and model pre-filled; a live probe checks connectivity AND function-calling (required for the build loop) before anything saves.
3. **Step 2 - RAILWAY_TOKEN**: the wizard deep-links to railway.com/account/tokens (New Token copies immediately). **Step 3 - GITHUB_TOKEN**: deep-links to a classic PAT with the repo scope pre-checked. Each token is live-validated, stored AES-encrypted, shown masked thereafter.
4. Describe your idea in the composer (always visible, even before any build exists) - the tool-loop starts immediately: thinking, file writes and shell commands stream live into the trajectory panel and the workspace file tree.
5. When the publish SOP completes, the result card shows the live template URL and the GitHub repo. Failed builds keep their workspace for one-click resume.

## What is inside

| Capability | Detail |
|---|---|
| Provider-agnostic LLM layer | Three protocol adapters behind one normalized event stream (text / reasoning / tool-call / usage): DeepSeek native, generic OpenAI-compatible (any /chat/completions server with standard tools), Anthropic-compatible (/v1/messages with tool_use / tool_result blocks). The build loop is adapter-blind. |
| Ops-knowledge pack | The build agent is guided by a distillation of 50+ published-template ops workflows (deploy, publish, repo-setup, quirks, ease-of-use contract) shipped as markdown in `knowledge/` and loaded at build-run time — versioned per build, updatable without code changes. |
| Capability matrix, enforced honestly | Function-calling = REQUIRED for the build loop, probed at setup (1-token + a real 1-tool probe); thinking trajectory = captured when the provider emits reasoning. Shown in the wizard, header chips and /health. |
| Build loop | Function-calling tool executor with a sandbox root under `/data/builds/` (path traversal blocked): write_file / read_file / list_dir / run_shell. Shell env allowlisted with your tokens injected per call; every output passes a secret redactor before logs or the UI. Caps: 40 turns, spend cap, 60-min timeout (env-tunable) - a cap hit = graceful FAILED + one-click resume. |
| Publish SOP | Prompt-baked playbook: git init + push, `railway init`, `railway up` (healthcheck-gated), `/health` verify, `railway templates create`, publish with the generated overview (six validator headings, zero angle brackets). |
| UI | Dark 3-pane workspace: LEFT builds list with status chips; CENTER build trajectory + result card with the idea composer ALWAYS visible below (works from the empty state — no build needs to be selected); RIGHT live workspace file tree + result card + log tail. Settings: caps view, provider + token management. |
| Ops | `/health` dotless, unauth, zero upstream calls; boots healthy with ZERO tokens (guided states name the missing piece + deep link on every op); ON_FAILURE/10; volume /data; non-root; optional Telegram push. |

## Credential sourcing

| Value | Where you get it | Where it lands |
|---|---|---|
| Instance password | Generated per deploy (`APP_ACCESS_PASSWORD`); printed in the first-login deploy-log banner and written to `/data/first-login.txt` | Login page (change it immediately via the Variables tab) |
| LLM provider key | DeepSeek: platform.deepseek.com - API keys. OpenAI-compatible: your provider dashboard. Anthropic-compatible: console.anthropic.com or your gateway | Wizard Step 1 (live-probed; AES-encrypted at rest; masked display) |
| RAILWAY_TOKEN | railway.com/account/tokens - New Token (displayed once, copies immediately) | Wizard Step 2 (validated against the live GraphQL API) |
| GITHUB_TOKEN | github.com/settings/tokens/new - classic PAT, repo scope pre-checked in the deep link | Wizard Step 3 (validated: identity + scope check) |

## Honest limits (measured)

| Limit | Value |
|---|---|
| Function-calling required | The build loop needs a tool-calling model. Providers that cannot tool-call are REFUSED at setup with a typed error naming the fix. |
| Builds are best-effort autonomous | Deploy + healthcheck + publish are automated; a 2-deploy verification battery of each generated template is not automated in v1. Failed builds keep workspace + logs for one-click resume. |
| Cost | LLM tokens bill to YOUR provider account (cost estimated only for DeepSeek - others show token counts). Railway usage of built services bills to YOUR Railway plan. |
| Token safety | Tokens stay in your instance (AES-256-GCM, key file 0600), go only to your chosen LLM / GitHub / Railway APIs, and are redacted from every log and trajectory. |
| Publishing rules | The generated listing must pass the marketplace validator (six headings, no angle brackets, 10,000-char cap) - the prompt bakes these in; a rare output may need one manual edit before re-running the publish step. |
| One build at a time | Concurrency is 1 — a second idea submitted while a build runs gets a typed busy envelope; wait or cancel the running build. |

# Deploy and Host

## About Hosting

Hosting Template Builder is one Railway service: a Node 22 container (non-root, git + curl + the pinned Railway CLI bundled) with a `/data` volume holding the SQLite database (WAL), the AES key file, and every build workspace. Deploys are healthcheck-gated on a relative dotless `api/health` route that performs zero upstream calls, so the service boots healthy before any token exists: every build op stays paused in guided states naming the exact missing piece and its deep link, and completing the wizard unpauses everything without a redeploy. The build loop runs in the same service - shells execute with an allowlisted env in the build's sandbox, and every build keeps its workspace for resume.

## Why Deploy

Manually turning an idea into a published template is a day of context switching: write the repo, deploy it, chase the healthcheck, format the listing, push, publish. This template collapses that into one sentence: describe the app, and the agent builds, deploys and publishes it while you watch the trajectory stream live. Your credentials never leave your instance: entered in a wizard that validates each one live, stored encrypted at rest, used only for the API calls you chose.

## Common Use Cases

- Template authors turning an idea backlog into published one-click templates without the pipeline ceremony
- Indie hackers shipping their tool as a one-click template without learning the deploy + publish flow
- Agencies producing client deployables: describe the app, get a repo + deployment + listing
- Platform teams cataloging internal tools: reproducible repos with publish-ready overview files

## Dependencies for

### Deployment Dependencies

- **Your own LLM provider** (wizard Step 1): a DeepSeek API key from platform.deepseek.com - API keys, or any OpenAI-compatible / Anthropic-compatible provider key (OpenRouter, Groq, Together, Ollama, vLLM, Claude gateways). Function-calling capability is required and probed. Billed to your provider account.
- **RAILWAY_TOKEN**: an account token from railway.com/account/tokens; templates publish to YOUR workspace.
- **GITHUB_TOKEN**: a classic PAT with the repo scope (wizard deep-link has the scope pre-checked); built repos land in YOUR GitHub account.
- Everything else self-provisions: Node 22 base image, SQLite (bundled prebuilds), the `/data` volume, the public domain, the bundled Railway CLI, git and curl.
