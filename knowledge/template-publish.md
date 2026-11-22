# Template publish — project to marketplace to verified deploy

Distilled from the publish SOP of 57+ published templates.

## Preconditions (check, don't assume)
1. GitHub repo is PUBLIC and pushed.
2. A deployed, verified Railway project exists.
3. The app service source is connected: `railway service source connect --repo <owner>/<repo> --branch main --service <svc>` (account-auth CLI; workspace tokens are rejected on this subcommand). Connecting triggers a build — let it settle before generating the draft.
4. The project must have NO sourceless services: `templateGenerate` (behind `railway templates create`) validates EVERY service in the project — one stray sourceless service (e.g. created by an experimental mutation) blocks the draft with "Service X does not have a source that can be used to generate a template".

## Generate + audit the draft
```bash
railway templates create --project <id>     # returns draft id + code + editorUrl
```
Audit `serializedConfig` (the `config` field comes back near-empty) BEFORE publishing:
- App service `source.repo` is your repo (image sources ship faceless, non-updatable services).
- **Zero deploy prompts**: every variable carries a `defaultValue`. Expression values (`${{secret(24)}}`, `${{Ref.VAR}}`, cross-service refs) survive as defaultValues; LITERAL values get STRIPPED into required prompts (quirk 45a) — bake literals into the startCommand or code defaults instead, then regenerate the draft.
- Volumes mounted (`volumeMounts`), domains marker (`networking.serviceDomains: {"<hasDomain>":{}}`) — a domain must exist on the source project BEFORE `templates create`, or template deploys get no public domain.
- TCP proxies serialize from `networking.tcpProxies` — create them on the source service BEFORE the draft.
- healthcheckPath present and RELATIVE dotless (`health` / `api/health`).
- There is NO template-config-edit mutation — fix the SOURCE project, then regenerate the draft.

## Publish
```bash
railway templates publish <code> --category <Cat> \
  --description "<=75 chars exactly enforced" \
  --readme "$(cat TEMPLATE_OVERVIEW.md)"
```
- Categories: AI/ML, Analytics, Authentication, Automation, Blogs, Bots, CMS, Observability, Other, Starters, Storage, Queues.
- Re-running the same command UPDATES the listing (readme/description/category are metadata; the serializedConfig is FROZEN at draft-generate time — config changes need a regenerated draft published as a new record).
- README cap: 10,000 chars, zero `<angle brackets>`.
- Slug comes from the project/template NAME at draft/publish time (40-char cap, em-dash traps: use plain spaces). A code held by any existing record (published, unpublished, or tombstoned) mangles the new publish's slug to an 18-char `-N` uniquifier — reclaim slugs by unpublish+delete first, then republish.

## Verify 2/2 fresh deploys FROM the published template
```bash
mkdir verify && cd verify
railway init --name <slug>-verify-N --workspace "<workspace>"   # FIRST — deploy provisions into the CURRENTLY LINKED project
MSYS_NO_PATHCONV=1 railway deploy -t <code> [-v "Service.KEY=value"] </dev/null
```
- ALWAYS `</dev/null`: missing required prompts hang silently with no TTY and abort without it. Zero-prompt templates need no `-v`.
- Each verify instance: newest deployment SUCCESS (healthcheck-gated), `/health` 200, one state-touching call, one authenticated round-trip. Delete throwaways: `railway delete -p <project-id> -y`.
- Deploy form variable overrides: `-v "ServiceName.KEY=value"`.
