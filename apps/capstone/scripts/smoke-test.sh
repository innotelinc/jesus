#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# capstone — live-stack smoke test
#
# Runs the deployment verification checklist against a running stack:
#
#   Main stack  (docker-compose.yml)
#     • every container healthy (dograh, kokoro, speaches, omniroute, n8n,
#       grist, postgres, redis, minio, SigNoz + ClickHouse)
#     • HTTP endpoints: kokoro /health, speaches /health, OmniRoute :20128,
#       n8n /healthz, Grist :8484, SigNoz :3301, OTel ingest :4318
#     • round-trips: Kokoro TTS → WAV → Speaches STT transcription, and the
#       LLM gateway /v1/chat/completions (the same call n8n's grader makes)
#     • observability: ClickHouse ping + dograh-pipeline trace count (24h)
#
#   PBX stack   (docker-compose.asterisk.yml)
#     • freepbx container healthy; n8n-import completed (workflow activated)
#     • Asterisk: ARI user [dograh], HTTP server on 8088,
#       res_websocket_client module, [dograh-inbound] dialplan → Stasis(dograh)
#     • host-side ARI REST: GET /ari/asterisk/info with the dograh user
#
# Usage (run from the repo root):
#   ./scripts/smoke-test.sh            # everything
#   ./scripts/smoke-test.sh main       # docker-compose.yml only
#   ./scripts/smoke-test.sh pbx        # docker-compose.asterisk.yml only
#
# Exit code: 0 = all checks passed, 1 = one or more failures.
# Reads DOGRAH_ARI_PASSWORD / DOGRAH_WS_URI from .env for the ARI checks.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
COMPOSE_MAIN="$ROOT/docker-compose.yml"
COMPOSE_PBX="$ROOT/docker-compose.asterisk.yml"
SCOPE="${1:-all}"

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

# HTTP status code helper (empty string on transport error)
http_code() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null
}

check_http() { # name expected_code url [curl args...]
  local name="$1" expected="$2" url="$3"
  shift 3
  local code
  code=$(http_code "$url" "$@")
  if [[ "$code" == "$expected" ]]; then
    pass "$name → HTTP $code"
  else
    fail "$name → expected HTTP $expected, got '${code:-no response}' ($url)"
  fi
}

# Any HTTP response (2xx/4xx) proves the endpoint is alive — used for
# endpoints that deliberately reject malformed probes (e.g. the OTLP
# collector returning 415 to an empty body). Only transport errors fail.
check_alive() { # name url [curl args...]
  local name="$1" url="$2"
  shift 2
  local code
  code=$(http_code "$url" "$@")
  if [[ -n "$code" && "$code" != "000" ]]; then
    pass "$name → HTTP $code (endpoint alive)"
  else
    fail "$name → no response ($url)"
  fi
}

# Container health: healthy if the compose healthcheck says so; falls back to
# "running" for images without a healthcheck. Looks up by compose service
# first (project-scoped), then by the compose service label so containers
# started from ANOTHER directory/project (e.g. the interview-stack dir) are
# still found.
container_state() { # compose_file service → echoes healthy|running|exited|stopped|missing
  local id state health
  id=$(docker compose -f "$1" ps -q "$2" 2>/dev/null)
  if [[ -z "$id" ]]; then
    id=$(docker ps -aq --filter "label=com.docker.compose.service=$2" 2>/dev/null | head -1)
  fi
  [[ -n "$id" ]] || { echo missing; return; }
  health=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)
  case "$health" in
    healthy) echo healthy ;;
    ""|"<no value>"|none) state=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null); echo "$state" ;;
    starting) echo starting ;;
    unhealthy) echo unhealthy ;;
    *) echo "$health" ;;
  esac
}

check_container() { # compose_file service
  local state
  state=$(container_state "$1" "$2")
  case "$state" in
    healthy|running) pass "container $2 is $state" ;;
    missing)         fail "container $2 not found — is the stack up?" ;;
    starting)        fail "container $2 still starting — wait and re-run" ;;
    exited)          fail "container $2 exited" ;;
    *)               fail "container $2 in state '$state'" ;;
  esac
}

check_exit_code() { # compose_file one-shot_service
  local id code
  id=$(docker compose -f "$1" ps -q "$2" 2>/dev/null)
  if [[ -z "$id" ]]; then
    id=$(docker ps -aq --filter "label=com.docker.compose.service=$2" 2>/dev/null | head -1)
  fi
  if [[ -z "$id" ]]; then fail "one-shot $2 not found"; return; fi
  code=$(docker inspect -f '{{.State.ExitCode}}' "$id" 2>/dev/null)
  if [[ "$code" == "0" ]]; then pass "one-shot $2 completed (exit 0)"
  else fail "one-shot $2 exited $code — check its logs"; fi
}

