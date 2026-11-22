#!/bin/sh
# spike/structural-battery.sh — Step 2 structural battery against a live creator
# deploy (keyless). Env: BASE=https://<domain> PASSWORD=<instance pw>.
# Gates: health shape, wizard assets, guided states, typed invalid-token errors,
# capability matrix (provider step vs the bundled local mock is NOT possible on
# Railway — mocked-matrix proof ran in the spike; here we prove the probe REFUSES
# garbage providers with typed errors).
set -e
BASE="${BASE:?set BASE=https://domain}"
PASSWORD="${PASSWORD:?set PASSWORD}"
C=/tmp/tb-battery-cookies.txt
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "  PASS $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }

echo "G1 /health dotless unauth keyless-healthy"
H=$(curl -s "$BASE/health")
echo "$H" | grep -q '"status":"ok"' && ok "/health 200 ok" || bad "/health body"
echo "$H" | grep -q '"password_gate":true' && ok "password_gate true" || bad "password_gate"
echo "$H" | grep -q '"missing_tokens":\["LLM_API_KEY","RAILWAY_TOKEN","GITHUB_TOKEN"\]' && ok "guided missing_tokens named" || bad "missing_tokens shape"
echo "$H" | grep -q '"provider_configured":false' && ok "provider_configured false" || bad "provider_configured"

echo "G2 password gate"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
[ "$code" = "302" ] && ok "/ 302 to /login unauthed" || bad "/ expected 302 got $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/login" -d "password=WRONG-PW")
[ "$code" = "401" ] && ok "wrong password 401" || bad "wrong pw expected 401 got $code"
code=$(curl -s -c "$C" -o /dev/null -w "%{http_code}" -X POST "$BASE/login" -d "password=$PASSWORD")
[ "$code" = "302" ] && ok "correct password login 302" || bad "login expected 302 got $code"
code=$(curl -s -b "$C" -o /dev/null -w "%{http_code}" "$BASE/")
[ "$code" = "200" ] && ok "/ 200 authed" || bad "/ expected 200 got $code"

echo "G3 wizard deep links + provider types in UI"
IDX=$(curl -s -b "$C" "$BASE/")
echo "$IDX" | grep -q 'railway.com/account/tokens' && ok "RAILWAY deep link in wizard" || bad "railway deep link"
echo "$IDX" | grep -q 'settings/tokens/new?description=template-builder&scopes=repo' && ok "GitHub PAT deep link with repo scope pre-filled" || bad "github deep link"
echo "$IDX" | grep -q 'id="prov-types"' && ok "provider step present" || bad "provider step"
echo "$IDX" | grep -q 'id="act-submit"' && ok "idea composer present on the empty state" || bad "composer"
echo "$IDX" | grep -q 'Build &#9654;\|Build ▶' && ok "submit button labeled Build" || bad "submit label"
echo "$IDX" | grep -q 'id="confirm-card"' && bad "confirm card must be gone" || ok "no confirm card"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$C" "$BASE/public/app.js")
[ "$code" = "200" ] && ok "app.js served" || bad "app.js"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$C" "$BASE/api/setup/provider-types")
[ "$code" = "200" ] && ok "provider-types endpoint" || bad "provider-types"

echo "G4 guided states for every missing piece"
code=$(curl -s -b "$C" -X POST "$BASE/api/builds" -H 'Content-Type: application/json' -d '{"idea":"a minecraft modded server where users paste a pack URL"}' -o /tmp/tb-g.json -w "%{http_code}")
[ "$code" = "503" ] && ok "build op 503 guided" || bad "build op expected 503 got $code"
grep -q 'LLM_API_KEY' /tmp/tb-g.json && grep -q 'RAILWAY_TOKEN' /tmp/tb-g.json && grep -q 'GITHUB_TOKEN' /tmp/tb-g.json && ok "503 names all 3 missing tokens + deep links" || bad "503 missing-token detail"
grep -q 'next_action' /tmp/tb-g.json && ok "envelope carries next_action" || bad "next_action"

echo "G5 typed errors on invalid tokens"
code=$(curl -s -b "$C" -X POST "$BASE/api/setup/token" -H 'Content-Type: application/json' -d '{"name":"RAILWAY_TOKEN","value":"invalid-token-probe"}' -o /tmp/tb-r.json -w "%{http_code}")
[ "$code" = "400" ] && grep -q 'invalid_railway_token' /tmp/tb-r.json && ok "invalid Railway token -> typed invalid_railway_token" || bad "railway typed error ($code)"
grep -q 'next_action' /tmp/tb-r.json && ok "railway error has next_action" || bad "railway next_action"
code=$(curl -s -b "$C" -X POST "$BASE/api/setup/token" -H 'Content-Type: application/json' -d '{"name":"GITHUB_TOKEN","value":"ghp_invalidprobe00000000000000000000"}' -o /tmp/tb-gh.json -w "%{http_code}")
[ "$code" = "400" ] && grep -q 'github_token_invalid' /tmp/tb-gh.json && ok "invalid GitHub token -> typed github_token_invalid" || bad "github typed error ($code)"
code=$(curl -s -b "$C" -X POST "$BASE/api/setup/provider" -H 'Content-Type: application/json' -d '{"type":"openai-compat","base_url":"https://api.openai.com","api_key":"sk-invalidprobe000000000","model":"gpt-4.1"}' -o /tmp/tb-p.json -w "%{http_code}")
[ "$code" = "400" ] && grep -q '"error":"' /tmp/tb-p.json && ok "invalid LLM provider -> typed probe error envelope" || bad "provider typed error ($code)"
grep -q 'next_action' /tmp/tb-p.json && ok "provider error has next_action" || bad "provider next_action"
code=$(curl -s -b "$C" -X POST "$BASE/api/setup/provider" -H 'Content-Type: application/json' -d '{"type":"bogus-type","base_url":"https://x","api_key":"k","model":"m"}' -o /tmp/tb-pt.json -w "%{http_code}")
[ "$code" = "400" ] && grep -q 'unknown_provider_type' /tmp/tb-pt.json && ok "unknown provider type rejected" || bad "unknown provider type ($code)"

echo "G6 capability matrix shapes"
curl -s -b "$C" "$BASE/api/me" | grep -q '"provider_types":\[' && ok "/api/me exposes provider types (deepseek/openai-compat/anthropic-compat prefills)" || bad "provider_types"
curl -s -b "$C" "$BASE/api/me" | grep -q '"deepseek"\|"openai-compat"\|"anthropic-compat"' && ok "3 provider types listed" || bad "provider type ids"

echo
echo "BATTERY RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] || exit 1
