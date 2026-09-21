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
#       interview agent workflows imported, the Asterisk ARI telephony
#       config present, and extensions 8000/8001/8002 bound to their agents
#       (delegates to scripts/dograh_wire.py --check)
#
#   PBX stack   (freepbx service in docker-compose.yml)
#     • freepbx container healthy; n8n-import completed (workflow activated)
#     • Asterisk: ARI user [dograh], HTTP server on 8088,
#       res_websocket_client module, [dograh-inbound] dialplan → Stasis(dograh)
#     • host-side ARI REST: GET /ari/asterisk/info with the dograh user at the
#       host LAN IP (8088 is LAN-only — never loopback)
#
# Usage (run from the repo root):
#   ./scripts/smoke-test.sh            # everything
#   ./scripts/smoke-test.sh main       # non-PBX services only
#   ./scripts/smoke-test.sh pbx        # freepbx service only
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
COMPOSE_PBX="$ROOT/docker-compose.yml"  # freepbx is a service in the main compose now
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

# Retry an `asterisk -rx` command until its output matches a regex or the
# deadline hits. The PBX entrypoint does a final `core restart now` AFTER the
# container healthcheck first passes, so http/dialplan state can be briefly
# unavailable right after "healthy" — retrying absorbs that startup race.
wait_asterisk_cmd() { # label regex command... → 0 on match, 1 on timeout
  local regex="$2"
  shift 2
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    if "$@" 2>/dev/null | grep -q "$regex"; then
      return 0
    fi
    sleep 3
  done
  return 1
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
  for svc in postgres redis minio dograh-api dograh-ui kokoro speaches omniroute n8n grist \
             otel-collector prometheus grafana tts-shim dashboard-api dashboard; do
    check_container "$COMPOSE_MAIN" "$svc"
  done
  check_exit_code "$COMPOSE_MAIN" n8n-import

  section "Main stack — HTTP endpoints"
  check_http "Kokoro TTS /health"       200 "http://127.0.0.1:8880/health"
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
# PBX STACK
# ═══════════════════════════════════════════════════════════════════════════
if [[ "$SCOPE" == "all" || "$SCOPE" == "pbx" ]]; then
  section "PBX stack — container"
  check_container "$COMPOSE_PBX" freepbx

  # Resolve the running freepbx container before port and Asterisk checks.
  FBX=$(docker ps -aq --filter "label=com.docker.compose.service=freepbx" 2>/dev/null | while read -r c; do
    [[ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" == "running" ]] && { echo "$c"; break; }
  done)
  FBX="${FBX:-pbx-freepbx}"
  ASTERISK="docker exec ${FBX} asterisk -rx"

  section "PBX stack — Webmin / RTP port wiring"
  # Webmin is intentionally on host TCP 10000; Asterisk RTP must use only
  # UDP 10101-10120. These checks catch stale image/volume mappings such as
  # 10000-10100 and 10121-20000, which can conflict with Webmin or expose
  # media ports that Asterisk should not use.
  webmin_code=$(http_code https://127.0.0.1:10000 -k -L)
  if [[ "$webmin_code" =~ ^[23][0-9][0-9]$ ]]; then
    pass "Webmin TCP :10000 reachable (HTTP $webmin_code)"
  else
    fail "Webmin TCP :10000 unreachable (HTTP '${webmin_code:-no response}')"
  fi

  # Docker 29 exposes EXPOSEd-but-unpublished ports in NetworkSettings.Ports
  # (the fullstack image EXPOSEs 10000-20000/udp), so inspect the actual host
  # bindings via `docker port` instead — that only lists really-published
  # ports and always reports them expanded to individual entries.
  pbx_ports=$(docker port "$FBX" 2>/dev/null | awk '{print $1}' | sort -u)
  if grep -qx '10000/tcp' <<<"$pbx_ports"; then
    pass "PBX publishes Webmin on TCP 10000"
  else
    fail "PBX does not publish Webmin on TCP 10000"
  fi
  # Expected published set: 80, 5060, 5061, 8088, 8089, 10000/tcp, 5060/udp,
  # the exact RTP block 10101-10120/udp, and the dedicated VoIP.ms outbound
  # register port (VOIPMS_REGISTER_PORT, default 5065) — nothing else on UDP.
  # AMI (5038) is not part of the off-box set: the compose binds it to the host
  # LAN IP only, and the portal dials that same address (ASTERISK_AMI_HOST).
  expected_rtp=$(seq 10101 10120 | sed 's/$/\/udp/')
  voipms_port="${VOIPMS_REGISTER_PORT:-5065}/udp"
  actual_rtp=$(grep '/udp$' <<<"$pbx_ports" | grep -v '^5060/udp$' | grep -v "^${voipms_port}$" || true)
  if [[ -n "$actual_rtp" ]] && [[ "$(printf '%s\n' "$actual_rtp")" == "$(printf '%s\n' "$expected_rtp")" ]]; then
    pass "PBX publishes exact RTP range UDP 10101-10120 (+ VoIP.ms ${voipms_port})"
  else
    fail "PBX RTP mapping is not exactly UDP 10101-10120 (got: $(tr '\n' ' ' <<<"$actual_rtp"))"
  fi
  stale=$(grep '/udp$' <<<"$pbx_ports" | awk -F/ '$1+0 >= 10000 && $1+0 <= 10100 || $1+0 >= 10121 && $1+0 <= 20000' || true)
  if [[ -n "$stale" ]]; then
    fail "PBX publishes stale RTP range: $(tr '\n' ' ' <<<"$stale")"
  else
    pass "PBX does not publish stale RTP ranges"
  fi

  rtp_settings=$($ASTERISK "rtp show settings" 2>/dev/null)
  rtp_start=$(awk '/Port start:/ {print $3; exit}' <<<"$rtp_settings")
  rtp_end=$(awk '/Port end:/ {print $3; exit}' <<<"$rtp_settings")
  # Asterisk only binds even RTP ports: an odd rtpstart (10101) is rounded up
  # to the next even port (10102). So assert the effective range is fully
  # inside the published 10101-10120 window, not byte-equal to it.
  if [[ -n "$rtp_start" && -n "$rtp_end" ]] &&
     (( 10#$rtp_start >= 10101 && 10#$rtp_end <= 10120 )) &&
     (( 10#$rtp_start <= 10#$rtp_end )); then
    pass "Asterisk effective RTP range ${rtp_start}-${rtp_end} within published 10101-10120"
  else
    fail "Asterisk effective RTP range is ${rtp_start:-unknown}-${rtp_end:-unknown}; expected within 10101-10120"
  fi

  section "PBX stack — Asterisk / ARI wiring"

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

  # Actual output: "Server Enabled and Bound to 0.0.0.0:8088". Retries for up
  # to 90s because the entrypoint's final `core restart now` can leave the
  # HTTP server briefly unavailable after the container healthcheck passes.
  # shellcheck disable=SC2086  # $ASTERISK expands to "docker exec <c> asterisk -rx"
  if wait_asterisk_cmd "Asterisk HTTP server" "Server Enabled" $ASTERISK "http show status"; then
    pass "Asterisk HTTP server enabled (http show status)"
  else
    fail "Asterisk HTTP server not enabled on 8088 (after 90s)"
  fi

  if $ASTERISK "module show like res_websocket_client" 2>/dev/null | grep -q "res_websocket_client"; then
    pass "res_websocket_client module loaded"
  else
    fail "res_websocket_client not loaded — external media WS unavailable"
  fi

  # Same startup-race handling as the HTTP check: the dialplan may not be
  # compiled yet until the entrypoint's final restart finishes.
  # The Stasis app name is dograh_<hex> (generated by dograh per config) or
  # the legacy "dograh" — match the shared prefix.
  # shellcheck disable=SC2086  # $ASTERISK expands to "docker exec <c> asterisk -rx"
  if wait_asterisk_cmd "dialplan [dograh-inbound]" "Stasis(dograh" $ASTERISK "dialplan show dograh-inbound"; then
    pass "dialplan [dograh-inbound] → Stasis app"
  else
    fail "dialplan [dograh-inbound] missing — check pbx/asterisk/extensions_custom.conf"
  fi

  # Outbound media WebSocket clients live under `ari show outbound-websockets`
  # (there is no `websocket show clients` command in this Asterisk build).
  ws_clients=$($ASTERISK "ari show outbound-websockets" 2>/dev/null)
  if [[ -n "$ws_clients" && $(echo "$ws_clients" | wc -l) -gt 2 ]]; then
    pass "media WebSocket client connected (ari show outbound-websockets)"
  elif $ASTERISK "core show version" >/dev/null 2>&1; then
    warn "media WebSocket: no outbound clients (connects per call when dograh creates externalMedia)"
  else
    skip "media WebSocket check — freepbx container not responding"
  fi

  section "PBX stack — host-side ARI REST"
  if [[ -z "${DOGRAH_ARI_PASSWORD:-}" || "$DOGRAH_ARI_PASSWORD" == "CHANGE_ME_ARI_PASSWORD" ]]; then
    skip "ARI REST check — set DOGRAH_ARI_PASSWORD in .env"
  elif [[ -z "$(ari_base)" ]]; then
    fail "ARI REST check — cannot resolve the host LAN IP (set PJSIP_MEDIA_ADDRESS in .env)"
  else
    ari_url="$(ari_base)/ari/asterisk/info"
    ari_body=$(mktemp)
    ari_code=$(curl -sS -o "$ari_body" -w '%{http_code}' --max-time 10 \
      -u "dograh:${DOGRAH_ARI_PASSWORD}" \
      "$ari_url" 2>/dev/null)
    if [[ "$ari_code" == "200" ]] && grep -q '"version"' "$ari_body"; then
      pass "ARI REST $ari_url → HTTP 200 (Asterisk $(grep -o '"version":"[^"]*"' "$ari_body" | head -1 | cut -d'"' -f4))"
    else
      fail "ARI REST $ari_url → HTTP '$ari_code' (check DOGRAH_ARI_PASSWORD + the 8088 publish on the LAN IP)"
    fi
    rm -f "$ari_body"
  fi

  section "PBX stack — WebRTC (WSS transport + registration)"
  # The pjsip WSS transport rides the Asterisk HTTP-TLS listener on 8089.
  # Verify the transport object AND the TLS listener actually exist (both
  # are required for browser SIP clients to connect).
  if $ASTERISK "pjsip show transports" 2>/dev/null | grep -q "0.0.0.0-wss"; then
    pass "WSS transport 0.0.0.0-wss present (pjsip show transports)"
  else
    fail "WSS transport 0.0.0.0-wss missing — check kvstore binds + entrypoint"
  fi
  if $ASTERISK "http show status" 2>/dev/null | grep -q "HTTPS Server Enabled and Bound to 0.0.0.0:8089"; then
    pass "Asterisk HTTPS (WSS) listener bound on 0.0.0.0:8089"
  else
    fail "HTTPS listener not on 0.0.0.0:8089 — HTTPTLSENABLE must be 1 (entrypoint)"
  fi

  # The durable WebRTC test extension (endpoint 102 + auth + aor) proves the
  # whole path with a real WSS REGISTER — same signaling a browser uses.
  if [[ -f "$ROOT/scripts/webrtc-register-test.py" ]]; then
    if python3 "$ROOT/scripts/webrtc-register-test.py" --insecure >/tmp/webrtc-register.log 2>&1; then
      pass "WebRTC WSS registration — extension 102 registered over wss://:8089 (200 OK)"
    else
      fail "WebRTC WSS registration failed — see /tmp/webrtc-register.log ($(tail -1 /tmp/webrtc-register.log 2>/dev/null))"
    fi
  else
    warn "scripts/webrtc-register-test.py missing — WebRTC registration check skipped"
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
