#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# capstone — boot-and-verify E2E smoke test
#
# Brings the FULL stack up (docker-compose.yml, PBX included), waits for
# health, then verifies the telephony wiring end-to-end:
#
#   Boot
#     • `docker compose -f docker-compose.yml up -d` (idempotent — safe to
#       re-run against an already-running stack)
#     • waits for every main-stack container + freepbx to be healthy
#
#   ARI
#     • ARI user [dograh] present in `ari show users`
#     • Asterisk HTTP server ENABLED on 8088 (the entrypoint flips
#       HTTPENABLED in freepbx_settings so it survives fwconsole reloads)
#     • host-side ARI REST: GET /ari/asterisk/info with the dograh user → 200
#
#   Dialplan
#     • [dograh-inbound] context has exten 8000 → Stasis(dograh)
#     • regression guard: on EVERY agent extension (8000–8007) Stasis() runs
#       BEFORE the voicemail-fallback GotoIf (a GotoIf placed before Stasis
#       always jumps — mailbox unset → hangup — leaving the agent unreachable;
#       every inbound call cleared instantly)
#
#   Softphone WSS
#     • the Control Center's origin forwards /ws to the PBX (101 Switching
#       Protocols) — the path the in-browser softphone registers over. A SPA
#       fallback (200 + index.html) or a 502 here is the regression that shows
#       up as "Registration failed".
#
#   TURN
#     • coturn is running and advertises the box's *current* public IP as its
#       relay address (it auto-detects on start; a stale pinned
#       TURN_EXTERNAL_IP silently makes off-LAN calls carry no audio)
#     • warns when the PBX's external_media_address disagrees with it
#
#   Media WebSocket
#     • websocket_client.conf installed with the dograh URI
#     • res_websocket_client module loaded
#     • if dograh-api is connected to ARI (`ari show apps` lists dograh):
#       verifies a live outbound media WS client appears during the test call
#     • if dograh is NOT connected (its telephony configuration is set in the
#       dograh UI, not in .env), reports WARN with the one manual step needed
#
#   Test call (end-to-end)
#     • originates a call via ARI REST into the dograh inbound path:
#         POST /ari/channels?endpoint=Local/8000@dograh-inbound&app=dograh
#     • asserts the created channel's dialplan is context=dograh-inbound,
#       exten=8000 — i.e. the call routed through the FreePBX inbound route
#       into the dograh Stasis app
#     • asserts the Asterisk lifetime call counter advanced (corroborates that
#       the originate actually entered the dialplan)
#     • hangs the channel back up via ARI REST DELETE
#     • when dograh is connected to ARI, additionally asserts the media
#       WebSocket client connected (the external media leg dograh bridges)
#
# Usage (run from the repo root):
#   ./scripts/smoke-e2e.sh                 # boot + verify everything
#   ./scripts/smoke-e2e.sh --no-boot       # verify only, don't run compose up
#
# Exit code: 0 = all checks passed, 1 = one or more failures.
# Reads DOGRAH_ARI_PASSWORD / DOGRAH_WS_URI from .env.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
COMPOSE_MAIN="$ROOT/docker-compose.yml"
BOOT="${1:-boot}"

# ── colors (only when attached to a tty) ───────────────────────────────────
if [[ -t 1 ]]; then
  C_GREEN=$'\e[32m'; C_RED=$'\e[31m'; C_YELLOW=$'\e[33m'; C_BOLD=$'\e[1m'; C_NC=$'\e[0m'
else
  C_GREEN=''; C_RED=''; C_YELLOW=''; C_BOLD=''; C_NC=''
fi

PASS=0; FAIL=0; WARN=0; SKIP=0
declare -a FAILURES WARNINGS

ts() { date -u +%H:%M:%S; }
log() { printf '%s %s\n' "$(ts)" "$*"; }
pass() { PASS=$((PASS+1)); printf '%s %s[PASS]%s %s\n' "$(ts)" "$C_GREEN" "$C_NC" "$*"; }
warn() { WARN=$((WARN+1)); WARNINGS+=("$*"); printf '%s %s[WARN]%s %s\n' "$(ts)" "$C_YELLOW" "$C_NC" "$*"; }
fail() { FAIL=$((FAIL+1)); FAILURES+=("$*"); printf '%s %s[FAIL]%s %s\n' "$(ts)" "$C_RED" "$C_NC" "$*"; }
skip() { SKIP=$((SKIP+1)); printf '%s %s[SKIP]%s %s\n' "$(ts)" "$C_YELLOW" "$C_NC" "$*"; }
section() { printf '\n%s=== %s ===%s\n' "$C_BOLD" "$*" "$C_NC"; }

