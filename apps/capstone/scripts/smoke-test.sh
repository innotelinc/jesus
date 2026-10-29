#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# capstone — live-stack smoke test
#
# Runs the deployment verification checklist against a running stack:
#
#   Main stack  (docker-compose.yml)
#     • every container healthy (dograh, kokoro, speaches, omniroute, n8n,
#       grist, postgres, redis, minio, otel-collector, prometheus, grafana,
#       tts-shim)
#     • HTTP endpoints: kokoro /health, speaches /health, OmniRoute :20128,
#       n8n /healthz, Grist :8484, Grafana :3301, OTel ingest :4318,
#       TTS shim :8881
#     • dograh UI auth surfaces: the sign-in screen responds, an anonymous
#       /workflow lands on that form instead of a dead-end error, and every
#       /auth/login?error=<slug> state still renders (see the OIDC notes in
#       dograh/patches/ for why the slug has to be read)
#     • Control Center: dashboard-api :8095 aggregator + dashboard UI :8096
#       (built React SPA; /api proxied to the aggregator)
#     • round-trips: Kokoro TTS → WAV → Speaches STT transcription, and the
#       LLM gateway /v1/chat/completions (the same call n8n's grader makes)
#     • observability: Prometheus scrape health, the span→metric series the
#       pipeline dashboard reads, and what the collector refused
#     • dograh telephony wiring (when DOGRAH_API_TOKEN is in .env): the three
#       interview agent workflows imported, the Cantus ARI telephony
#       config present, and extensions 8000/8001/8002 bound to their agents
#       (delegates to scripts/dograh_wire.py --check)
#
#   Voice plane   (cantus-switch service in docker-compose.yml)
#     • switch container healthy; publishes 8088/tcp, 7443/udp, 7444/udp and
#       nothing that belongs to a SIP stack (5060, 5061, 8089, 5038, RTP)
#     • control API: /healthz, /v1/status (transport CANTUS), the routing
#       document and the line inventory
#     • ARI surface: refuses anonymous GET /ari/asterisk/info, answers the
#       dograh user, and reports which ARI apps are connected
#     • browser softphone socket /ws/line upgrades
#
# Usage (run from the repo root):
#   ./scripts/smoke-test.sh            # everything
#   ./scripts/smoke-test.sh main       # non-telephony services only
#   ./scripts/smoke-test.sh pbx        # voice plane only (alias: cantus)
#
# Exit code: 0 = all checks passed, 1 = one or more failures.
# Reads DOGRAH_ARI_PASSWORD / DOGRAH_WS_URI from .env for the ARI checks.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/env-lib.sh disable=SC1091
. "$ROOT/scripts/env-lib.sh"   # env_lib_load: .env as data, never as shell code
ENV_FILE="$ROOT/.env"
COMPOSE_MAIN="$ROOT/docker-compose.yml"
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

# Where a guarded route lands after its redirects. Page *copy* is not checkable
# from here — the auth screens render on the client (the HTML is a spinner), so
# their wording needs a browser — but the redirect target is decided server-side
# and is what a mis-guarded route breaks.
check_redirect() { # name url expected_substring_of_final_url [curl args...]
  local name="$1" url="$2" expected="$3"
  shift 3
  local final
  final=$(curl -sS -o /dev/null -L --max-time 10 -w '%{url_effective}' "$url" "$@" 2>/dev/null)
  if [[ "$final" == *"$expected"* ]]; then
    pass "$name → $final"
  else
    fail "$name → expected to end at *$expected, got '${final:-no response}' ($url)"
  fi
}

# Host-side ARI REST base. Probes dial the same address the services do: the
# host LAN IP (README → Addressing). 8088 has no loopback leg, so a 127.0.0.1
# probe reports a healthy PBX as down. DOGRAH_ARI_ENDPOINT wins (the value
# dograh itself dials), then PJSIP_MEDIA_ADDRESS, then the route-selected LAN
# IP; empty means neither the env nor the host could name one.
ari_base() {
  if [[ -n "${DOGRAH_ARI_ENDPOINT:-}" ]]; then printf '%s' "$DOGRAH_ARI_ENDPOINT"; return; fi
  local host="${PJSIP_MEDIA_ADDRESS:-}"
  if [[ -z "$host" ]]; then
    host="$(ip -4 route get 1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)"
  fi
  [[ "$host" == "127.0.0.1" ]] && host=""
  [[ -n "$host" ]] && printf 'http://%s:8088' "$host"
}

