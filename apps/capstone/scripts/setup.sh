#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# setup.sh — one-command bootstrap for the Capstone AI Voice Interview Stack
#
# Usage:
#   git clone https://github.com/innotelinc/capstone.git && cd capstone
#   ./scripts/setup.sh
#   # Stack is up, smoke test passes, ready for calls.
#
# What it does:
#   1. Checks prereqs (docker, openssl, python3)
#   2. Generates .env from .env.example with fresh random secrets
#  2b. Clones the dograh platform source (github.com/innotelinc/dograh) into
#      dograh/upstream for reference + optional build-from-source
#   3. Boots both compose files (main + Asterisk/PBX)
#   4. Bootstraps the Grist Interviews doc (creates + writes GRIST_DOC_ID)
#   5. Mints an OmniRoute API key so n8n's grader can call the LLM gateway
#   6. Wires dograh end-to-end (scripts/dograh_wire.py): imports the three
#      interview agent workflows, creates the Asterisk ARI telephony config
#      (shows up in the dograh UI), and binds extensions 8000/8001/8002
#  6b. Wires the FreePBX half: inbound routes DID 8000/8001/8002 → dograh
#   7. Recreates n8n with the fresh secrets so the grader chain is live
#   8. Runs the smoke test
#
# Idempotent — safe to re-run.  If .env already exists, the script skips
# secret generation (you keep your custom values) and only refreshes the
# parts that are missing or stale.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO/.env"
ENV_EXAMPLE="$REPO/.env.example"
DOGRAH_ADMIN_EMAIL="${DOGRAH_ADMIN_EMAIL:-ops@capstone.example}"
DOGRAH_ADMIN_PASSWORD="${DOGRAH_ADMIN_PASSWORD:-capstone-ops-$(date +%s)}"
DOGRAH_ADMIN_NAME="${DOGRAH_ADMIN_NAME:-Capstone Ops}"
OMNIROUTE_ADMIN_PASSWORD="${OMNIROUTE_ADMIN_PASSWORD:-capstone-omni-$(date +%s)}"
GRIST_ADMIN_EMAIL="${GRIST_ADMIN_EMAIL:-admin@localhost}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}PASS${NC} $*"; }
warn() { echo -e "${YELLOW}WARN${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; exit 1; }

echo "══════════════════════════════════════════════════════════════"
echo "  Capstone Stack — Setup"
echo "══════════════════════════════════════════════════════════════"

# ═══════════════════════════════════════════════════════════════════════════
# 1. Prerequisites
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 1. Prerequisites ──"
command -v docker &>/dev/null   || fail "docker not found — install Docker first"
command -v openssl &>/dev/null  || fail "openssl not found — install it (apt install openssl)"
command -v python3 &>/dev/null  || fail "python3 not found"
command -v curl &>/dev/null     || fail "curl not found"
docker compose version &>/dev/null || fail "docker compose plugin not found (need Docker Compose v2)"
pass "docker $(docker --version | awk '{print $3}' | tr -d ','), openssl $(openssl version | awk '{print $2}'), python3 $(python3 --version | awk '{print $2}'), curl ok"

# ═══════════════════════════════════════════════════════════════════════════
# 2. Generate .env with fresh secrets
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 2. Environment (.env) ──"
if [ -f "$ENV_FILE" ]; then
    pass ".env already exists — keeping your secrets"
else
    pass "generating .env from .env.example with fresh random secrets"

    # Start from the template
    cp "$ENV_EXAMPLE" "$ENV_FILE"

    # Replace every change-me with a fresh random secret
    sed -i "s/^OSS_JWT_SECRET=.*/OSS_JWT_SECRET=$(openssl rand -base64 48)/" "$ENV_FILE"
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" "$ENV_FILE"
    sed -i "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=$(openssl rand -hex 16)/" "$ENV_FILE"
    sed -i "s/^MINIO_ROOT_USER=.*/MINIO_ROOT_USER=minioadmin/" "$ENV_FILE"
    sed -i "s/^MINIO_ROOT_PASSWORD=.*/MINIO_ROOT_PASSWORD=$(openssl rand -hex 16)/" "$ENV_FILE"
    sed -i "s/^OMNIROUTE_JWT_SECRET=.*/OMNIROUTE_JWT_SECRET=$(openssl rand -base64 48)/" "$ENV_FILE"
    sed -i "s/^OMNIROUTE_API_KEY_SECRET=.*/OMNIROUTE_API_KEY_SECRET=$(openssl rand -hex 32)/" "$ENV_FILE"
    sed -i "s/^OMNIROUTE_INITIAL_PASSWORD=.*/OMNIROUTE_INITIAL_PASSWORD=${OMNIROUTE_ADMIN_PASSWORD}/" "$ENV_FILE"
    sed -i "s/^OMNIROUTE_WS_BRIDGE_SECRET=.*/OMNIROUTE_WS_BRIDGE_SECRET=$(openssl rand -base64 32)/" "$ENV_FILE"
    sed -i "s/^OMNIROUTE_API_KEY=.*/OMNIROUTE_API_KEY=/" "$ENV_FILE"
    sed -i "s/^N8N_USER_MANAGEMENT_JWT_SECRET=.*/N8N_USER_MANAGEMENT_JWT_SECRET=$(openssl rand -base64 32)/" "$ENV_FILE"
    sed -i "s/^GRIST_API_KEY=.*/GRIST_API_KEY=/" "$ENV_FILE"
    sed -i "s/^SANDBOX_API_KEYS=.*/SANDBOX_API_KEYS=$(openssl rand -hex 32)/" "$ENV_FILE"
    sed -i "s/^SANDBOX_API_RUNNER_REGISTRATION_TOKEN=.*/SANDBOX_API_RUNNER_REGISTRATION_TOKEN=$(openssl rand -hex 32)/" "$ENV_FILE"
    sed -i "s/^SANDBOX_API_RUNNER_API_KEY=.*/SANDBOX_API_RUNNER_API_KEY=$(openssl rand -hex 32)/" "$ENV_FILE"
    sed -i "s/^SEARXNG_SECRET=.*/SEARXNG_SECRET=$(openssl rand -hex 32)/" "$ENV_FILE"
    sed -i "s/^SIGNOZ_POSTGRES_PASSWORD=.*/SIGNOZ_POSTGRES_PASSWORD=$(openssl rand -hex 16)/" "$ENV_FILE"
    sed -i "s/^SIGNOZ_JWT_SECRET=.*/SIGNOZ_JWT_SECRET=$(openssl rand -hex 32)/" "$ENV_FILE"
    sed -i "s/^DOGRAH_ARI_PASSWORD=.*/DOGRAH_ARI_PASSWORD=$(openssl rand -base64 24)/" "$ENV_FILE"
    sed -i "s/^TURN_USERNAME=.*/TURN_USERNAME=turnuser-$(openssl rand -hex 6)/" "$ENV_FILE"
    sed -i "s/^TURN_PASSWORD=.*/TURN_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')/" "$ENV_FILE"
    sed -i "s/^FREEPBX_AMI_SECRET=.*/FREEPBX_AMI_SECRET=$(openssl rand -base64 24)/" "$ENV_FILE"
    sed -i "0,/^FREEPBX_CLIENT_SECRET=.*/{s//FREEPBX_CLIENT_SECRET=$(openssl rand -hex 16)/}" "$ENV_FILE"
    sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" "$ENV_FILE"
    sed -i "s/^GRIST_API_KEY=.*/GRIST_API_KEY=change-me-grist-api-key/" "$ENV_FILE"

    # Set admin email/password for dograh (used in step 6). The line may be
    # commented or active in .env.example — handle both.
    sed -i "/^# DOGRAH_ADMIN_EMAIL=/s//DOGRAH_ADMIN_EMAIL=${DOGRAH_ADMIN_EMAIL}/" "$ENV_FILE"
    sed -i "s/^DOGRAH_ADMIN_EMAIL=.*/DOGRAH_ADMIN_EMAIL=${DOGRAH_ADMIN_EMAIL}/" "$ENV_FILE"
    sed -i "/^# DOGRAH_ADMIN_PASSWORD=/s//DOGRAH_ADMIN_PASSWORD=${DOGRAH_ADMIN_PASSWORD}/" "$ENV_FILE"
    sed -i "s/^DOGRAH_ADMIN_PASSWORD=.*/DOGRAH_ADMIN_PASSWORD=${DOGRAH_ADMIN_PASSWORD}/" "$ENV_FILE"

    # Detect a host-reachable IP for BACKEND_API_ENDPOINT (n8n needs this).
    # Fall back to host.docker.internal if no LAN IP, then localhost.
    HOST_IP=$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1 || true)
    if [ -z "$HOST_IP" ]; then
        HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    fi
    if [ -z "$HOST_IP" ] || [ "$HOST_IP" = "127.0.0.1" ]; then
        warn "no LAN IP detected — BACKEND_API_ENDPOINT will use localhost (n8n transcript fetch may 404)"
        echo "Set BACKEND_API_ENDPOINT to this host's LAN IP in .env before placing calls."
    fi
    HOST_IP="${HOST_IP:-127.0.0.1}"
    sed -i "s|^BACKEND_API_ENDPOINT=.*|BACKEND_API_ENDPOINT=http://${HOST_IP}:8000|" "$ENV_FILE"
    sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=http://${HOST_IP}:8000|" "$ENV_FILE"
    # Coturn needs an externally reachable address and a matching realm. Use
    # the host's public IPv4 when available; fall back to localhost for local
    # development. Preserve explicit user values on reruns.
    TURN_IP="${TURN_EXTERNAL_IP:-}"
    if [ -z "$TURN_IP" ] || [ "$TURN_IP" = "127.0.0.1" ] || [ "$TURN_IP" = "203.0.113.10" ]; then
        TURN_IP=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
    fi
    TURN_IP="${TURN_IP:-127.0.0.1}"
    sed -i "s|^TURN_EXTERNAL_IP=.*|TURN_EXTERNAL_IP=${TURN_IP}|" "$ENV_FILE"
    sed -i "s|^TURN_REALM=.*|TURN_REALM=${TURN_IP}|" "$ENV_FILE"
    sed -i "s|^TURN_LISTENING_PORT=.*|TURN_LISTENING_PORT=3478|" "$ENV_FILE"
    sed -i "s|^TURN_RELAY_PORT_START=.*|TURN_RELAY_PORT_START=49152|" "$ENV_FILE"
    sed -i "s|^TURN_RELAY_PORT_END=.*|TURN_RELAY_PORT_END=49251|" "$ENV_FILE"

    pass "secrets written — DOGRAH_ARI_PASSWORD, OMNIROUTE passwords, JWT secrets, etc."
