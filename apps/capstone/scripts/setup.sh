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
#   3. Boots both compose files (main + Asterisk/PBX)
#   4. Bootstraps the Grist Interviews doc (creates + writes GRIST_DOC_ID)
#   5. Mints an OmniRoute API key so n8n's grader can call the LLM gateway
#   6. Wires dograh's ARI telephony config (endpoint, app, routing)
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
    sed -i "s/^FREEPBX_AMI_SECRET=.*/FREEPBX_AMI_SECRET=$(openssl rand -base64 24)/" "$ENV_FILE"
    sed -i "0,/^FREEPBX_CLIENT_SECRET=.*/{s//FREEPBX_CLIENT_SECRET=$(openssl rand -hex 16)/}" "$ENV_FILE"
    sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" "$ENV_FILE"
    sed -i "s/^GRIST_API_KEY=.*/GRIST_API_KEY=change-me-grist-api-key/" "$ENV_FILE"

    # Set admin email/password for dograh (used in step 6)
    sed -i "s/^# DOGRAH_ADMIN_EMAIL=.*/DOGRAH_ADMIN_EMAIL=${DOGRAH_ADMIN_EMAIL}/" "$ENV_FILE"
    sed -i "s/^# DOGRAH_ADMIN_PASSWORD=.*/DOGRAH_ADMIN_PASSWORD=${DOGRAH_ADMIN_PASSWORD}/" "$ENV_FILE"

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

    pass "secrets written — DOGRAH_ARI_PASSWORD, OMNIROUTE passwords, JWT secrets, etc."
fi

# Load the env for the rest of the script
set -a; source "$ENV_FILE"; set +a

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
COMPOSE_LOG=$(mktemp)
if ! docker compose -f "$REPO/docker-compose.yml" -f "$REPO/docker-compose.asterisk.yml" \
    up -d --wait --remove-orphans >"$COMPOSE_LOG" 2>&1; then
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
        docker inspect "$(docker compose -f "$REPO/docker-compose.yml" -f "$REPO/docker-compose.asterisk.yml" ps -q "$svc" 2>/dev/null || echo "none")" \
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
# 6. Dograh — wire ARI telephony config via API
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 6. Dograh ARI config ──"

dograh_api_call() {
    # Helper: authenticated GET/POST/PUT to the dograh API.
    # Usage: dograh_api_call METHOD /path [json_body]
    local method="$1" path="$2" body="${3:-}"
    local headers=(-H "X-API-Key: ${DOGRAH_API_TOKEN}")
    local url="http://127.0.0.1:8000${path}"
    if [ -n "$body" ]; then
        curl -sf -X "$method" "$url" "${headers[@]}" -H "Content-Type: application/json" -d "$body" 2>&1
    else
        curl -sf -X "$method" "$url" "${headers[@]}" 2>&1
    fi
}

# 6a. Login / signup → API token
if [ -n "${DOGRAH_API_TOKEN:-}" ] && dograh_api_call GET /api/v1/user/api-keys >/dev/null 2>&1; then
    pass "dograh API token already valid"
else
    pass "logging in to dograh…"
    # Try login
    LOGIN=$(curl -sf -X POST "http://127.0.0.1:8000/api/v1/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"${DOGRAH_ADMIN_EMAIL}\",\"password\":\"${DOGRAH_ADMIN_PASSWORD}\"}" 2>&1 || echo "401")
    if echo "$LOGIN" | grep -q "token"; then
        JWT=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
    else
        # Signup first
        pass "first run — signing up dograh admin…"
        SIGNUP=$(curl -sf -X POST "http://127.0.0.1:8000/api/v1/auth/signup" \
            -H "Content-Type: application/json" \
            -d "{\"email\":\"${DOGRAH_ADMIN_EMAIL}\",\"password\":\"${DOGRAH_ADMIN_PASSWORD}\",\"name\":\"${DOGRAH_ADMIN_NAME}\"}" 2>&1)
        LOGIN=$(curl -sf -X POST "http://127.0.0.1:8000/api/v1/auth/login" \
            -H "Content-Type: application/json" \
            -d "{\"email\":\"${DOGRAH_ADMIN_EMAIL}\",\"password\":\"${DOGRAH_ADMIN_PASSWORD}\"}" 2>&1)
        JWT=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
    fi

    # Create durable X-API-Key
    API_KEY_RESP=$(curl -sf -X POST "http://127.0.0.1:8000/api/v1/user/api-keys" \
        -H "Authorization: Bearer ${JWT}" \
        -H "Content-Type: application/json" \
        -d '{"name":"capstone-setup"}' 2>&1)
    DOGRAH_API_TOKEN=$(echo "$API_KEY_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")
    sed -i "s|^# DOGRAH_API_TOKEN=.*|DOGRAH_API_TOKEN=${DOGRAH_API_TOKEN}|" "$ENV_FILE"
    export DOGRAH_API_TOKEN
    pass "dograh API token created"