# ── preflight ──────────────────────────────────────────────────────────────
if [[ "$SCOPE" == "-h" || "$SCOPE" == "--help" ]]; then
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi
if [[ "$SCOPE" != "all" && "$SCOPE" != "main" && "$SCOPE" != "pbx" ]]; then
  printf '%s\n' "usage: $0 [all|main|pbx]" >&2
  exit 2
fi

section "Preflight"
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "[FAIL] docker not installed — run this on the deploy host" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' "[FAIL] docker daemon unreachable — is the stack host up?" >&2
  exit 1
fi
pass "docker daemon reachable"

if [[ -f "$ENV_FILE" ]]; then
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  pass ".env loaded (${ENV_FILE})"
else
  warn ".env not found — ARI REST checks will be skipped (set DOGRAH_ARI_PASSWORD)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# MAIN STACK
# ═══════════════════════════════════════════════════════════════════════════
if [[ "$SCOPE" == "all" || "$SCOPE" == "main" ]]; then
  section "Main stack — containers"
  for svc in postgres redis minio dograh-api kokoro speaches omniroute n8n grist \
             signoz-metastore-postgres signoz-clickhouse-keeper signoz-clickhouse \
             signoz-otel-collector signoz; do
    check_container "$COMPOSE_MAIN" "$svc"
  done
  check_exit_code "$COMPOSE_MAIN" n8n-import

  section "Main stack — HTTP endpoints"
  check_http "Kokoro TTS /health"       200 "http://127.0.0.1:8880/health"
  check_http "Speaches STT /health"     200 "http://127.0.0.1:8001/health"
  check_http "LLM gateway /v1/models"   200 "http://127.0.0.1:20128/v1/models"
  check_http "LLM gateway dashboard"    200 "http://127.0.0.1:20128/" -L
  check_http "n8n /healthz"             200 "http://127.0.0.1:5678/healthz"
  check_http "Grist :8484"              200 "http://127.0.0.1:8484/" -L
  check_http "SigNoz UI+API :3301"      200 "http://127.0.0.1:3301/api/v1/health"
  check_alive "OTel collector :4318"    "http://127.0.0.1:4318/v1/traces" -X POST

  section "Main stack — round-trips"

  # 1. Kokoro TTS → WAV
  TTS_WAV="$(mktemp --suffix=.wav)"
  tts_code=$(curl -sS -o "$TTS_WAV" -w '%{http_code}' --max-time 60 \
    http://127.0.0.1:8880/v1/audio/speech \
    -H 'Content-Type: application/json' \
    -d '{"model":"kokoro","input":"Welcome to your technical interview.","voice":"af_heart","response_format":"wav"}' 2>/dev/null)
  if [[ "$tts_code" == "200" ]] && [[ -s "$TTS_WAV" ]] && [[ "$(head -c 4 "$TTS_WAV")" == "RIFF" ]]; then
    pass "Kokoro TTS round-trip → ${C_BOLD}$(wc -c < "$TTS_WAV") bytes${C_NC} WAV"
  else
    fail "Kokoro TTS round-trip → HTTP '$tts_code', file $(wc -c < "$TTS_WAV" 2>/dev/null || echo 0) bytes"
  fi

  # 2. Speaches STT ← same WAV
  stt_body=$(mktemp)
  stt_code=$(curl -sS -o "$stt_body" -w '%{http_code}' --max-time 120 \
    http://127.0.0.1:8001/v1/audio/transcriptions \
    -F "file=@$TTS_WAV" \
    -F 'model=Systran/faster-distil-whisper-small.en' \
    -F 'language=en' 2>/dev/null)
  if [[ "$stt_code" == "200" ]] && grep -qi 'welcome' "$stt_body"; then
    pass "Speaches STT round-trip → '$(tr -d '\n' < "$stt_body" | cut -c1-80)'"
  else
    fail "Speaches STT round-trip → HTTP '$stt_code', body: $(head -c 160 "$stt_body" 2>/dev/null)"
  fi

  # 3. LLM gateway (the exact call n8n's grader makes). A keyed gateway
  # (e.g. host 9Router) returns 401 without OMNIROUTE_API_KEY — that's a
  # config matter, not a stack failure, so report it as a WARN.
  llm_body=$(mktemp)
  llm_args=(-H 'Content-Type: application/json')
  if [[ -n "${OMNIROUTE_API_KEY:-}" ]]; then
    llm_args+=(-H "Authorization: Bearer ${OMNIROUTE_API_KEY}")
  fi
  llm_code=$(curl -sS -o "$llm_body" -w '%{http_code}' --max-time 120 \
    http://127.0.0.1:20128/v1/chat/completions \
    "${llm_args[@]}" \
    -d '{"model":"auto","temperature":0.2,"stream":false,"max_tokens":256,"messages":[{"role":"user","content":"Reply with the single word: ok"}]}' 2>/dev/null)
  if [[ "$llm_code" == "200" ]] && grep -q '"choices"' "$llm_body"; then
    pass "LLM gateway /v1/chat/completions → HTTP 200 with choices"
  elif [[ "$llm_code" == "401" ]]; then
    warn "LLM gateway is keyed (HTTP 401) — set OMNIROUTE_API_KEY in .env to run the full grading round-trip"
  else
    fail "LLM gateway /v1/chat/completions → HTTP '$llm_code' — body: $(head -c 200 "$llm_body" 2>/dev/null). model 'auto' may need internet or a local provider configured."
  fi

  section "Main stack — observability"
  ch_ping=$(curl -sS --max-time 10 "http://127.0.0.1:8123/ping" 2>/dev/null)
  if [[ "$ch_ping" == "Ok." ]]; then
    pass "ClickHouse ping (host :8123)"
  else
    fail "ClickHouse ping → '${ch_ping:-no response}'"
  fi

  ch_q='SELECT count() FROM signoz_traces.signoz_index_v3 WHERE serviceName='"'"'dograh-pipeline'"'"' AND timestamp >= now() - INTERVAL 24 HOUR'
  span_count=$(curl -sS --max-time 15 --get "http://127.0.0.1:8123/" --data-urlencode "query=$ch_q" 2>/dev/null | tr -d '[:space:]')
  if [[ "$span_count" =~ ^[0-9]+$ ]]; then
    if [[ "$span_count" -gt 0 ]]; then
      pass "dograh-pipeline spans in SigNoz (24h): ${C_BOLD}${span_count}${C_NC}"
    else
      warn "no dograh-pipeline spans yet — expected before the first call"
    fi
  else
    warn "trace query failed (${span_count:-no data}) — check the SigNoz dashboard after a real call"
  fi

  rm -f "$TTS_WAV" "$stt_body" "$llm_body"