fi

# Load the env for the rest of the script
set -a; source "$ENV_FILE"; set +a

# Ensure existing installations also receive generated TURN settings. Explicit
# non-placeholder values are preserved on reruns.
turn_changed=0
if [ -z "${TURN_USERNAME:-}" ] || [ "${TURN_USERNAME}" = "turnuser" ]; then
    TURN_USERNAME="turnuser-$(openssl rand -hex 6)"
    turn_changed=1
fi
if [ -z "${TURN_PASSWORD:-}" ] || [[ "${TURN_PASSWORD}" == change-me* ]]; then
    TURN_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=')"
    turn_changed=1
fi
if [ -z "${TURN_EXTERNAL_IP:-}" ] || [ "${TURN_EXTERNAL_IP}" = "127.0.0.1" ] || [ "${TURN_EXTERNAL_IP}" = "203.0.113.10" ]; then
    TURN_EXTERNAL_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP:-127.0.0.1}"
    turn_changed=1
fi
if [ -z "${TURN_REALM:-}" ] || [ "${TURN_REALM}" = "turn.example.com" ]; then
    TURN_REALM="$TURN_EXTERNAL_IP"
    turn_changed=1
fi
if [ "$turn_changed" -eq 1 ]; then
    sed -i "s|^TURN_USERNAME=.*|TURN_USERNAME=${TURN_USERNAME}|" "$ENV_FILE"
    sed -i "s|^TURN_PASSWORD=.*|TURN_PASSWORD=${TURN_PASSWORD}|" "$ENV_FILE"
    sed -i "s|^TURN_EXTERNAL_IP=.*|TURN_EXTERNAL_IP=${TURN_EXTERNAL_IP}|" "$ENV_FILE"
    sed -i "s|^TURN_REALM=.*|TURN_REALM=${TURN_REALM}|" "$ENV_FILE"
    export TURN_USERNAME TURN_PASSWORD TURN_EXTERNAL_IP TURN_REALM
    pass "Coturn credentials and endpoint persisted to .env (realm: ${TURN_REALM})"
