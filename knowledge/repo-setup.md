# GitHub repo setup — create + push without gh CLI

## Create via API (stored Git Credential Manager credentials)
Probe stored credentials non-interactively:
```bash
export GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0
printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed 's/password=.*/password=REDACTED/'
```
If `username=` + `password=` come back, the stored token can create repos:
```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep '^password=' | cut -d= -f2)
curl -s -X POST https://api.github.com/user/repos -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"name":"<repo>","description":"<=100 chars","private":false,"auto_init":false}'
```
201 = created; 422 + "already_exists" = exists (verify with GET /repos/<owner>/<repo>). NEVER echo the token; redact in all output.

## Push
```bash
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```
Git identity: commit with `-c user.name="<name>" -c user.email="<email>"` flags (never global config).
- Node-side scripts: Git Bash `/tmp` ≠ Node `/tmp` — always pass file paths as workspace-relative, never `/tmp/...` (Node resolves `/tmp` to `C:\tmp` on Windows).
- File contents through the GitHub contents API: PUT with the file's `sha` for updates; base64 the content.

## Repo hygiene before publishing
- `.gitignore`: node_modules, .env, state dirs, logs, local diagnostic artifacts.
- `.gitattributes`: `*.sh text eol=lf` + Dockerfile LF (CRLF breaks Linux entrypoints).
- No secrets, no binaries over 2 MB, no diagnostic scratch files in the published tree.
- Classic PAT scopes: `repo` covers repo create/push; GHCR image pushes additionally need `write:packages` (repo scope is NOT enough).
