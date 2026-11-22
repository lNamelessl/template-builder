Describe an app — an AI agent researches it, scans the marketplace for twins, builds the repo, deploys it and PUBLISHES it as a template on your account.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/template-builder)

**Template Builder** is one Node 22 service with a dark 3-pane workspace: complete a one-time guided setup (instance password + your own LLM provider + your Railway and GitHub tokens), type a template idea or paste a URL, and the agent (1) researches the idea with web search, deep thinking and citations, (2) scans the LIVE marketplace for similar templates with real deploy counts, (3) after a one-click confirm builds the repo in a sandboxed tool-loop, pushes it to your GitHub, deploys it via the bundled Railway CLI, and publishes it as a one-click template — ending with the live template URL.

## After deploying

1. Get your instance password: the `TEMPLATE BUILDER FIRST LOGIN` banner in Deployments - View Logs prints it (also `/data/first-login.txt`). Change it now via the `APP_ACCESS_PASSWORD` variable.
2. Open the domain, log in, complete **Setup wizard Step 1 - LLM provider**: pick DeepSeek (default; server-side web search + thinking) or any OpenAI-compatible / Anthropic-compatible provider (OpenRouter, Groq, Ollama, vLLM, Claude gateways); base URL and model pre-filled; a live probe checks connectivity AND function-calling (required for the build loop) before anything saves. Non-DeepSeek types show an optional Tavily box restoring web-grounded research.
3. **Step 2 - RAILWAY_TOKEN**: the wizard deep-links to railway.com/account/tokens (New Token copies immediately). **Step 3 - GITHUB_TOKEN**: deep-links to a classic PAT with the repo scope pre-checked. Each token is live-validated, stored AES-encrypted, shown masked thereafter.
4. Describe your idea in the composer - research streams live (thinking, citations) and the uniqueness table fills with real competing templates and deploy counts.
5. Review the confirm card (verdict, twins found, ToS flags) - **Build & publish** - the tool-loop writes files, runs commands, pushes, deploys and publishes; the result card shows the live template URL.

## What is inside

| Capability | Detail |
|---|---|
| Provider-agnostic LLM layer | Three protocol adapters behind one normalized event stream (text / reasoning / tool-call / usage / citations): DeepSeek native (server-side `deepseek_web_search` + reasoning capture), generic OpenAI-compatible (any /chat/completions server with standard tools), Anthropic-compatible (/v1/messages with tool_use / tool_result blocks). Researcher and build loop are adapter-blind. |
| Ops-knowledge pack | The build agent is guided by a distillation of 50+ published-template ops workflows (deploy, publish, repo-setup, quirks, ease-of-use contract) shipped as markdown in `knowledge/` and loaded at build-run time — versioned per build, updatable without code changes. |
| Capability matrix, enforced honestly | Server-side web search = DeepSeek only; thinking trajectory = when the provider emits reasoning; function-calling = REQUIRED, probed at setup (1-token + a real 1-tool probe); web research parity for non-DeepSeek = optional Tavily key. Shown in the wizard, header chips and /health. |
| Research phase | One streaming call per idea: demand, existing solutions, feasibility (image / volumes / ports / env / healthcheck), ToS/legal flags, naming. DeepSeek = web-grounded; others = model knowledge + optional Tavily citations + the live scan. Strict-JSON report with one repair retry. |
| Marketplace uniqueness scan | LIVE `templateSearch` GraphQL (public, unauth): real competing templates with creator, deploy counts, healthScore. Adaptive query narrowing (3 cheap attempts). Real for every provider. |
| Build loop | Function-calling tool executor with a sandbox root under `/data/builds/` (path traversal blocked): write_file / read_file / list_dir / run_shell. Shell env allowlisted with your tokens injected per call; every output passes a secret redactor before logs or the UI. Caps: 40 turns, spend cap, 60-min timeout (env-tunable) - a cap hit = graceful FAILED + one-click resume. |
| Publish SOP | Prompt-baked playbook: git init + push, `railway init`, `railway up` (healthcheck-gated), `/health` verify, `railway templates create`, publish with the generated overview (six validator headings, zero angle brackets). |
| UI | Dark 3-pane workspace: LEFT builds list with status chips; CENTER research report + uniqueness table + collapsible trajectory + composer + inline confirm/result cards; RIGHT live workspace file tree + result card + log tail. Settings: auto-build toggle, caps view, provider + token management. |
| Ops | `/health` dotless, unauth, zero upstream calls; boots healthy with ZERO tokens (guided states name the missing piece + deep link on every op); ON_FAILURE/10; volume /data; non-root; optional Telegram push. |