else
    pass "Coturn settings already configured in .env (realm: ${TURN_REALM})"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 2b. dograh platform source (github.com/innotelinc/dograh)
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 2b. dograh platform source ──"
DOGRAH_AGENT_REPO="${DOGRAH_AGENT_REPO:-https://github.com/innotelinc/dograh.git}"
DOGRAH_UPSTREAM_DIR="$REPO/dograh/upstream"
if [ -d "$DOGRAH_UPSTREAM_DIR/.git" ]; then
    pass "dograh/upstream already cloned — delete it to refresh"
else
    if git clone --depth 1 --quiet "$DOGRAH_AGENT_REPO" "$DOGRAH_UPSTREAM_DIR" 2>&1; then
        pass "cloned ${DOGRAH_AGENT_REPO} → dograh/upstream (shallow)"
    else
        warn "could not clone the dograh source (offline?) — the stack uses the prebuilt image, so this is non-fatal"
    fi
fi
# Building dograh-api from source needs the pipecat submodule + 10-20 min.
# Only initialize it when a source build was requested.
if [ "${DOGRAH_BUILD_FROM_SOURCE:-0}" = "1" ] && [ -d "$DOGRAH_UPSTREAM_DIR/.git" ]; then
    (cd "$DOGRAH_UPSTREAM_DIR" && git submodule update --init --recursive) \
        && pass "pipecat submodule initialized (DOGRAH_BUILD_FROM_SOURCE=1)" \
        || warn "submodule init failed — docker-compose.dograh-build.yml won't build until it succeeds"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 3. Boot both composes
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 3. Boot stack ──"
# The PBX compose treats interview-net as an external shared network. Create it
# on first run so a fresh Docker host can boot both compose files.
if ! docker network inspect interview-net >/dev/null 2>&1; then
    docker network create interview-net >/dev/null \
        || fail "could not create Docker network interview-net"
    pass "created Docker network interview-net"