# Resolve the freepbx container dynamically — the container_name is
# pbx-freepbx, but a daemon hiccup can leave a differently-named container
# (e.g. <hash>_pbx-freepbx); always prefer the RUNNING one with the label.
freepbx_container() {
  local id
  id=$(docker ps -aq --filter "label=com.docker.compose.service=freepbx" 2>/dev/null)
  for c in $id; do
    if [[ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" == "running" ]]; then
      echo "$c"; return
    fi
  done
  echo "pbx-freepbx" # fallback: the compose container_name
}

FREEPBX="$(freepbx_container)"
ASTERISK="docker exec ${FREEPBX} asterisk -rx"

# Every Dograh agent extension in [dograh-inbound]. They share one dialplan
# shape, so every check below runs across the whole set — a hand-edit that
# fixes 8000 but breaks 8001 must not pass the smoke test.
AGENT_EXTENSIONS="8000 8001 8002 8003 8004 8005 8006 8007"

# ── preflight ──────────────────────────────────────────────────────────────
section "Preflight"
if [[ "$BOOT" == "-h" || "$BOOT" == "--help" ]]; then
  sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi
if [[ "$BOOT" != "boot" && "$BOOT" != "--no-boot" ]]; then
  printf '%s\n' "usage: $0 [boot|--no-boot]" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "[FAIL] docker not installed" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' "[FAIL] docker daemon unreachable" >&2
  exit 1
fi
pass "docker daemon reachable"

if [[ -f "$ENV_FILE" ]]; then
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  pass ".env loaded"
else
  warn ".env not found — ARI REST / test-call checks will be skipped (set DOGRAH_ARI_PASSWORD)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# BOOT
# ═══════════════════════════════════════════════════════════════════════════
if [[ "$BOOT" == "boot" ]]; then
  section "Boot — both composes"
  # Plain `up -d` (no --wait): the health-poll section below does the waiting,
  # and --wait is fragile against containers with renamed instances.
  if docker compose -f "$COMPOSE_MAIN" up -d >/dev/null 2>&1; then
    pass "docker compose up -d issued for both compose files"
  else
    fail "docker compose up failed — run it manually to see the error"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# WAIT FOR HEALTH
# ═══════════════════════════════════════════════════════════════════════════
section "Wait for health (max ~6 min)"
# NOTE: signoz-otel-collector / dograh-api / signoz have NO healthcheck, so
# they report "running" (never "healthy"). "healthy" OR "running" both count.
MAIN_SERVICES="postgres redis minio dograh-api kokoro speaches omniroute n8n grist \
               signoz-metastore-postgres signoz-clickhouse-keeper signoz-clickhouse \
               signoz-otel-collector signoz"
declare -A HEALTHY=()
# One snapshot per poll — `docker compose ps` per service is far too slow.
# Prefers RUNNING containers: a stale container from an earlier daemon hiccup
# can share the same compose label, and `head -1` may pick the dead one.
container_state() { # service → healthy|running|starting|unhealthy|exited|created|missing
  local ids id state h
  ids=$(docker ps -aq --filter "label=com.docker.compose.service=$1" 2>/dev/null)
  [[ -n "$ids" ]] || { echo missing; return; }
  for id in $ids; do
    state=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)
    [[ "$state" == "running" ]] && break   # prefer the live container
  done
  h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null)
  case "$h" in
    healthy) echo healthy ;;
    none)    echo "$state" ;;
    starting) echo starting ;;
    unhealthy) echo unhealthy ;;
    *) echo "$h" ;;
  esac
}

