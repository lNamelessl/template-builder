#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Modpack Paste Server -- Railway supervisor
#
# Responsibilities:
#   1. always answer GET /health with 200 so the platform healthcheck is gated
#      on the supervisor, never on a 400 MB modpack download
#   2. expose GET /ready (200 only once the Minecraft server actually booted)
#      and a human status page at /
#   3. translate MODPACK_URL (Modrinth or CurseForge) into itzg/minecraft-server
#      env, with guided states when a credential is missing
#   4. seed a per-deploy RCON password, print it once in a loud log banner and
#      keep it on the volume with a marker so it is never regenerated
#   5. exec the upstream itzg start script so signals reach the JVM
# ---------------------------------------------------------------------------
set -uo pipefail

DATA_DIR="${DATA_DIR:-/data}"
WWW_DIR="${WWW_DIR:-/opt/railway/www}"
HTTP_PORT="${PORT:-8080}"
MC_PORT="${SERVER_PORT:-25565}"
BOOT_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$DATA_DIR" "$WWW_DIR" 2>/dev/null || true

say() { printf '%s [paste-server] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

banner() {
  # $1 = headline, remaining args = body lines
  printf '\n' >&2
  printf '============================================================\n' >&2
  printf '  %s\n' "$1" >&2
  printf '============================================================\n' >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  printf '============================================================\n\n' >&2
}

write_state() {
  local phase="$1"; shift
  local detail="$*"
  printf '%s\n' "$phase" > "$DATA_DIR/.railway-phase" 2>/dev/null || true
  {
    printf 'phase: %s\n' "$phase"
    printf 'detail: %s\n' "$detail"
    printf 'memory: %s\n' "${MEMORY:-6G}"
    printf 'pack: %s\n' "${MODPACK_URL:-not-set}"
    printf 'game_port: %s\n' "$MC_PORT"
    printf 'booted_at: %s\n' "$BOOT_TS"
    printf 'updated_at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$WWW_DIR/health" 2>/dev/null || true
  say "phase=${phase} :: ${detail}"
}

# ---------------------------------------------------------------------------
# HTTP status surface (busybox httpd serving static files, zero external calls)
#   /health -> always present = 200 liveness
#   /ready  -> created on boot = 200 readiness, 404 until then
#   /       -> human status page
# Two listeners are used on purpose: $PORT (what the platform routes to) and
# 8080 (what EXPOSE advertises), so a port mismatch can never fail the deploy.
# ---------------------------------------------------------------------------
start_http() {
  local p seen
  seen=" "
  for p in "$HTTP_PORT" 8080; do
    case "$seen" in
      *" $p "*) continue ;;
    esac
    seen="$seen$p "
    busybox httpd -f -p "$p" -h "$WWW_DIR" >/dev/null 2>&1 &
  done
  sleep 1
  if busybox wget -q -O /dev/null "http://127.0.0.1:${HTTP_PORT}/health" 2>/dev/null; then
    say "status page + healthcheck listening on :${HTTP_PORT}"
  else
    say "WARN health probe on :${HTTP_PORT} did not answer (continuing anyway)"
  fi
}

# ---------------------------------------------------------------------------
# Guided states: stay alive and healthy so the deploy succeeds and the operator
# can fix a variable instead of watching a crash loop.
# ---------------------------------------------------------------------------
hold_healthy() {
  write_state "$1" "${*:2}"
  while :; do sleep 3600; done
}

trim() { printf '%s' "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# ---------------------------------------------------------------------------
# Pack resolution: MODPACK_URL -> itzg env
# ---------------------------------------------------------------------------
resolve_pack() {
  local url slug
  url="$(trim "${MODPACK_URL:-}")"

  if [ -z "$url" ]; then
    banner "SETUP NEEDED: no modpack URL yet" \
      "MODPACK_URL is empty, so no Minecraft server was started." \
      "This status page is live and the deploy is healthy." \
      "" \
      "1. Open this service in Railway, then the Variables tab" \
      "2. Set MODPACK_URL to a pack page, for example:" \
      "     https://modrinth.com/modpack/fabulously-optimized" \
      "3. Railway redeploys by itself and the pack installs automatically" \
      "" \
      "CurseForge links also work, but they need CF_API_KEY (see the listing)."
    hold_healthy needs_pack "waiting for MODPACK_URL"
  fi

  case "$url" in
    *curseforge.com*)
      slug="$(printf '%s' "$url" | sed -n 's#.*curseforge\.com/minecraft/modpacks/\([^/?#]*\).*#\1#p')"
      [ -z "$slug" ] && slug="$(printf '%s' "$url" | sed -n 's#.*curseforge\.com/minecraft/mc-mods/\([^/?#]*\).*#\1#p')"

      if [ -z "${CF_API_KEY:-}" ]; then
        banner "SETUP NEEDED: CurseForge needs your own API key" \
          "Detected CurseForge pack: ${url}" \
          "CurseForge blocks anonymous downloads and its API keys may not be" \
          "shared, so this deploy needs YOUR key. No server was started." \
          "" \
          "1. Go to https://console.curseforge.com/ and sign in" \
          "2. Open API Keys and create a key for this project" \
          "3. In Railway: this service, Variables, add CF_API_KEY = your key" \
          "4. Railway redeploys and the pack installs automatically" \
          "" \
          "Some packs disable third-party downloads. If yours does, the pack" \
          "author has to re-enable them, or use the pack's Modrinth mirror."
        hold_healthy needs_credential "CurseForge pack requires CF_API_KEY"
      fi

      export TYPE="AUTO_CURSEFORGE"
      export CF_PAGE_URL="$url"
      export CF_API_KEY
      export CF_PARALLEL_DOWNLOADS="${CF_PARALLEL_DOWNLOADS:-4}"
      say "resolved CurseForge pack slug=${slug:-unknown} via AUTO_CURSEFORGE"
      ;;

    *modrinth.com*|*mrpack*)
      export TYPE="MODRINTH"
      export MODRINTH_MODPACK="$url"
      if [ -n "${MODPACK_VERSION:-}" ]; then
        export MODRINTH_VERSION="$MODPACK_VERSION"
        say "pinning Modrinth version ${MODPACK_VERSION}"
      fi
      say "resolved Modrinth pack ${url} via TYPE=MODRINTH"
      ;;

    *)
      if printf '%s' "$url" | grep -q '://'; then
        banner "SETUP NEEDED: unsupported pack URL" \
          "MODPACK_URL is: ${url}" \
          "This template installs Modrinth and CurseForge packs only." \
          "" \
          "Use a link that looks like:" \
          "     https://modrinth.com/modpack/fabulously-optimized" \
          "     https://www.curseforge.com/minecraft/modpacks/your-pack" \
          "Then Railway redeploys automatically."
        hold_healthy needs_pack "unsupported pack URL"
      fi
      # bare slug, let Modrinth resolve it
      export TYPE="MODRINTH"
      export MODRINTH_MODPACK="$url"
      say "resolved bare Modrinth slug '${url}'"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Per-deploy RCON credential (marker-guarded seed, printed once)