fi
# The PBX compose reuses named external volumes so it can share state with the
# pbx-portal deployment. Create them on a fresh host; existing volumes remain
# untouched.
for volume in pbx-asterisk-config pbx-asterisk-sounds pbx-asterisk-spool \
             pbx-freepbx-www pbx-mariadb-data pbx-portal-data; do
    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
        docker volume create "$volume" >/dev/null \
            || fail "could not create Docker volume $volume"
        pass "created Docker volume $volume"
    fi
done
# (reused for quieter compose output)
COMPOSE_LOG=$(mktemp)
# The compose defaults to the Innotel fork's dograh images. If they aren't
# published yet (or present locally), fall back to building both the api and
# the ui from the innotelinc/dograh fork source (docker-compose.dograh-build.yml).
BASE_COMPOSE=(--env-file "$ENV_FILE" -f "$REPO/docker-compose.yml" -f "$REPO/docker-compose.asterisk.yml")
DOGRAH_IMAGES=(innotelinc/dograh-api:latest innotelinc/dograh-ui:latest)
NEED_BUILD=0
for img in "${DOGRAH_IMAGES[@]}"; do
    if ! docker image inspect "$img" >/dev/null 2>&1; then
        NEED_BUILD=1
        warn "$img not present locally — will build dograh api+ui from the innotelinc/dograh fork source"
        break
    fi
done
if [ "$NEED_BUILD" -eq 1 ]; then
    # The dograh api image build needs the pipecat submodule; the ui build
    # needs npm. Initialize the fork submodules up front (~minutes, first
    # time only) so the source build succeeds.
    if [ -d "$REPO/dograh/upstream/.git" ]; then
        git -C "$REPO/dograh/upstream" submodule update --init --recursive \
            >/dev/null 2>&1 || warn "could not init dograh submodules — the api build may fail"
    fi
    BASE_COMPOSE+=(-f "$REPO/docker-compose.dograh-build.yml")
    BUILD_ARGS=(--build dograh-api dograh-ui)
else
    BUILD_ARGS=()
fi
if ! docker compose "${BASE_COMPOSE[@]}" up -d --wait --remove-orphans "${BUILD_ARGS[@]}" >"$COMPOSE_LOG" 2>&1; then
    cat "$COMPOSE_LOG" >&2
    rm -f "$COMPOSE_LOG"
    fail "Docker Compose failed to boot the stack"
fi
cat "$COMPOSE_LOG" | tail -3
rm -f "$COMPOSE_LOG"
pass "both composes up — waiting for healthy…"

