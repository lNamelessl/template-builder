# Railway quirks — load-bearing one-liners (from 57+ published builds)

Each line is a hard-won platform fact. Violating any of these has cost a real build before.

- init FIRST: `railway deploy -t <slug>` provisions into the CURRENTLY LINKED project — fresh deploys of a published template start with `railway init --name X --workspace "<ws>"` (quirk 40a).
- Literal-valued variables are STRIPPED into required deploy prompts by the draft generator (quirk 45a) — ship literals via startCommand/flags/code defaults, never as variables.
- CLI `railway variables --set` RESOLVES `${{…}}` at set time — store expressions via raw GraphQL `variableUpsert` with the literal `${{…}}` string; raw mutations do NOT trigger redeploys, so sequence + explicit redeploy (quirk 60a/55c).
- healthcheckPath: RELATIVE dotless only (`health`, `api/health`) — leading-slash and dotted paths are BAD_USER_INPUT (quirk 60b); audit it nested under `deploy.healthcheckPath` in the draft.
- Config changes via `serviceInstanceUpdate` need a FRESH deploy — plain `railway redeploy` replays the OLD snapshot; use `railway redeploy --from-source --yes` (quirk 60f/31c).
- Image-service startCommands are exec'd WITHOUT a shell: wrap in `sh -c 'VAR=lit exec <cmd>'` or the deploy dies FAILED with zero logs (quirk 55a).
- better-sqlite3: install with `npm ci --omit=dev --ignore-scripts` + a `require(':memory:')` smoke test in the Dockerfile (quirk 33a).
- Never ship a literal `PORT` variable — the runtime injects PORT; a literal fights it AND becomes an accidental prompt (quirk 28a).
- The shared builder queue holds builds 15–25 min under load — queued, not stuck (quirk 30d).
- Digest-pin every registry pull: `FROM node:22-alpine@sha256:<digest>`; ExposedPorts lies — trust runtime logs (quirk 42b).
- `railway delete -p <project-id> -y` needs the project ID (quirk 30a); project creation is rate-limited 1/30 s (quirk 61h).
- Template publish readme cap = 10,000 chars; zero `<angle brackets>`; description hard cap 75 chars (quirk 60g).
- Slugs come from the project name (40-char cap, plain spaces — em-dashes break slugification); a code held by ANY record mangles publishes to an 18-char `-N` uniquifier (quirks 60d/52b).
- Published configs are FROZEN at draft time; `templates publish` updates metadata only (quirk 52a) — config fixes need a regenerated draft from a fixed source project.
- TCP proxies serialize into the draft only if created on the source service BEFORE `templates create` (quirk 55e); volumes via `volumeMounts`; a source domain serializes as `<hasDomain>` (quirk 32a).
- `templateGenerate` refuses if ANY service in the project lacks a usable source — stray sourceless experimental services block the draft; `railway service delete -s X -e <env> -p <proj> -y` cleans them.
- Repo-source format: bare `owner/name` — `github.com/owner/name` fails with a misleading App-install error (quirk 64).
- `railway service source connect --repo <owner>/<repo> --branch main` (account-auth CLI) validates the App grant; workspace tokens are rejected on this subcommand.
- DeepSeek streaming: citations ride server-side annotation deltas (NOT message.annotations); thinking rides `delta.reasoning_content`; server-tool counters in `usage.server_tool_use` (quirks 46a/50d/50e).
- DeepSeek sometimes ends a stream early (~20–200 tokens, thinking never engaged, finish=stop) — SAME payload re-issued works; retry the call (measured 2026-11-22).
- MSYS Git-Bash mangles `/data`-style args → `MSYS_NO_PATHCONV=1`; Git Bash `/tmp` ≠ Node `/tmp` — pass file paths workspace-relative (quirk 47g).
- GraphQL payloads with `${{…}}` or quotes: write to a file, pass via file (quirk 47g).
- Schema drift is real: `viewer`, `Service.instances`, `Service.volumes`, `ServiceInstance.tcpProxies` are GONE — introspect before trusting old snippets (quirk 62f); enums reject quoted values (quirk 47c).
- A deploy's HTTP domain + a TCP proxy can co-host the SAME application port (quirk 61g).
- Secrets never in logs/trajectory: inject via env, reference as `$VAR` in commands, redact known values + PAT-in-URL patterns on every log/SSE boundary.