# ---------------------------------------------------------------------------
seed_rcon() {
  local marker="$DATA_DIR/.rcon-password"
  local source

  if [ -n "${RCON_PASSWORD:-}" ]; then
    RCON_FINAL="$RCON_PASSWORD"
    source="from the RCON_PASSWORD variable"
  elif [ -s "$marker" ]; then
    RCON_FINAL="$(cat "$marker")"
    source="reused from ${marker}, stable across restarts"
  else
    RCON_FINAL="$(set +o pipefail; tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
    printf '%s' "$RCON_FINAL" > "$marker"
    chmod 600 "$marker" 2>/dev/null || true
    source="generated for this deploy"
  fi

  export ENABLE_RCON="TRUE"
  export RCON_PASSWORD="$RCON_FINAL"
  export RCON_PORT="${RCON_PORT:-25575}"

  banner "YOUR RCON CONSOLE PASSWORD (${source})" \
    "password: ${RCON_FINAL}" \
    "" \
    "RCON listens inside the container on port 25575." \
    "Add a Railway TCP proxy to 25575 to connect a console client with this" \
    "password. Change it any time by setting RCON_PASSWORD yourself." \
    "Also stored at /data/.rcon-password on your volume."
}

# ---------------------------------------------------------------------------
# Readiness watcher: /ready flips to 200 only after the JVM prints "Done ("
# ---------------------------------------------------------------------------
watch_ready() {
  local logf="$DATA_DIR/logs/latest.log" i
  for i in $(seq 1 1200); do
    if [ -f "$logf" ] && grep -q 'Done (' "$logf" 2>/dev/null; then
      : > "$WWW_DIR/ready"
      write_state ready "server is up, connect to the TCP proxy on ${MC_PORT}"
      return 0
    fi
    sleep 3
  done
  write_state slow "still not ready after 60 minutes, check the server log"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
start_http
say "modpack paste server supervisor up (memory ${MEMORY:-6G}, game port ${MC_PORT})"

START_SCRIPT=""
for candidate in /image/scripts/start /start; do
  if [ -x "$candidate" ]; then
    START_SCRIPT="$candidate"
    break
  fi
done

if [ -z "$START_SCRIPT" ]; then
  banner "FATAL: upstream start script missing" \
    "Neither /image/scripts/start nor /start exists in this image." \
    "Rebuild from the pinned digest in the Dockerfile."
  hold_healthy broken "upstream start script missing"
fi

write_state booting "supervisor up, validating configuration"
resolve_pack
seed_rcon

export MEMORY="${MEMORY:-6G}"
export SERVER_PORT="$MC_PORT"

watch_ready &
write_state starting "installing pack and booting Minecraft, this can take several minutes"
exec "$START_SCRIPT"