deadline=$(( $(date +%s) + 360 ))
while (( $(date +%s) < deadline )); do
  all_ok=1
  for svc in $MAIN_SERVICES freepbx; do
    [[ "${HEALTHY[$svc]:-}" == "1" ]] && continue
    st=$(container_state "$svc")
    case "$st" in
      healthy|running) HEALTHY["$svc"]=1; log "  ready: $svc ($st)" ;;
      starting) all_ok=0 ;;
      unhealthy) log "  UNHEALTHY: $svc"; all_ok=1 ;; # don't spin; verify will catch it
      missing) all_ok=0 ;;
      exited)  log "  EXITED: $svc"; all_ok=1 ;;
    esac
  done
  if [[ "$all_ok" == "1" ]]; then break; fi
  sleep 10
  log "  ...waiting ($(( deadline - $(date +%s) ))s left)"
done

missing=""
for svc in $MAIN_SERVICES freepbx; do
  [[ "${HEALTHY[$svc]:-}" == "1" ]] || missing="$missing $svc"
done
if [[ -n "$missing" ]]; then
  warn "not ready within 6 min:$missing — continuing to verify (results below will tell)"
else
  pass "all $(( $(echo "$MAIN_SERVICES" | wc -w) + 1 )) containers ready"
fi

# ═══════════════════════════════════════════════════════════════════════════
# ARI
# ═══════════════════════════════════════════════════════════════════════════
section "ARI"

if $ASTERISK "core show version" >/dev/null 2>&1; then
  ver=$($ASTERISK "core show version" 2>/dev/null | head -1)
  pass "Asterisk up: $ver"
else
  fail "asterisk -rx 'core show version' failed — is pbx-freepbx running?"
fi

if $ASTERISK "ari show users" 2>/dev/null | grep -q "dograh"; then
  pass "ARI user [dograh] present"
else
  fail "ARI user [dograh] missing — check pbx/asterisk/ari.conf + entrypoint"
fi

# Retry briefly: right after a compose-up the entrypoint is mid-reload and
# HTTPENABLED may flip a moment after the container reports healthy.
http_ok=false
for _ in $(seq 1 6); do
  if $ASTERISK "http show status" 2>/dev/null | grep -q "Server Enabled"; then
    http_ok=true; break
  fi
  sleep 2
done
if [[ "$http_ok" == "true" ]]; then
  pass "Asterisk HTTP server enabled on 8088"
else
  fail "Asterisk HTTP server NOT enabled — the entrypoint should flip HTTPENABLED in freepbx_settings"
fi

# host-side ARI REST (needs the dograh password from .env)
if [[ -z "${DOGRAH_ARI_PASSWORD:-}" || "$DOGRAH_ARI_PASSWORD" == "CHANGE_ME_ARI_PASSWORD" ]]; then
  skip "ARI REST check — set DOGRAH_ARI_PASSWORD in .env"
