// src/promptgen.js — builder system prompt: role + RUNTIME-LOADED knowledge pack
// + idea context + tool contract. The knowledge/ directory ships markdown
// distillations of 50+ published-template ops workflows (railway-deploy,
// template-publish, repo-setup, platform quirks, ease-of-use contract) and is
// loaded at BUILD-RUN time — updating the pack changes agent behavior without
// code changes. Per-file injection is capped to respect context limits; the
// pack version (sha256 of the concatenation) is recorded on the build row.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');
const KNOWLEDGE_CAP = 4096; // chars per file injected into the system prompt

// ---------- knowledge pack loader (runtime, not baked) ----------
function loadKnowledgePack() {
  const out = [];
  let versionInput = '';
  let files = [];
  try { files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith('.md')).sort(); } catch (e) { files = []; }
  for (const f of files) {
    let content = '';
    try { content = fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8'); } catch (e) { /* skip */ }
    versionInput += `${f}\u0000${content}\u0000`;
    let body = content.trimEnd();
    let note = '';
    if (body.length > KNOWLEDGE_CAP) {
      body = `${body.slice(0, KNOWLEDGE_CAP)}\n…[truncated for context budget — full file lives in knowledge/${f} on the builder instance]`;
      note = ' (truncated)';
    }
    out.push({ file: f, chars: content.length, injected: body.length, note, body });
  }
  const version = crypto.createHash('sha256').update(versionInput).digest('hex').slice(0, 12);
  return { version, files: out };
}

function knowledgeVersion() {
  return loadKnowledgePack().version;
}

// ---------- publish SOP (build-specific, stays in code) ----------
const PUBLISH_SOP = `PUBLISH SOP (execute in this exact order via run_shell):
1. Finalize the repo in your workspace: source + Dockerfile (or package.json with start script) + railway.json + README.md + TEMPLATE_OVERVIEW.md.
2. git init -b main; git add -A; commit with -c user.name/user.email flags (identity: "Template Builder" / "builder@users.noreply.github.com").
3. Create the GitHub repo (public) under $GH_LOGIN:
   curl -s -X POST https://api.github.com/user/repos -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -d '{"name":"<repo-name>","private":false,"description":"<=100 chars"}'
   Use https://x-access-token:$GITHUB_TOKEN@github.com/$GH_LOGIN/<repo-name>.git as the push URL. NEVER echo $GITHUB_TOKEN or $RAILWAY_TOKEN.
4. git push the URL from step 3.
5. cd to your workspace, then: railway init --name <project-slug> --workspace <RAILWAY_WORKSPACE_ID>  (project-slug = the marketplace slug, max 40 chars, lowercase-hyphenated, NO em-dashes; the publish claims this slug. The --workspace flag is REQUIRED when the token is workspace-scoped or multiple workspaces exist — the exact id is in the environment facts below.)
6. railway up  (deploys the workspace; watch it until SUCCESS — use railway status / railway logs; the deploy is healthcheck-gated by your railway.json)
7. Verify health: curl -s https://<RAILWAY_PUBLIC_DOMAIN-of-the-service>/health (find the domain via railway status --json); expect HTTP 200.
8. railway templates create --project <project-id>  (creates the draft from the deployed project — it prints the draft code; the project must contain NO sourceless services)
9. Audit the draft serializedConfig BEFORE publishing: every variable carries a defaultValue (zero prompts), volumeMounts + hasDomain + tcpProxies captured, healthcheckPath relative-dotless. If a literal got stripped into a prompt, fix the SOURCE (bake it into the startCommand), regenerate the draft, re-audit.
10. railway templates publish <code> --readme "$(cat TEMPLATE_OVERVIEW.md)" --description "<=75 chars" --category "<best-fit>"
11. Confirm the live URL https://railway.com/deploy/<slug> resolves and finish with the RESULT line (see OUTPUT CONTRACT).`;

const EASE_OF_USE_NOTE = `The full EASE-OF-USE REQUIREMENTS block is in the knowledge pack below (knowledge/ease-of-use.md) — it is BINDING for everything you ship: deploy-form design, guided states, healthcheck gating, error shapes, listing contract, verification.`;

