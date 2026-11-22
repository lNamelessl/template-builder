# Railway deploy — CLI field manual

Distilled from 50+ published-template deployments. Check `railway <cmd> --help` before guessing flags; subcommands are nested (`railway variables delete`, not `--delete`).

## Auth + workspace
- `railway whoami` first. Multiple workspaces exist on this account: EVERY non-interactive `railway init` needs `--workspace "<workspace name>"` (or the workspace ID), and every deploy/redeploy targeting a specific project needs `--project <id>`.
- Workspace tokens (`rlwy_wksp_…`) work for project-scoped commands but are REJECTED by account-context commands (`railway status`, `service source connect`, `githubRepos` queries). Use the account-auth CLI for those.
- Bare `owner/name` is the ONLY working repo format in source mutations — `github.com/owner/name` fails with a misleading "Railway GitHub App is not installed" error.

## Standard deploy flow
```bash
railway init --name <slug> --workspace "<workspace>"
railway variables --set 'KEY=${{Ref.KEY}}' --service <svc>   # single-quote ${{}} so bash does not expand
railway up --service <svc>                                   # builds take minutes: background + poll
railway domain                                               # public URL (once per service)
railway logs -b -s <svc>   # build logs
railway logs -d -s <svc>   # deploy/runtime logs
railway logs <deployment-id>   # a specific deployment
```
- `railway variables --set` TRIGGERS a redeploy; add `--skip-deploy` when you will redeploy deliberately.
- CLI `--set` RESOLVES `${{…}}` expressions into literals at set time — to STORE an expression (e.g. `${{secret(24)}}`) use raw GraphQL `variableUpsert` with the literal `${{…}}` string.
- `railway variables delete` / raw `variableDelete` do NOT trigger redeploys — sequence deletes then an explicit `railway redeploy` (or `railway redeploy --from-source` when instance-config changes like startCommand/healthcheckPath must apply).

## Verify a deploy (never trust status alone)
1. `railway deployment list` → the NEWEST deployment is SUCCESS (an older one can serve while the new one failed).
2. `curl -s -o /dev/null -w "%{http_code}" https://<domain>/<health>` → 200.
3. Hit one endpoint that touches the database/state — 500 usually means migrations never ran.

## Failure triage ladder
- FAILED with ZERO logs before "Starting Container" → the start command is not exec-able (image startCommands run WITHOUT a shell — wrap: `startCommand: "sh -c '…'"`).
- FAILED at "Mounting volume" → volume/route problem.
- CRASHED after start → app error: read deploy logs.
- Build shows "No start command detected" → Railwaypack autodetect missed your Dockerfile: it must be at the repo ROOT (or set `build.dockerfilePath`).
- BuildKit mounts (`RUN --mount=type=bind/cache`) rejected on the Metal builder → rewrite as COPY+RUN layers.
- Healthcheck 307 redirect marking deploy FAILED → Railway strips trailing slashes; expose a redirect-free root-level health route.
- Crash-loop at boot with a validation traceback → a strict env validator rejected a value; fix the value, don't fight the schema.
- Builder queue holds 15–25 min under platform load → queued, not stuck; wait before diagnosing.
- `railway ssh -s <svc> -- <cmd>` for in-container state (needs `ssh-keygen` + `railway ssh keys add` once).

## railway.json (ship always; keep CMD identical to startCommand)
```json
{ "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE" },
  "deploy": { "healthcheckPath": "api/health", "healthcheckTimeout": 300,
              "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10 } }
```
healthcheckPath is RELATIVE and DOTLESS — the platform rejects leading-slash and dotted paths. railway.json alone may not merge into an EXISTING service's config: apply `serviceInstanceUpdate(healthcheckPath)` AND follow with a fresh code deploy.