# --wait should have held until healthy; double-check
for svc in postgres redis minio kokoro speaches omniroute n8n grist signoz freepbx dograh-api; do
    # dograh-api uses host mode, so `docker compose ps` won't show a healthcheck —
    # we check its port instead.
    if [ "$svc" = "dograh-api" ]; then
        timeout 60 bash -c "until curl -sf http://127.0.0.1:8000/api/v1/health >/dev/null 2>&1; do sleep 2; done" \
            && pass "dograh-api up (port 8000)" \
            || warn "dograh-api not yet reachable (may still be starting)"
    else
        docker inspect "$(docker compose --env-file "$ENV_FILE" -f "$REPO/docker-compose.yml" -f "$REPO/docker-compose.asterisk.yml" ps -q "$svc" 2>/dev/null || echo "none")" \
            --format '{{.State.Health.Status}}' 2>/dev/null | grep -q healthy \
            && pass "$svc healthy" \
            || warn "$svc not healthy yet"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════
# 4. Grist bootstrap — create Interviews doc + table
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 4. Grist bootstrap ──"

# The n8n grader writes to Grist.  The doc must be owner-scoped (anonymous writes
# are denied), so we need a real API key.  Mint one in the Grist home DB if not
# already set.
mint_grist_key() {
    local key="$GRIST_API_KEY"
    if [ -n "$key" ] && [[ "$key" != *change-me* ]]; then
        echo "GRIST_API_KEY already set"
        return 0
    fi
    echo "  minting Grist API key in home DB…"
    # Copy the DB out, write the key, copy back, restart
    docker cp grist:/persist/home.sqlite3 /tmp/grist-home-setup.db 2>/dev/null || {
        warn "could not copy Grist home DB — skipping (set GRIST_API_KEY manually)"
        return 1
    }
    local new_key="grist_$(openssl rand -hex 32)"
    python3 -c "
import sqlite3
db = sqlite3.connect('/tmp/grist-home-setup.db')
# Find the first non-system user (name != Anonymous/Preview/Everyone/Support)
db.execute(\"UPDATE users SET api_key = ? WHERE name = 'You' OR name = ?\",
           ('${new_key}', 'admin@localhost'))
db.commit()
print(f'updated {db.total_changes} row(s)')
db.close()
"
    docker cp /tmp/grist-home-setup.db grist:/persist/home.sqlite3 2>/dev/null
    docker compose -f "$REPO/docker-compose.yml" restart grist 2>&1 | tail -1
    # Wait for Grist to restart and verify the key against an authenticated
    # endpoint. A fixed sleep is unreliable on slower hosts.
    for attempt in $(seq 1 30); do
        if curl -sf -H "Authorization: Bearer ${new_key}" "http://127.0.0.1:8484/api/orgs" > /dev/null 2>&1; then
            sed -i "s|^GRIST_API_KEY=.*|GRIST_API_KEY=${new_key}|" "$ENV_FILE"
            export GRIST_API_KEY="$new_key"
            return 0
        fi
        sleep 2
    done
    warn "Grist did not accept the new key — set GRIST_API_KEY manually"
    return 1
}

mint_grist_key
GRIST_DOC_READY=0
if [ -n "${GRIST_DOC_ID:-}" ] && [[ "$GRIST_DOC_ID" != new* ]] && [[ "$GRIST_DOC_ID" != *change-me* ]]; then
    if curl -sf -H "Authorization: Bearer ${GRIST_API_KEY:-}" \
        "http://127.0.0.1:8484/api/docs/${GRIST_DOC_ID}" >/dev/null 2>&1; then
        GRIST_DOC_READY=1
    fi
fi
if [ "$GRIST_DOC_READY" -eq 0 ]; then
    pass "creating Grist Interviews doc…"
    GRIST_BOOTSTRAP_LOG=$(mktemp)
    if ! python3 "$REPO/scripts/grist_bootstrap.py" >"$GRIST_BOOTSTRAP_LOG" 2>&1; then
        cat "$GRIST_BOOTSTRAP_LOG" >&2
        rm -f "$GRIST_BOOTSTRAP_LOG"
        fail "grist_bootstrap.py failed"
    fi
    cat "$GRIST_BOOTSTRAP_LOG"
    DOC_ID=$(grep -oP 'GRIST_DOC_ID=\K.*' "$GRIST_BOOTSTRAP_LOG" | tail -1)
    rm -f "$GRIST_BOOTSTRAP_LOG"
    if [ -n "$DOC_ID" ]; then
        sed -i "s|^GRIST_DOC_ID=.*|GRIST_DOC_ID=$DOC_ID|" "$ENV_FILE"
        export GRIST_DOC_ID="$DOC_ID"
        pass "GRIST_DOC_ID=$DOC_ID"
    else
        fail "grist_bootstrap.py did not produce a doc ID"
    fi