# The LLM gateway's own host. The gateway is the one service a stack does not
# have to run locally: its volume (provider connections, settings, the key that
# decrypts them) lives beside it on its own host, and every other host reaches
# it through the identity-aware door that host publishes — `OMNIROUTE_URL`, the
# same value the stack's own consumers dial. So the address is asked for, never
# assumed: a local container or an answering 20128 wins on the gateway's host,
# otherwise the configured door is used. Empty means neither could name one.
gateway_base() {
  local c
  if [[ -n "$(docker ps -q --filter 'label=com.docker.compose.service=omniroute' 2>/dev/null | head -1)" ]]; then
    printf 'http://127.0.0.1:20128'; return
  fi
  # 200 or 401 both prove something is listening on the gateway's own port.
  c=$(http_code http://127.0.0.1:20128/v1/models)
  if [[ "$c" == "200" || "$c" == "401" ]]; then printf 'http://127.0.0.1:20128'; return; fi
  if [[ -n "${OMNIROUTE_URL:-}" ]]; then
    printf '%s' "${OMNIROUTE_URL%/}"
    return
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

# Hybrid-box fallback: some deployments run redis/minio/LLM-gateway as HOST
# processes (systemd) instead of containers. If the container is missing but
# its port answers, the service is up — just not containerized.
host_port_check() { # service → echoes "port" if a host process answers
  case "$1" in
    redis)
      if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/6379' 2>/dev/null; then echo "127.0.0.1:6379"; fi ;;
    minio)
      local c; c=$(http_code http://127.0.0.1:9000/minio/health/live)
      [[ "$c" == "200" ]] && echo "127.0.0.1:9000" ;;
    omniroute)
      local c; c=$(http_code http://127.0.0.1:20128/v1/models)
      if [[ "$c" == "200" || "$c" == "401" ]]; then echo "127.0.0.1:20128"; fi ;;
    dograh-api)
      local c; c=$(http_code http://127.0.0.1:8000/api/v1/health)
      [[ -n "$c" && "$c" != "000" ]] && echo "127.0.0.1:8000" ;;
  esac
}

check_container() { # compose_file service
  local state hp
  state=$(container_state "$1" "$2")
  case "$state" in
    healthy|running) pass "container $2 is $state" ;;
    missing)
      # The gateway is the one service a stack need not run locally: it lives on
      # its own host, behind the `gateway` compose profile. A reachable door is
      # the real check, and an *unreachable* one is worth a hard fail — because
      # the failure this guards against is a second gateway answering locally
      # while the real one is never consulted.
      if [[ "$2" == "omniroute" ]]; then
        local gw c
        gw=$(gateway_base)
        if [[ -n "$gw" && "$gw" != "http://127.0.0.1:20128" ]]; then
          c=$(http_code "$gw/v1/models")
          if [[ "$c" == "200" || "$c" == "401" ]]; then
            pass "omniroute runs on its own host — $gw answered (HTTP $c)"
          else
            fail "omniroute is configured on another host ($gw) but did not answer (HTTP ${c:-none})"
          fi
          return
        fi
      fi
      hp=$(host_port_check "$2")
      if [[ -n "$hp" ]]; then
        pass "$2 not containerized — host process serving $hp"
      else
        fail "container $2 not found — is the stack up?"
      fi ;;
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
  env_lib_load "$ENV_FILE"
  pass ".env loaded (${ENV_FILE})"
else
  warn ".env not found — ARI REST checks will be skipped (set DOGRAH_ARI_PASSWORD)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# MAIN STACK