fi

# ═══════════════════════════════════════════════════════════════════════════
# PBX STACK
# ═══════════════════════════════════════════════════════════════════════════
if [[ "$SCOPE" == "all" || "$SCOPE" == "pbx" ]]; then
  section "PBX stack — container"
  check_container "$COMPOSE_PBX" freepbx

  section "PBX stack — Asterisk / ARI wiring"
  ASTERISK="docker exec pbx-freepbx asterisk -rx"

  if ver=$($ASTERISK "core show version" 2>/dev/null | head -1); then
    pass "Asterisk up: $ver"
  else
    fail "asterisk -rx 'core show version' failed — is the container up?"
  fi

  if $ASTERISK "ari show users" 2>/dev/null | grep -q "dograh"; then
    pass "ARI user [dograh] present (ari show users)"
  else
    fail "ARI user [dograh] missing — check pbx/asterisk/ari.conf + entrypoint"
  fi

  if $ASTERISK "http show status" 2>/dev/null | grep -qi "Enabled and Running"; then
    pass "Asterisk HTTP server enabled (http show status)"
  else
    fail "Asterisk HTTP server not enabled on 8088"
  fi

  if $ASTERISK "module show like res_websocket_client" 2>/dev/null | grep -q "res_websocket_client"; then
    pass "res_websocket_client module loaded"
  else
    fail "res_websocket_client not loaded — external media WS unavailable"
  fi

  if $ASTERISK "dialplan show dograh-inbound" 2>/dev/null | grep -q "Stasis(dograh)"; then
    pass "dialplan [dograh-inbound] → Stasis(dograh)"
  else
    fail "dialplan [dograh-inbound] missing — check pbx/asterisk/extensions_custom.conf"
  fi

  if ws_clients=$($ASTERISK "websocket show clients" 2>/dev/null); then
    if echo "$ws_clients" | grep -q "No WebSocket"; then
      warn "media WebSocket: no connected clients (dograh-api must be up; it reconnects per call)"
    else
      pass "media WebSocket client connected (websocket show clients)"
    fi
  else
    skip "media WebSocket check — freepbx container not responding"
  fi

  section "PBX stack — host-side ARI REST"
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