else
  ari_body=$(mktemp)
  ari_code=$(curl -sS -o "$ari_body" -w '%{http_code}' --max-time 10 \
    -u "dograh:${DOGRAH_ARI_PASSWORD}" \
    http://127.0.0.1:8088/ari/asterisk/info 2>/dev/null)
  if [[ "$ari_code" == "200" ]] && grep -q '"version"' "$ari_body"; then
    pass "ARI REST /ari/asterisk/info → HTTP 200 (Asterisk $(grep -o '"version":"[^"]*"' "$ari_body" | head -1 | cut -d'"' -f4))"
  else
    fail "ARI REST /ari/asterisk/info → HTTP '$ari_code' (check DOGRAH_ARI_PASSWORD + port 8088 publish)"
  fi
  rm -f "$ari_body"
fi

# ═══════════════════════════════════════════════════════════════════════════
# DIALPLAN
# ═══════════════════════════════════════════════════════════════════════════
section "Dialplan"

dp=$($ASTERISK "dialplan show dograh-inbound" 2>/dev/null)
if echo "$dp" | grep -q "'8000'"; then
  # Stasis app name is dograh_<hex> (generated by dograh) or legacy "dograh"
  if ! echo "$dp" | grep -q "Stasis(dograh"; then
    fail "[dograh-inbound] exten 8000 exists but does not reach a dograh Stasis app"
  else
    pass "dialplan [dograh-inbound] exten 8000 → Stasis app"
    # Regression guard (see de02747): Stasis() must run BEFORE the
    # voicemail-fallback GotoIf. The fallback check placed before Stasis
    # always jumps (mailbox unset → hangup), so Stasis() was unreachable and
    # no dograh agent could ever answer. de02747 fixed exten 8000; every
    # agent extension carries the same block, so guard them all. Compare line
    # positions inside each exten's own block (next marker ends the block).
    guarded=0
    offenders=0
    for ext in $AGENT_EXTENSIONS; do
      echo "$dp" | grep -q "'$ext' =>" || continue
      guarded=$((guarded + 1))
      block=$(echo "$dp" | sed -n "/'$ext' =>/,/'[0-9]\+' =>/p")
      stasis_line=$(echo "$block" | grep -n "Stasis(dograh" | head -1 | cut -d: -f1)
      gotoif_line=$(echo "$block" | grep -n "DOGRAH_VM_MAILBOX.*vm-fallback" | head -1 | cut -d: -f1)
      if [[ -z "$stasis_line" ]]; then
        fail "dialplan exten $ext never reaches Stasis(dograh) — the agent can't answer (fix pbx/asterisk/extensions_custom.conf)"
        offenders=$((offenders + 1))
      elif [[ -n "$gotoif_line" && "$stasis_line" -ge "$gotoif_line" ]]; then
        fail "regression: vm-fallback GotoIf runs before Stasis on exten $ext — calls hang up before the agent answers (fix pbx/asterisk/extensions_custom.conf)"
        offenders=$((offenders + 1))
      fi
    done
    if [[ "$offenders" == "0" ]]; then
      pass "regression guard: Stasis before the vm-fallback GotoIf on all $guarded agent extensions (8000–8007)"
    fi
  fi
else
  fail "[dograh-inbound] context missing — check pbx/asterisk/extensions_custom.conf"
fi

# ═══════════════════════════════════════════════════════════════════════════
# MEDIA WEBSOCKET
# ═══════════════════════════════════════════════════════════════════════════
section "Media WebSocket"

if docker exec "$FREEPBX" test -f /etc/asterisk/websocket_client.conf 2>/dev/null; then
  ws_uri=$(docker exec "$FREEPBX" grep '^uri' /etc/asterisk/websocket_client.conf 2>/dev/null | head -1 | awk '{print $3}')
  pass "websocket_client.conf installed (uri=${ws_uri:-?})"
else
  fail "websocket_client.conf missing — check pbx/asterisk/websocket_client.conf + entrypoint"
fi

if $ASTERISK "module show like res_websocket_client" 2>/dev/null | grep -q "res_websocket_client"; then
  pass "res_websocket_client module loaded"
else
  fail "res_websocket_client not loaded — external media WS unavailable"
fi

dograh_connected=false
if $ASTERISK "ari show apps" 2>/dev/null | grep -q "dograh"; then
  dograh_connected=true
  pass "dograh-api connected to ARI as app 'dograh'"
else
  warn "dograh-api is NOT connected to ARI — its telephony configuration (ARI URL http://127.0.0.1:8088, App Name 'dograh', App Password, WS Client Name) must be set in the dograh UI (Telephony Configurations). Until then the full media loop can't run."
fi

# ═══════════════════════════════════════════════════════════════════════════
# TURN (media relay)
# ═══════════════════════════════════════════════════════════════════════════
section "TURN (media relay)"

COTURN="$(docker ps -q --filter "label=com.docker.compose.service=coturn" 2>/dev/null | head -1)"
if [[ -n "$COTURN" ]]; then
  # The coturn image detects the public IP on every start (detect-external-ip),
  # because behind Docker NAT it cannot know its own WAN address. Compare what
  # the running server actually advertises with what this box resolves to now:
  # a pinned TURN_EXTERNAL_IP that has gone stale is invisible otherwise —
  # calls set up fine and then carry no audio for off-LAN clients.
  detected=$(docker exec "$COTURN" detect-external-ip 2>/dev/null | tr -d '\r\n')
  effective=$(docker exec "$COTURN" sh -c 'tr "\0" " " < /proc/1/cmdline' 2>/dev/null \
    | sed -n 's/.*--external-ip=\([^ ]*\).*/\1/p')
  if [[ -n "$effective" && "$effective" == "$detected" ]]; then
    pass "coturn advertises the detected public IP: --external-ip=$effective"
  elif [[ -z "$effective" ]]; then
    warn "coturn is running without --external-ip — relayed candidates point at the container address, so TURN only works for on-LAN clients"
  else
    fail "coturn advertises --external-ip=$effective but this box's public IP is ${detected:-unknown} — off-LAN media has no relay path (clear TURN_EXTERNAL_IP in .env to auto-detect, then recreate coturn)"
  fi

  # The PBX advertises its own external media address (FreePBX SIP settings).
  # It is managed outside this repo, so a disagreement is a warning, not a
  # failure — but it means RTP and TURN point at different addresses.
  pbx_ext=$(docker exec "$FREEPBX" grep -m1 '^external_media_address=' /etc/asterisk/pjsip.transports.conf 2>/dev/null | cut -d= -f2 | tr -d '\r\n')
  if [[ -n "$detected" && -n "$pbx_ext" && "$detected" != "$pbx_ext" ]]; then
    warn "PBX external_media_address=$pbx_ext disagrees with this box's public IP ($detected) — one of them is stale (fix SIP Settings → NAT in the GUI, or wait for its next reload)"
  fi
else
  skip "coturn not running (docker compose --profile standalone up -d coturn)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# SOFTPHONE WSS (dashboard origin)
# ═══════════════════════════════════════════════════════════════════════════
section "Softphone WSS (dashboard origin)"

# The SPA registers over wss://<dashboard host>/ws, which the dashboard's nginx
# forwards to the PBX's PJSIP WSS listener (dashboard/nginx.conf: location = /ws).
# Browsers refuse the PBX's own :8089 listener (build-time self-signed cert), so
# this proxied path is the only one that works from a browser.
DASHBOARD_URL="${DASHBOARD_URL:-http://127.0.0.1:${DASHBOARD_PORT:-8096}}"
ws_headers=$(curl -sS -o /dev/null -D - --max-time 10 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Protocol: sip" \
  "${DASHBOARD_URL}/ws" 2>/dev/null | head -10)
ws_status=$(printf '%s\n' "$ws_headers" | head -1)
if [[ "$ws_status" == *" 101"* ]]; then
  pass "softphone WSS: ${DASHBOARD_URL}/ws → 101 Switching Protocols (proxied to the PBX)"
  if printf '%s\n' "$ws_headers" | grep -qiE "^Sec-WebSocket-Protocol:[[:space:]]*sip"; then
    pass "softphone WSS: 'sip' subprotocol negotiated"
  else
    warn "softphone WSS: no 'sip' subprotocol on the upgrade — SIP.js may refuse the handshake"
  fi
elif [[ -z "$ws_status" ]]; then
  warn "softphone WSS: ${DASHBOARD_URL}/ws unreachable — start the dashboard (docker compose up -d dashboard) or set DASHBOARD_URL"
else
  fail "softphone WSS: ${DASHBOARD_URL}/ws answered '$ws_status', expected '101 Switching Protocols' — the softphone can't register (check dashboard/nginx.conf 'location = /ws' and that the WSS listener is up)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# TEST CALL (end-to-end)
# ═══════════════════════════════════════════════════════════════════════════
section "Test call (end-to-end)"

if [[ -z "${DOGRAH_ARI_PASSWORD:-}" || "$DOGRAH_ARI_PASSWORD" == "CHANGE_ME_ARI_PASSWORD" ]]; then
  skip "test call — set DOGRAH_ARI_PASSWORD in .env first"
else
  # Lifetime call counter, sampled before/after the test call: a call that
  # never entered the dialplan leaves it unchanged, so it corroborates the
  # ARI assertions below (and is the only call-level signal to report when
  # dograh isn't connected to ARI yet).
  calls_before=$($ASTERISK "core show channels" 2>/dev/null | grep -oP '^\d+ calls processed' | grep -oP '^\d+')
  [[ -n "$calls_before" ]] || calls_before=0

  # 1. Originate the call through the dograh inbound path via ARI REST.
  ch_json=$(curl -sS --max-time 15 -u "dograh:${DOGRAH_ARI_PASSWORD}" -X POST \
    "http://127.0.0.1:8088/ari/channels?endpoint=Local/8000@dograh-inbound&app=${DOGRAH_STASIS_APP_NAME:-dograh}" 2>/dev/null)
  ch_id=$(echo "$ch_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [[ -n "$ch_id" ]]; then
    pass "originated call via ARI REST → channel $ch_id"
  else
    fail "originate via ARI REST failed — body: $(echo "$ch_json" | head -c 200)"
  fi

  # 2. Assert the channel routed into the dograh inbound dialplan context.
  if [[ -n "$ch_id" ]]; then
    ctx=$(echo "$ch_json" | python3 -c "import json,sys; d=json.load(sys.stdin); dp=d.get('dialplan',{}); print(dp.get('context',''), dp.get('exten',''))" 2>/dev/null)
    if [[ "$ctx" == "dograh-inbound 8000" ]]; then
      pass "call routed to dialplan context 'dograh-inbound' exten 8000 (FreePBX inbound route → Stasis app)"
    else
      fail "call dialplan = '$ctx', expected 'dograh-inbound 8000'"
    fi
  fi

  # 3. If dograh is connected, watch for the media WS client during the call.
  if [[ "$dograh_connected" == "true" && -n "$ch_id" ]]; then
    for _ in $(seq 1 6); do
      ws=$($ASTERISK "ari show outbound-websockets" 2>/dev/null | grep -vE "^\s*$|Name|----")
      if [[ -n "$ws" ]]; then break; fi
      sleep 1
    done
    if [[ -n "$ws" ]]; then
      pass "media WebSocket client connected during call (external media leg)"
    else
      warn "no outbound media WS client observed during the call — check websocket_client.conf URI + dograh's ws_client_name"
    fi
  fi

  # 4. Hang up.
  if [[ -n "$ch_id" ]]; then
    hc=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -u "dograh:${DOGRAH_ARI_PASSWORD}" \
      -X DELETE "http://127.0.0.1:8088/ari/channels/$ch_id" 2>/dev/null)
    if [[ "$hc" == "204" || "$hc" == "200" ]]; then
      pass "hung up channel $ch_id (ARI REST DELETE → $hc)"
    else
      warn "hang-up returned HTTP '$hc' — channel may have already ended (Local leg auto-hangs when no app answers)"
    fi
  fi

  # 5. Corroborate with the lifetime call counter (sampled here, after the
  #    hang-up: Asterisk counts a call as processed once it completes).
  calls_after=$($ASTERISK "core show channels" 2>/dev/null | grep -oP '^\d+ calls processed' | grep -oP '^\d+')
  if [[ -n "$calls_after" && "$calls_after" -gt "$calls_before" ]]; then
    pass "Asterisk call counter advanced ($calls_before → $calls_after) — the originate reached the dialplan"
  else
    warn "Asterisk call counter did not advance (before=$calls_before after=${calls_after:-unknown}) — the originate may not have entered the dialplan"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════
printf '\n%s=== Summary ===%s\n' "$C_BOLD" "$C_NC"
printf '  %sPASS%s  %s\n' "$C_GREEN" "$C_NC" "$PASS"
printf '  %sFAIL%s  %s\n' "$C_RED"   "$C_NC" "$FAIL"
printf '  %sWARN%s  %s\n' "$C_YELLOW" "$C_NC" "$WARN"
printf '  %sSKIP%s  %s\n' "$C_YELLOW" "$C_NC" "$SKIP"

if [[ "$FAIL" -gt 0 ]]; then
  printf '\n%sFailures:%s\n' "$C_BOLD" "$C_NC"
  for f in "${FAILURES[@]}"; do printf '  • %s\n' "$f"; done
  printf '\n%sSome checks failed — fix, then re-run: %s%s\n' "$C_RED" "$C_NC" "$0"
  exit 1
fi
if [[ "$WARN" -gt 0 ]]; then
  printf '\n%sNotes:%s\n' "$C_BOLD" "$C_NC"
  for w in "${WARNINGS[@]}"; do printf '  • %s\n' "$w"; done
fi
printf '\n%sAll checks passed.%s\n' "$C_GREEN" "$C_NC"
exit 0