# ═══════════════════════════════════════════════════════════════════════════
if [[ "$SCOPE" == "all" || "$SCOPE" == "main" ]]; then
  section "Main stack — containers"
  for svc in postgres redis minio dograh-api dograh-ui speaches omniroute n8n grist \
             otel-collector prometheus grafana tts-shim dashboard-api dashboard; do
    check_container "$COMPOSE_MAIN" "$svc"
  done
  check_exit_code "$COMPOSE_MAIN" n8n-import

  section "Main stack — HTTP endpoints"
  check_http "Speaches STT /health"     200 "http://127.0.0.1:8001/health"
  check_http "Dograh API /health"       200 "http://127.0.0.1:8000/api/v1/health"
  check_http "Dograh UI :3010"          200 "http://127.0.0.1:3010/" -L
  # The gateway may run here or on its own host; `gateway_base` names whichever
  # it is, so these checks are about the gateway this stack *uses* rather than
  # about a container this host happens to have.
  GATEWAY=$(gateway_base)
  if [[ -z "$GATEWAY" ]]; then
    fail "LLM gateway: no local container/port and no OMNIROUTE_URL — the gateway (and so every AI call) has no address"
  fi
  llm_model_args=()
  if [[ -n "${OMNIROUTE_API_KEY:-}" ]]; then
    llm_model_args+=(-H "Authorization: Bearer ${OMNIROUTE_API_KEY}")
  fi
  # OmniRoute guards model listing with dashboard-session auth (the API key
  # only unlocks /v1/chat/completions), so a 401 here is expected even with
  # OMNIROUTE_API_KEY set — the chat-completions round-trip below is the real
  # probe. Anything else non-200 is a stack failure.
  llm_models_code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
    "${llm_model_args[@]}" "${GATEWAY:-http://127.0.0.1:20128}/v1/models" 2>/dev/null || echo 000)
  if [[ "$llm_models_code" == "200" ]]; then
    pass "LLM gateway $GATEWAY/v1/models → HTTP 200"
  elif [[ "$llm_models_code" == "401" ]]; then
    warn "LLM gateway $GATEWAY/v1/models → HTTP 401 — model listing is session-gated by design; /v1/chat/completions is the real probe"
  else
    fail "LLM gateway $GATEWAY/v1/models → expected HTTP 200, got '$llm_models_code'"
  fi
  # The dashboard on the gateway's own port is loopback-only, and on its own
  # host the door in front of it needs Authentik; only ask for the local
  # dashboard when the gateway is the local one.
  if [[ "$GATEWAY" == "http://127.0.0.1:20128" ]]; then
    check_http "LLM gateway dashboard"    200 "$GATEWAY/" -L
  fi
  check_http "n8n /healthz"             200 "http://127.0.0.1:5678/healthz"
  check_http "n8n grader webhook"        200 "http://127.0.0.1:5678/webhook/interview-graded" -X POST -H "Content-Type: application/json" -d '{}'
  check_http "Grist :8484"              200 "http://127.0.0.1:8484/" -L
  # Grafana holds the port the SigNoz UI had (3301), so proxy hosts and
  # firewall rules did not have to move with the stack underneath them.
  check_http "Grafana /api/health :3301" 200 "http://127.0.0.1:3301/api/health"
  check_alive "OTel collector :4318"    "http://127.0.0.1:4318/v1/traces" -X POST
  check_http "TTS shim /health :8881"   200 "http://127.0.0.1:8881/health"
  check_http "Dashboard API /healthz"   200 "http://127.0.0.1:8095/healthz"
  check_http "Control Center UI :8096"  200 "http://127.0.0.1:8096/" -L
  check_alive "Control Center /api proxy" "http://127.0.0.1:8096/api/services"

  # The dograh UI signs in through Cerulean (Authentik), and the backend funnels
  # every OIDC failure back to /auth/login?error=<slug>. A guarded route must
  # land on that form rather than render a dead-end error the operator cannot act
  # on, and each error slug must still render: the page reads `searchParams`,
  # which is a Promise in Next 15 — getting that wrong turns every bounced
  # sign-in into a 500 instead of an explanation.
  section "Main stack — dograh UI auth surfaces"
  DOGRAH_UI="http://127.0.0.1:3010"
  check_http     "Dograh UI sign-in screen"  200 "$DOGRAH_UI/auth/login"
  check_redirect "Anonymous /workflow gate"     "$DOGRAH_UI/workflow"                    "/auth/login"
  check_http     "Sign-in error: not allowed" 200 "$DOGRAH_UI/auth/login?error=not_allowed"
  check_http     "Sign-in error: expired"     200 "$DOGRAH_UI/auth/login?error=expired"
  check_http     "Sign-in error: denied"      200 "$DOGRAH_UI/auth/login?error=denied"
  check_http     "Sign-in error: unavailable" 200 "$DOGRAH_UI/auth/login?error=unavailable"

  section "Main stack — round-trips"

  # 1. Local TTS → PCM through the shim (Piper is the voice; Kokoro is retired
  # and behind the `kokoro` profile). The shim streams PCM only — no WAV — so
  # the round-trip checks the bytes and the engine header, then wraps the PCM
  # into a WAV for the STT half, which needs a container.
  TTS_PCM="$(mktemp --suffix=.pcm)"
  TTS_HDR="$(mktemp)"
  TTS_WAV="$(mktemp --suffix=.wav)"
  tts_code=$(curl -sS -o "$TTS_PCM" -D "$TTS_HDR" -w '%{http_code}' --max-time 60 \
    http://127.0.0.1:8881/v1/audio/speech \
    -H 'Content-Type: application/json' \
    -d '{"model":"piper","input":"Welcome to your technical interview.","response_format":"pcm"}' 2>/dev/null)
  tts_engine=$(tr -d '\r' < "$TTS_HDR" | awk 'tolower($1)=="x-tts-engine:"{print $2}')
  if [[ "$tts_code" == "200" ]] && [[ -s "$TTS_PCM" ]] && [[ "$tts_engine" == "piper" ]]; then
    pass "Local TTS (Piper) round-trip → ${C_BOLD}$(wc -c < "$TTS_PCM") bytes${C_NC} PCM at 24 kHz"
  else
    fail "Local TTS round-trip → HTTP '$tts_code', engine '$tts_engine', $(wc -c < "$TTS_PCM" 2>/dev/null || echo 0) bytes"
  fi
  python3 - "$TTS_PCM" "$TTS_WAV" <<'PY'