else
    pass "GRIST_DOC_ID already set ($GRIST_DOC_ID)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 5. OmniRoute — mint an API key for the n8n grader
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 5. OmniRoute API key ──"

# If OMNIROUTE_API_KEY is missing, a placeholder, or no longer valid, mint a
# fresh key automatically. The generated key is persisted in .env and then
# passed to n8n and the smoke test on the next steps.
if [ -z "${OMNIROUTE_API_KEY:-}" ] || [[ "$OMNIROUTE_API_KEY" == *change-me* ]] || [[ "$OMNIROUTE_API_KEY" == sk-change* ]] || \
   ! curl -sf -H "Authorization: Bearer ${OMNIROUTE_API_KEY}" "http://127.0.0.1:20128/v1/models" >/dev/null 2>&1; then
    pass "minting OmniRoute API key…"
    # Login to get auth cookie
    COOKIE_FILE=$(mktemp)
    LOGIN_BODY=$(curl -sf -c "$COOKIE_FILE" -X POST "http://127.0.0.1:20128/api/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"password\":\"${OMNIROUTE_INITIAL_PASSWORD}\"}" 2>&1 || true)
    COOKIE=$(awk '$6 == "auth_token" {print $7}' "$COOKIE_FILE" | tail -1)
    if [ -z "$COOKIE" ]; then
        rm -f "$COOKIE_FILE"
        fail "OmniRoute login failed — is the container up and OMNIROUTE_INITIAL_PASSWORD correct? response: ${LOGIN_BODY:-empty}"
    fi

    # The key endpoint expects the auth cookie, not a bearer token.
    KEY_RESP=$(curl -sf -X POST "http://127.0.0.1:20128/api/keys" \
        -b "$COOKIE_FILE" \
        -H "Content-Type: application/json" \
        -d '{"name":"capstone-grader"}' 2>&1) || {
        rm -f "$COOKIE_FILE"
        fail "OmniRoute key creation failed — response: $KEY_RESP"
    }
    rm -f "$COOKIE_FILE"
    KEY=$(echo "$KEY_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
    if [ -z "$KEY" ]; then
        fail "OmniRoute login failed — is the container up and OMNIROUTE_INITIAL_PASSWORD correct?"
    fi

    sed -i "s|^OMNIROUTE_API_KEY=.*|OMNIROUTE_API_KEY=$KEY|" "$ENV_FILE"
    export OMNIROUTE_API_KEY="$KEY"
    pass "OMNIROUTE_API_KEY=minted"
else
    pass "OMNIROUTE_API_KEY already valid"
fi

# Speaches downloads remote models through the model-id path endpoint. This
# operation is idempotent once the model is installed.
echo ""
echo "── 5b. Speaches Whisper model ──"
WHISPER_MODEL="${SPEACHES_WHISPER_MODEL:-Systran/faster-distil-whisper-small.en}"
MODEL_STATUS=$(curl -sS --max-time 15 -o /tmp/speaches-models.json -w '%{http_code}' \
    http://127.0.0.1:8001/v1/models 2>/dev/null || true)
if [ "$MODEL_STATUS" = "200" ] && grep -q '"id"[[:space:]]*:[[:space:]]*"'"${WHISPER_MODEL}"'"' /tmp/speaches-models.json; then
    pass "Speaches model already installed (${WHISPER_MODEL})"
else
    pass "downloading Speaches model (${WHISPER_MODEL})…"
    MODEL_RESP=$(curl -sf --max-time 900 -X POST \
        "http://127.0.0.1:8001/v1/models/${WHISPER_MODEL}" 2>&1) || \
        fail "Speaches model download failed: ${MODEL_RESP:-no response}"
    pass "Speaches model installed"
fi
rm -f /tmp/speaches-models.json

# OmniRoute cannot select a cloud free tier without provider credentials. When
# supplied, these optional variables let deployments configure a provider via
# the dashboard/API-specific hook without putting fake credentials in .env.
if [ -n "${OMNIROUTE_FREE_PROVIDER_ID:-}" ] && [ -n "${OMNIROUTE_FREE_PROVIDER_API_KEY:-}" ]; then
    warn "OMNIROUTE_FREE_PROVIDER_ID/API_KEY supplied; configure this provider in OmniRoute before calls"
else
    warn "no OmniRoute provider credentials supplied — using the gateway's configured providers; no paid provider is added"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 6. Dograh — import the interview agents + wire the ARI telephony config
#    + bind extensions 8000/8001/8002 (all idempotent, no UI clicks)
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 6. Dograh wiring (agents, ARI config, extensions 8000-8002) ──"
python3 "$REPO/scripts/dograh_wire.py" --env-file "$ENV_FILE" \
    || fail "dograh wiring failed — fix the error above, then re-run ./scripts/setup.sh"
pass "dograh wired: 3 interview agents, ARI telephony config, extensions 8000/8001/8002"

# ═══════════════════════════════════════════════════════════════════════════
# 6b. FreePBX inbound routes (the PBX half of extension routing)
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 6b. FreePBX inbound routes (DID 8000/8001/8002 → dograh) ──"
if [ -z "${FREEPBX_CLIENT_SECRET:-}" ]; then
    warn "FREEPBX_CLIENT_SECRET unset — cannot script the FreePBX inbound routes"
else
    for did in 8000 8001 8002; do
        # Idempotent: creates the custom destination + inbound route when
        # missing, then verifies the live dialplan. Waits for the FreePBX API
        # itself, so no extra readiness polling is needed here.
        if python3 "$REPO/pbx/bootstrap_dograh_route.py" --did "$did" --exten "$did"; then
            pass "inbound route DID ${did} → dograh-inbound,${did},1"
        else
            warn "inbound route for DID ${did} failed (FreePBX API not ready?) — re-run later:"
            warn "    python3 pbx/bootstrap_dograh_route.py --did ${did} --exten ${did}"
            break
        fi
    done
fi

# ═══════════════════════════════════════════════════════════════════════════
# 7. Recreate n8n with fresh secrets
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 7. n8n refresh ──"
docker compose --env-file "$ENV_FILE" -f "$REPO/docker-compose.yml" up -d --force-recreate n8n sandbox-api sandbox-runner-1 sandbox-certs 2>&1 | tail -2
# Ensure host-mode dograh is explicitly running after bootstrap. The service has
# restart: unless-stopped in Compose, so this is safe and idempotent.
docker compose -f "$REPO/docker-compose.yml" up -d dograh-api >/dev/null
pass "dograh-api started automatically"
timeout 30 bash -c "until curl -sf http://127.0.0.1:5678/healthz >/dev/null 2>&1; do sleep 2; done" \
    && pass "n8n restarted with fresh env" \
    || warn "n8n still starting — check docker compose ps"

# ═══════════════════════════════════════════════════════════════════════════
# 8. Smoke test
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 8. Smoke test ──"
echo ""
timeout 300 "$REPO/scripts/smoke-test.sh" 2>&1 || warn "some smoke checks failed — re-run scripts/smoke-test.sh to diagnose"

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo "══════════════════════════════════════════════════════════════════"
echo ""
echo "  Interview agents (imported + wired, ready for calls):"
echo "    ext 8000 → IT Help Desk    ext 8001 → DevOps    ext 8002 → SQL"
echo "  Dial them from a SIP softphone registered to the PBX, or place a"
echo "  scripted test call:"
echo ""
echo "  Next steps:"
echo "    1. Generate candidate loops:   python3 scripts/gen_loops.py"
echo "    2. Place an IT call:            python3 scripts/place_call.py 8000 candidate-it"
echo "    3. Place a DevOps call:         python3 scripts/place_call.py 8001 candidate-devops"
echo "    4. Place a SQL call:            python3 scripts/place_call.py 8002 candidate-sql"
echo ""
echo "  UIs:"
echo "    Dograh UI: http://localhost:3010  (login: DOGRAH_ADMIN_EMAIL/PASSWORD —"
echo "               Telephony Configurations already shows the Asterisk ARI config)"
echo "    FreePBX:  http://localhost:80"
echo "    n8n:      http://localhost:5678"
echo "    Grist:    http://localhost:8484"
echo "    SigNoz:   http://localhost:3301"
echo "    OmniRoute: http://localhost:20128"
echo ""