function buildSystemPrompt(ctx) {
  // ctx: { idea, workspace, ghLogin, resume, provider, railwayScope, railwayWorkspaceId }
  const resumeNote = ctx.resume
    ? '\n\nRESUME: a previous run of this build stopped early (cap/timeout/error). Your workspace ALREADY EXISTS with prior files — inspect it first (list_dir, read_file), do not redo finished work, and continue toward the publish SOP. IMPORTANT: if the publish SOP already completed (repo pushed AND template published), do NOT keep improving — finish immediately with the RESULT line.'
    : '';
  const pack = loadKnowledgePack();
  const knowledge = pack.files.length
    ? `\n===== KNOWLEDGE PACK v${pack.version} (${pack.files.length} files — distillation of 50+ published-template ops workflows) =====\n` +
      pack.files.map((f) => `\n----- knowledge/${f.file} (${f.chars} chars${f.note}) -----\n${f.body}`).join('\n') +
      '\n===== END KNOWLEDGE PACK ====='
    : '\n===== KNOWLEDGE PACK: not found on this instance — proceeding on the in-prompt rules only =====';

  return `You are the Template Builder agent. Your job: turn the user's app idea into a COMPLETE working repo in your workspace, deploy it on Railway with the bundled CLI, and PUBLISH it as a one-click Railway template on the user's account, ending with the live template URL. (Reasoning engine: ${ctx.provider || 'the configured LLM provider'} — you act through the same function-calling tools regardless of provider.)

USER IDEA (verbatim):
${String(ctx.idea).slice(0, 4000)}

ENVIRONMENT FACTS:
- Your workspace sandbox root: ${ctx.workspace} — run_shell cwd and every write_file path are jailed here. Relative paths are relative to it.
- Git, curl, and the Railway CLI (railway) are on PATH. Node 22 + npm available.
- Credentials injected into EVERY run_shell env: $GITHUB_TOKEN (classic PAT, repo scope), $RAILWAY_TOKEN (${ctx.railwayScope || 'account'} token). Your GitHub login: ${ctx.ghLogin}.${ctx.railwayScope === 'workspace' ? ` The Railway token is WORKSPACE-scoped: every railway command must carry --workspace ${ctx.railwayWorkspaceId || '<workspace-id-from-facts>'} (or RAILWAY_WORKSPACE_ID env) — commands without it fail or hang on a workspace picker. Note: a few account-context subcommands (railway status, service source connect) reject workspace tokens — route around them via railway api GraphQL or work project-scoped.` : ''} NEVER print, cat, or echo these variables' values; never write them into files; never put them in git remotes except the x-access-token push URL pattern in the SOP below (which is auto-redacted from logs anyway).
- Pick a repo name = marketplace slug (lowercase-hyphenated, <= 40 chars). Project name for railway init = the same slug.${ctx.railwayWorkspaceId ? `\n- RAILWAY_WORKSPACE_ID=${ctx.railwayWorkspaceId}` : ''}
${knowledge}

${EASE_OF_USE_NOTE}

${PUBLISH_SOP}

HARD RULES:
- Secrets never appear in logs, commit messages, README, or tool outputs. If a command ever would print one, re-run it with output redirected.
- Do not fabricate URLs. The RESULT line values must come from real command output (railway templates publish prints the record; railway status --json carries the domain).
- If a step fails, diagnose from the actual output (railway logs, curl -i) and retry once with a fix; do not loop more than 3 attempts on the same step — note the failure and continue.
- Keep the repo small: no binaries over 2 MB, no vendored secrets, .gitignore node_modules/.env.
- Total effort budget: stay within your turn cap; write files once, verify, publish. When the SOP is complete, STOP improving and emit the RESULT line.

OUTPUT CONTRACT (mandatory final message, after the publish SOP completes):
Finish your FINAL assistant message with exactly one line:
RESULT: template_url=<https://railway.com/deploy/<slug>> repo_url=<https://github.com/<login>/<repo>> health=<passed|failed> notes=<one sentence>
${resumeNote}`;
}

module.exports = { buildSystemPrompt, knowledgeVersion, loadKnowledgePack, PUBLISH_SOP };
