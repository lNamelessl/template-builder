# Ease of use — the binding deploy-form and first-run contract

EASE-OF-USE REQUIREMENTS (binding):
1. Deploy form: ZERO required prompts; at most ONE (a single user-owned credential, description phrased as an instruction with its exact source URL).
2. Every generated secret/credential: defaultValue = `${{secret(24)}}` (or base64/hex variants); NEVER literals — bake literals into startCommand instead.
3. Never prompt for PORT, domains, TCP-proxy hosts, DB URLs, or anything derivable at runtime (use `${{Ref.VAR}}` / RAILWAY_* / baked defaults like `${MEMORY:-4G}`).
4. Missing-credential state = guided state: setup page (200, healthy) + loud deploy-log banner naming the exact next action; setting it auto-recovers; no crash loops.
5. First login self-served: per-deploy creds in deploy logs under a loud banner AND on the volume; marker-guarded seed that never re-fires; banner says change-it-now.
6. Healthcheck-gate every service: dotless, unauth, 2xx route; targetPort pinned; volume paths don't shadow app dirs; secret-bearing paths deny-all.
7. User-facing errors = plain cause + exact next action + link; typed envelopes for anticipated failures; no raw tracebacks outside logs.
8. Unconfigured-to-connecting-to-ready progress visible; recovery from degraded/reclaimed is one click.
9. Listing: pitch + deploy button above the fold; numbered 5-step-or-less "after deploying" quickstart; per-credential sourcing table; measured honest-limits table; the six validator headings exactly, unwrapped.
10. Verify 2/2 fresh deploys FROM the published template (`railway init` first, stdin closed) exercising the zero-prompt path end to end.

## Anti-patterns (each one shipped a real outage)
- Multi-prompt deploy forms (5–7 fields) — every field drops deploy success; zero-prompt is the differentiator.
- Crash-loop on missing config instead of a guided setup state.
- Image startCommands without the `sh -c '…'` wrap — instant FAILED, zero logs, undiagnosable for the user.
- Authenticated or dotted healthcheck paths — the probe gets 401/403 and the deploy marks failed.
- Raw tracebacks, bare error codes, or "Something went wrong" toasts in user-facing surfaces.
- Unguarded seeds that re-fire on restart, or default creds shipped without a change-it-now instruction.
- Volumes mounted over app directories; secrets world-readable on volumes (secret-bearing paths get deny-all routes).
- Variable descriptions left empty at draft time (unfixable post-publish).
- Trusting image metadata (ExposedPorts lies) — verify the runtime listening port from deploy logs.

## Listing validator contract
End TEMPLATE_OVERVIEW.md with EXACTLY these headings, unwrapped, never inside a fenced block:
`# Deploy and Host` → `## About Hosting` → `## Why Deploy` → `## Common Use Cases` → `## Dependencies for` → `### Deployment Dependencies`.
Above them: one-line pitch, deploy button, numbered quickstart, sourcing table (value | where the user gets it | where it lands), honest-limits table with measured numbers (never vendor benchmarks).