import sys, wave
with open(sys.argv[1], "rb") as src:
    pcm = src.read()
with wave.open(sys.argv[2], "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(24000)
    wav.writeframes(pcm)
PY

  # 2. Speaches STT ← same WAV
  stt_body=$(mktemp)
  stt_code=$(curl -sS -o "$stt_body" -w '%{http_code}' --max-time 120 \
    http://127.0.0.1:8001/v1/audio/transcriptions \
    -F "file=@$TTS_WAV" \
    -F 'model=Systran/faster-distil-whisper-small.en' \
    -F 'language=en' 2>/dev/null)
  if [[ "$stt_code" == "200" ]] && grep -qi 'welcome' "$stt_body"; then
    pass "Speaches STT round-trip → '$(tr -d '\n' < "$stt_body" | cut -c1-80)'"
  elif [[ "$stt_code" == "404" ]] && grep -q 'not installed locally' "$stt_body"; then
    warn "Speaches STT model is not installed yet — download it via POST /v1/models before the first transcription"
  else
    fail "Speaches STT round-trip → HTTP '$stt_code', body: $(head -c 160 "$stt_body" 2>/dev/null)"
  fi

  # 3. LLM gateway (the exact call n8n's grader makes). A keyed gateway
  # returns 401 without OMNIROUTE_API_KEY — that's a config matter, not a
  # stack failure, so report it as a WARN.
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
  elif [[ "$llm_code" == "429" ]]; then
    warn "LLM gateway up but model 'auto' is rate-limited (HTTP 429, free-tier providers) — add a local Ollama/vLLM provider in the OmniRoute dashboard for a reliable round-trip"
  else
    fail "LLM gateway /v1/chat/completions → HTTP '$llm_code' — body: $(head -c 200 "$llm_body" 2>/dev/null). model 'auto' may need internet or a local provider configured."
  fi

  section "Main stack — observability"
  # Prometheus replaced the ClickHouse + SigNoz pair: the collector converts
  # spans into the `traces_span_metrics_*` series and drops the spans, so there
  # is nothing to ping on :8123 any more. `up` proves the store answers, a
  # non-zero span counter proves the span→metric conversion is landing (rather
  # than only the collector being reachable), and the refused counter is what a
  # broken pipeline looks like before the dashboard shows a gap.
  prom_url="http://127.0.0.1:9090/api/v1/query"
  prom_scalar() { # expression → the first sample's value, empty on error
    curl -sS --max-time 10 --get "$prom_url" --data-urlencode "query=$1" 2>/dev/null \
      | grep -o '"value":\[[0-9.]*,"[^"]*"\]' | head -1 | cut -d'"' -f4
  }

  up_targets=$(curl -sS --max-time 10 --get "$prom_url" --data-urlencode 'query=up' 2>/dev/null \
    | grep -o '"value":\[' | wc -l)
  if [[ "${up_targets:-0}" -gt 0 ]]; then
    pass "Prometheus scraping ${C_BOLD}${up_targets}${C_NC} target(s) — http://127.0.0.1:9090/targets shows any gap"
  else
    fail "Prometheus reported no targets — check its /targets over an SSH tunnel"
  fi

  span_count=$(prom_scalar 'sum(traces_span_metrics_calls_total)')
  if [[ -n "$span_count" && "$span_count" != "NaN" && "${span_count%%.*}" -gt 0 ]]; then
    pass "pipeline spans converted to metrics: ${C_BOLD}${span_count}${C_NC} over the retention window"
  else
    warn "no span metrics yet (got '${span_count:-no data}') — expected before the first call; after one, check the collector's refused counter"
  fi

  refused=$(prom_scalar 'sum(otelcol_receiver_refused_spans_total)')
  if [[ -z "$refused" || "$refused" == "0" ]]; then
    pass "collector has refused no spans"
  else
    warn "collector refused ${refused} span(s) — they never became metrics"
  fi

  rm -f "$TTS_WAV" "$stt_body" "$llm_body"

  section "Main stack — dograh telephony wiring"
  if [[ -z "${DOGRAH_API_TOKEN:-}" ]]; then
    skip "DOGRAH_API_TOKEN not set in .env — run scripts/dograh_wire.py to wire dograh"
  else
    if python3 "$ROOT/scripts/dograh_wire.py" --check; then
      pass "telephony wiring complete (agents imported, ARI config, extensions 8000/8001/8002)"
    else
      fail "telephony wiring incomplete (see report above) — run: python3 scripts/dograh_wire.py"
    fi
  fi

  section "Control Center — /agents API"
  # The Agents page's endpoints: /agents lists dograh phone numbers + their
  # FreePBX provisioning status; /agents/workflows lists bindable workflows.
  # The aggregator (dashboard-api) serves them on :8095; with no
  # AUTHENTIK_ISSUER_URL the API is open, so no session cookie is needed.
  # When the Authentik OIDC gate is enabled (AUTHENTIK_ISSUER_URL in .env),
  # mint an HMAC-signed session cookie the same way auth.py does — the gate
  # reads CERULEAN_TENANT and the tenant group name from the cookie payload.
  # The aggregator fans out to every upstream (dograh, kokoro, speaches, PBX…)
  # before answering, so give it far more than the default 10s.
  AGENTS_CURL=(curl -sS --max-time 45)
  AGENT_COOKIE=""
  if [[ -n "${AUTHENTIK_ISSUER_URL:-}" && -n "${AUTHENTIK_CLIENT_SECRET:-}" ]]; then
    AGENT_COOKIE=$(python3 - "$AUTHENTIK_CLIENT_SECRET" "${CERULEAN_TENANT:-default}" <<'PYEOF'
import base64, hashlib, hmac, json, sys, time
secret, tenant = sys.argv[1], sys.argv[2]
payload = {
    "sub": "smoke-test",
    "email": "dhunter@innotel.us",
    "name": "Smoke Test",
    "groups": [tenant],
    "tenant": tenant,
    "exp": int(time.time()) + 3600,
}
body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
print(f"{body}.{sig}")
PYEOF
)
    AGENTS_CURL+=(-H "Cookie: capstone_session=$AGENT_COOKIE")
  fi
  agents_code=$("${AGENTS_CURL[@]}" -o /dev/null -w '%{http_code}' http://127.0.0.1:8095/agents 2>/dev/null)
  if [[ "$agents_code" == "200" ]]; then
    pass "GET /agents → HTTP 200 (Control Center aggregator :8095)"
  else
    fail "GET /agents → HTTP '$agents_code' — is dashboard-api up?"
  fi
  agents_json=$("${AGENTS_CURL[@]}" http://127.0.0.1:8095/agents 2>/dev/null || true)
  if [[ -n "$agents_json" ]] && echo "$agents_json" | grep -q '"agents"' && echo "$agents_json" | grep -q '"configured"'; then
    if echo "$agents_json" | grep -q '"configured":true'; then
      pass "/agents reports dograh configured (mode: $(echo "$agents_json" | grep -o '"mode":"[^"]*"' | head -1 | cut -d'"' -f4))"
    else
      warn "/agents: dograh not configured (DOGRAH_API_TOKEN missing) — page shows setup guidance"
    fi
  else
    warn "/agents response malformed — check dashboard-api logs"
  fi
  workflows_code=$("${AGENTS_CURL[@]}" -o /dev/null -w '%{http_code}' http://127.0.0.1:8095/agents/workflows 2>/dev/null)
  if [[ "$workflows_code" == "200" ]]; then
    pass "GET /agents/workflows → HTTP 200"
  elif [[ "$workflows_code" == "503" ]]; then
    warn "GET /agents/workflows → 503 (dograh not configured) — expected without DOGRAH_API_TOKEN"
  else
    fail "GET /agents/workflows → HTTP '$workflows_code'"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# VOICE PLANE — Cantus
# ═══════════════════════════════════════════════════════════════════════════
if [[ "$SCOPE" == "all" || "$SCOPE" == "pbx" || "$SCOPE" == "cantus" ]]; then
  section "Voice plane — container"
  CTR=$(docker ps -aq --filter "label=com.docker.compose.service=cantus-switch" 2>/dev/null | head -1)
  if [[ -z "$CTR" ]]; then
    if [[ "${CAPSTONE_PBX:-standalone}" == "standalone" ]]; then
      fail "cantus-switch container is not running (compose profile 'standalone')"
    else
      skip "cantus-switch is not this host's (CAPSTONE_PBX=${CAPSTONE_PBX}) — the ARI checks below target DOGRAH_ARI_ENDPOINT"
    fi
  else
    status=$(docker inspect -f '{{.State.Status}}' "$CTR" 2>/dev/null)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CTR" 2>/dev/null)
    if [[ "$status" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
      pass "cantus-switch running ($health)"
    else
      fail "cantus-switch is $status/$health"
    fi
  fi

  SWITCH_URL="http://127.0.0.1:${CANTUS_HTTP_PORT:-8088}"
  AUTH=()
  [[ -n "${CANTUS_CONTROL_TOKEN:-}" ]] && AUTH=(-H "authorization: Bearer ${CANTUS_CONTROL_TOKEN}")

  section "Voice plane — published ports"
  # Cantus needs exactly three host ports: control/ARI/softphone on 8088, then
  # signalling+media and the relay on UDP. Nothing else — and in particular no
  # SIP, no WSS listener, no AMI and no RTP block, all of which belonged to
  # Asterisk and would mean a stale service is still running.
  if [[ -n "$CTR" ]]; then
    ports=$(docker port "$CTR" 2>/dev/null | awk '{print $1}' | sort -u)
    for want in '8088/tcp' '7443/udp' '7444/udp'; do
      if grep -qx "$want" <<<"$ports"; then
        pass "switch publishes $want"
      else
        fail "switch does not publish $want"
      fi
    done
    stale=$(grep -E '^(5060|5061|8089|5038)/' <<<"$ports" || true)
    if [[ -n "$stale" ]]; then
      fail "SIP/WSS/AMI port still published: $(tr '\n' ' ' <<<"$stale")"
    else
      pass "no SIP (5060/5061), WSS (8089) or AMI (5038) port published"
    fi
  fi

  section "Voice plane — control API"
  health_code=$(http_code "$SWITCH_URL/healthz")
  if [[ "$health_code" == "200" ]]; then
    pass "GET /healthz → 200"
  else
    fail "GET /healthz → '${health_code:-no response}' at $SWITCH_URL"
  fi

  status_body=$(mktemp)
  status_code=$(curl -sS -o "$status_body" -w '%{http_code}' --max-time 10 "${AUTH[@]}" "$SWITCH_URL/v1/status" 2>/dev/null)
  if [[ "$status_code" == "200" ]] && grep -q '"CANTUS"' "$status_body"; then
    pass "GET /v1/status → transport CANTUS ($(grep -o '"addr":"[^"]*"' "$status_body" | head -1 | cut -d'"' -f4))"
  elif [[ "$status_code" == "401" ]]; then
    fail "GET /v1/status → 401 (CANTUS_CONTROL_TOKEN does not match the switch)"
  else
    fail "GET /v1/status → '${status_code:-no response}'"
  fi
  rm -f "$status_body"

  routes_body=$(mktemp)
  routes_code=$(curl -sS -o "$routes_body" -w '%{http_code}' --max-time 10 "${AUTH[@]}" "$SWITCH_URL/v1/routes" 2>/dev/null)
  if [[ "$routes_code" == "200" ]] && grep -q '"routes"' "$routes_body"; then
    route_count=$(grep -o '"name"' "$routes_body" | wc -l | tr -d ' ')
    if (( route_count > 0 )); then
      pass "routing document loaded ($route_count routes)"
    else
      warn "routing document is empty — no call will land"
    fi
    if grep -q '"ari"' "$routes_body"; then
      pass "routing document hands at least one route to ARI"
    else
      warn "no route uses the ari action — dograh will never receive a call"
    fi
  else
    fail "GET /v1/routes → '${routes_code:-no response}'"
  fi
  rm -f "$routes_body"

  lines_body=$(mktemp)
  lines_code=$(curl -sS -o "$lines_body" -w '%{http_code}' --max-time 10 "${AUTH[@]}" "$SWITCH_URL/v1/lines" 2>/dev/null)
  if [[ "$lines_code" == "200" ]]; then
    line_count=$(grep -o '"ext"' "$lines_body" | wc -l | tr -d ' ')
    if (( line_count > 0 )); then
      pass "line inventory loaded ($line_count lines)"
    else
      warn "no lines registered — softphone and extension calls will no-answer"
    fi
  else
    fail "GET /v1/lines → '${lines_code:-no response}'"
  fi
  rm -f "$lines_body"

  section "Voice plane — ARI surface (what dograh dials)"
  if [[ -z "$CTR" && -n "${DOGRAH_ARI_ENDPOINT:-}" ]]; then
    ARI_BASE="${DOGRAH_ARI_ENDPOINT%/}"
  else
    ARI_BASE="$(ari_base)"
  fi
  if [[ -z "$ARI_BASE" ]]; then
    fail "cannot resolve the switch address — set PJSIP_MEDIA_ADDRESS or DOGRAH_ARI_ENDPOINT in .env"
  else
    unauth_code=$(http_code "$ARI_BASE/ari/asterisk/info")
    if [[ "$unauth_code" == "401" ]]; then
      pass "ARI refuses unauthenticated GET /ari/asterisk/info (401)"
    else
      fail "ARI answered unauthenticated with '${unauth_code:-no response}' — the surface must refuse anonymous access"
    fi

    if [[ -z "${DOGRAH_ARI_PASSWORD:-}" || "$DOGRAH_ARI_PASSWORD" == "CHANGE_ME_ARI_PASSWORD" ]]; then
      skip "ARI REST check — set DOGRAH_ARI_PASSWORD in .env"
    else
      ari_body=$(mktemp)
      ari_code=$(curl -sS -o "$ari_body" -w '%{http_code}' --max-time 10 \
        -u "dograh:${DOGRAH_ARI_PASSWORD}" "$ARI_BASE/ari/asterisk/info" 2>/dev/null)
      if [[ "$ari_code" == "200" ]] && grep -qi '"Cantus"' "$ari_body"; then
        pass "ARI REST $ARI_BASE/ari/asterisk/info → 200 (engine Cantus)"
      else
        fail "ARI REST → '$ari_code' (check DOGRAH_ARI_PASSWORD + the 8088 publish on the LAN IP)"
      fi
      rm -f "$ari_body"

      apps_body=$(mktemp)
      apps_code=$(curl -sS -o "$apps_body" -w '%{http_code}' --max-time 10 \
        -u "dograh:${DOGRAH_ARI_PASSWORD}" "$ARI_BASE/ari/applications" 2>/dev/null)
      if [[ "$apps_code" == "200" ]]; then
        if grep -q '"dograh"' "$apps_body"; then
          pass "ARI app 'dograh' is connected"
        else
          warn "no 'dograh' ARI client connected yet — dograh-api connects when it starts"
        fi
      else
        fail "GET /ari/applications → '${apps_code:-no response}'"
      fi
      rm -f "$apps_body"
    fi

    section "Voice plane — softphone socket"
    ws_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      "$ARI_BASE/ws/line?ext=100" 2>/dev/null)
    if [[ "$ws_code" == "101" ]]; then
      pass "browser softphone socket upgrades (/ws/line)"
    elif [[ -n "$ws_code" && "$ws_code" != "000" ]]; then
      warn "softphone socket answered HTTP $ws_code (works over a WS client; curl sees the handshake only)"
    else
      fail "softphone socket unreachable at $ARI_BASE/ws/line"
    fi
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