fi

# 6b. Create/update ARI telephony config
CONFIGS=$(dograh_api_call GET /api/v1/organizations/telephony-configs)
CONFIG_ID=$(echo "$CONFIGS" | python3 -c "
import sys,json
configs=json.load(sys.stdin).get('configurations',[])
match=[c for c in configs if c.get('name')=='Asterisk ARI (dograh)']
print(match[0]['id'] if match else '')
" 2>/dev/null)

ARI_BODY="{\"name\":\"Asterisk ARI (dograh)\",\"is_default_outbound\":false,\"config\":{\"provider\":\"ari\",\"ari_endpoint\":\"http://127.0.0.1:8088\",\"app_name\":\"dograh\",\"app_password\":\"${DOGRAH_ARI_PASSWORD}\",\"ws_client_name\":\"dograh\",\"from_numbers\":[]}}"

if [ -z "$CONFIG_ID" ]; then
    CREATED=$(dograh_api_call POST /api/v1/organizations/telephony-configs "$ARI_BODY")
    CONFIG_ID=$(echo "$CREATED" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
    pass "ARI telephony config created ($CONFIG_ID)"
else
    dograh_api_call PUT "/api/v1/organizations/telephony-configs/${CONFIG_ID}" "$ARI_BODY" > /dev/null
    pass "ARI telephony config updated ($CONFIG_ID)"
fi

# 6c. Inbound routing: extensions → interview workflows
WORKFLOWS=$(dograh_api_call GET /api/v1/workflow/summary)
ROUTES='[{"address":"8000","workflow_name":"IT Help Desk Mock Interview"},{"address":"8001","workflow_name":"DevOps Mock Interview"},{"address":"8002","workflow_name":"SQL Mock Interview"}]'

while IFS='|' read -r ADDR WF_NAME; do
    [ -n "$ADDR" ] || continue
    WF_ID=$(echo "$WORKFLOWS" | python3 -c "
import sys,json
wf=[w for w in json.load(sys.stdin) if w.get('name')=='${WF_NAME}']
print(wf[0]['id'] if wf else '')
" 2>/dev/null)

    if [ -z "$WF_ID" ]; then
        warn "workflow '${WF_NAME}' not found — skipping route for extension ${ADDR}"
        continue
    fi

    # Check if this extension already has a phone number configured
    PHONES=$(dograh_api_call GET "/api/v1/organizations/telephony-configs/${CONFIG_ID}/phone-numbers")
    EXISTS=$(echo "$PHONES" | python3 -c "
import sys,json
pns=json.load(sys.stdin).get('phone_numbers',[])
print('yes' if any(p.get('address')=='${ADDR}' for p in pns) else '')
")
    if [ "$EXISTS" = "yes" ]; then
        pass "extension ${ADDR} already routed to ${WF_NAME}"
    else
        dograh_api_call POST "/api/v1/organizations/telephony-configs/${CONFIG_ID}/phone-numbers" \
            "{\"address\":\"${ADDR}\",\"workflow_id\":\"${WF_ID}\"}" > /dev/null
        pass "extension ${ADDR} → ${WF_NAME}"
    fi
done < <(echo "$ROUTES" | python3 -c "
import sys,json
for r in json.load(sys.stdin):
    print(f'{r[\"address\"]}|{r[\"workflow_name\"]}')
")

# ═══════════════════════════════════════════════════════════════════════════
# 7. Recreate n8n with fresh secrets
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── 7. n8n refresh ──"
docker compose -f "$REPO/docker-compose.yml" up -d --force-recreate n8n sandbox-api sandbox-runner-1 sandbox-certs 2>&1 | tail -2
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
echo "  Next steps:"
echo "    1. Generate candidate loops:   python3 scripts/gen_loops.py"
echo "    2. Place an IT call:            python3 scripts/place_call.py 8000 candidate-it"
echo "    3. Place a DevOps call:         python3 scripts/place_call.py 8001 candidate-devops"
echo "    4. Place a SQL call:            python3 scripts/place_call.py 8002 candidate-sql"
echo ""
echo "  UIs:"
echo "    FreePBX:  http://localhost:80"
echo "    n8n:      http://localhost:5678"
echo "    Grist:    http://localhost:8484"
echo "    SigNoz:   http://localhost:3301"
echo "    OmniRoute: http://localhost:20128"
echo ""