## Credential sourcing

| Value | Where you get it | Where it lands |
|---|---|---|
| Instance password | Generated per deploy (`APP_ACCESS_PASSWORD`); printed in the first-login deploy-log banner and written to `/data/first-login.txt` | Login page (change it immediately via the Variables tab) |
| LLM provider key | DeepSeek: platform.deepseek.com - API keys. OpenAI-compatible: your provider dashboard. Anthropic-compatible: console.anthropic.com or your gateway | Wizard Step 1 (live-probed; AES-encrypted at rest; masked display) |
| Tavily key (optional) | app.tavily.com - your account | Wizard Step 1, Tavily box (non-DeepSeek types only) |
| RAILWAY_TOKEN | railway.com/account/tokens - New Token (displayed once, copies immediately) | Wizard Step 2 (validated against the live GraphQL API) |
| GITHUB_TOKEN | github.com/settings/tokens/new - classic PAT, repo scope pre-checked in the deep link | Wizard Step 3 (validated: identity + scope check) |

## Honest limits (measured)

| Limit | Value |
|---|---|
| Research depth varies by provider | DeepSeek = web-grounded (server-side search, citations, thinking). OpenAI-compatible / Anthropic-compatible = model knowledge + live marketplace scan; web-grounding needs the optional Tavily key. The wizard matrix and header chips state this honestly. |
| Function-calling required | The build loop needs a tool-calling model. Providers that cannot tool-call are REFUSED at setup with a typed error naming the fix. |
| Builds are best-effort autonomous | Deploy + healthcheck + publish are automated; a 2-deploy verification battery of each generated template is not automated in v1. Failed builds keep workspace + logs for one-click resume. |
| Cost | LLM tokens bill to YOUR provider account (DeepSeek research measured cents-to-dimes per idea; cost estimated only for DeepSeek - others show token counts). Railway usage of built services bills to YOUR Railway plan. |
| Uniqueness scan is point-in-time | The marketplace moves; re-research refreshes the scan. |
| Token safety | Tokens stay in your instance (AES-256-GCM, key file 0600), go only to your chosen LLM / GitHub / Railway / Tavily APIs, and are redacted from every log and trajectory. |
| Publishing rules | The generated listing must pass the marketplace validator (six headings, no angle brackets, 10,000-char cap) - the prompt bakes these in; a rare output may need one manual edit before re-running the publish step. |

# Deploy and Host

## About Hosting

Hosting Template Builder is one Railway service: a Node 22 container (non-root, git + curl + the pinned Railway CLI bundled) with a `/data` volume holding the SQLite database (WAL), the AES key file, and every build workspace. Deploys are healthcheck-gated on a relative dotless `api/health` route that performs zero upstream calls, so the service boots healthy before any token exists: research and builds stay paused in guided states naming the exact missing piece and its deep link, and completing the wizard unpauses everything without a redeploy. The build loop runs in the same service - shells execute with an allowlisted env in the build's sandbox, and every build keeps its workspace for resume.

## Why Deploy

Manually turning an idea into a published template is a day of context switching: research the market, diff against existing templates, write the repo, deploy it, chase the healthcheck, format the listing, push, publish. This template collapses that into one confirm click after a researched recommendation - with the evidence (thinking trajectory, citations, live deploy counts of the twins) attached to every build. Your credentials never leave your instance: entered in a wizard that validates each one live, stored encrypted at rest, used only for the API calls you chose.

## Common Use Cases

- Template authors scanning an idea backlog: research + uniqueness evidence before committing effort
- Indie hackers shipping their tool as a one-click template without learning the pipeline
- Agencies producing client deployables: describe the app, get a repo + deployment + listing
- Platform teams cataloging internal tools: reproducible repos with publish-ready overview files

## Dependencies for

### Deployment Dependencies

- **Your own LLM provider** (wizard Step 1): a DeepSeek API key from platform.deepseek.com - API keys, or any OpenAI-compatible / Anthropic-compatible provider key (OpenRouter, Groq, Together, Ollama, vLLM, Claude gateways). Function-calling capability is required and probed. Billed to your provider account.
- **RAILWAY_TOKEN**: an account token from railway.com/account/tokens; templates publish to YOUR workspace.
- **GITHUB_TOKEN**: a classic PAT with the repo scope (wizard deep-link has the scope pre-checked); built repos land in YOUR GitHub account.
- **TAVILY_API_KEY** (optional): from app.tavily.com, for web-grounded research on non-DeepSeek providers.
- Everything else self-provisions: Node 22 base image, SQLite (bundled prebuilds), the `/data` volume, the public domain, the bundled Railway CLI, git and curl.
