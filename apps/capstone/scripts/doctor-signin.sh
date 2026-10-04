#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# doctor-signin.sh — walk the voice-app sign-in chain and name what's broken.
#
# "Sign-in could not be completed. Please try again." is the browser's message
# for EVERY failure in the dograh/Cerulean OIDC chain, so this checks each link
# the way a browser walks it and reports the one that isn't holding:
#
#   1. credential   — does dograh-api actually hold a real client secret, or the
#                     literal `vault://…` reference compose interpolated?
#   2. UI proxy     — does /api/v1/auth/oidc/login answer 307 + a state cookie,
#                     or 200 with Authentik's HTML (state cookie swallowed)?
#   3. admission    — is AUTHENTIK_ALLOWED_GROUPS set, and do users carry it?
#
# Read-only: it resolves nothing and changes nothing. Exit 1 if any check FAILs.
#
# Usage (from the repo root):
#   ./scripts/doctor-signin.sh
#   ./scripts/doctor-signin.sh --url https://capstone.innotel.us
#
# Requires docker + curl on the host.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO}/.env"
PUBLIC_URL="http://localhost:3010"   # host port dograh-ui publishes
DOGRAH_CONTAINER="dograh-api"

while [ $# -gt 0 ]; do
  case "$1" in
    --url)       PUBLIC_URL="${2:?--url needs a value}"; shift ;;
    --env-file)  ENV_FILE="${2:?--env-file needs a value}"; shift ;;
    --container) DOGRAH_CONTAINER="${2:?--container needs a value}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
info() { printf '    %s\n' "$1"; }
FAILED=0

cfg() { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }

echo "── 1. credential (vault:// must be resolved before compose) ──"
secret="$(cfg AUTHENTIK_CLIENT_SECRET || true)"
if [ -z "$secret" ]; then
  warn "AUTHENTIK_CLIENT_SECRET is unset in $ENV_FILE (AUTH_PROVIDER=oidc still needs it)"
elif printf '%s' "$secret" | grep -q '^vault://'; then
  fail "$ENV_FILE holds a literal vault:// reference — start the stack with scripts/compose-vault.sh"
  info "reference: $secret"
else
  pass "AUTHENTIK_CLIENT_SECRET is a concrete value in $ENV_FILE"
fi

if docker inspect "$DOGRAH_CONTAINER" >/dev/null 2>&1; then
  # What the container actually received — never trust .env alone. Print a
  # prefix and a digest, never the secret itself.
  probe="$(docker exec "$DOGRAH_CONTAINER" python3 -c "
import hashlib, os
v = os.environ.get('AUTHENTIK_CLIENT_SECRET', '')
print(len(v), hashlib.sha256(v.encode()).hexdigest()[:12], v.startswith('vault://'))
" 2>/dev/null || true)"
  if [ -z "$probe" ]; then
    warn "could not read the container env (python3 missing inside?)"
  elif printf '%s' "$probe" | grep -q 'True'; then
    fail "dograh-api received the vault:// REFERENCE as its client secret — that is the token-exchange failure"
  else
    pass "dograh-api holds a concrete secret (len / sha12 / is-vault-ref: ${probe})"
  fi
  auth_provider="$(docker exec "$DOGRAH_CONTAINER" python3 -c "import os; print(os.environ.get('AUTH_PROVIDER',''))" 2>/dev/null || true)"
  if [ "$auth_provider" = "oidc" ]; then
    pass "AUTH_PROVIDER=oidc inside dograh-api"
  else
    warn "AUTH_PROVIDER='${auth_provider:-<unset>}' inside dograh-api (want 'oidc' for Cerulean sign-in)"
  fi
else
  warn "container '$DOGRAH_CONTAINER' is not running — skipping the container-env check"
fi

echo ""
echo "── 2. UI proxy redirect mode (must be 307 + state cookie, not 200) ──"
login_url="${PUBLIC_URL%/}/api/v1/auth/oidc/login"
headers="$(curl -sS -D - -o /dev/null --max-time 15 "$login_url" 2>/dev/null || true)"
if [ -z "$headers" ]; then
  fail "no response from $login_url (is the voice app up / the URL right?)"
else
  status="$(printf '%s' "$headers" | head -1)"
  if printf '%s' "$status" | grep -qE '3(01|02|07|08)'; then
    pass "login entry answers a redirect: ${status}"
    if printf '%s' "$headers" | grep -qi '^set-cookie:.*dograh_oidc_state'; then
      pass "state cookie is set on the login response"
    else
      fail "redirect has NO dograh_oidc_state cookie — the UI proxy is swallowing it (rebuild dograh-ui with dograh/patches/0001, redirect: \"manual\")"
    fi
  elif printf '%s' "$status" | grep -q '200'; then
    fail "login entry answers 200 (Authentik's page rendered on the app origin) — the UI proxy followed the redirect server-side; rebuild dograh-ui with dograh/patches/0001"
  else
    fail "unexpected login-entry response: ${status}"
  fi
fi

echo ""
echo "── 3. admission (allowed group membership) ──"
groups="$(cfg AUTHENTIK_ALLOWED_GROUPS || true)"
if [ -z "$groups" ]; then
  warn "AUTHENTIK_ALLOWED_GROUPS is unset — any authenticated Cerulean user may sign in"
else
  pass "AUTHENTIK_ALLOWED_GROUPS=${groups}"
fi

ak_db="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'authentik.*(postgres|db)|postgres.*authentik' | head -1 || true)"
group="${groups%%,*}"
if [ -n "$ak_db" ] && [ -n "$group" ]; then
  members="$(docker exec "$ak_db" psql -U authentik -d authentik -tAc \
    "SELECT string_agg(u.email, ', ') FROM authentik_core_user u \
     JOIN authentik_core_user_groups gu ON gu.user_id=u.id \
     JOIN authentik_core_group g ON g.group_uuid=gu.group_id WHERE g.name='${group}';" 2>/dev/null || true)"
  if [ -n "$members" ]; then
    pass "group '${group}' members: ${members}"
  else
    warn "group '${group}' has no members (or the query needs the right DB container)"
  fi
else
  info "check membership by hand (Authentik DB container not auto-detected):"
  info "docker exec <authentik-postgres> psql -U authentik -d authentik -tAc \\"
  info "  \"SELECT u.email FROM authentik_core_user u JOIN authentik_core_user_groups gu ON gu.user_id=u.id \\"
  info "   JOIN authentik_core_group g ON g.group_uuid=gu.group_id WHERE g.name='${group:-cerulean-platform}'\""
fi

echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "RESULT: at least one gate FAILED — see docs/operations.md § 'Voice app login (dograh OIDC)'."
  exit 1
fi
echo "RESULT: the checked gates passed. If sign-in still fails, the callback is the next stop:"
echo "  docker logs --since 10m ${DOGRAH_CONTAINER} 2>&1 | grep -iE 'Token exchange|UniqueViolation|already belongs|adopted'"
