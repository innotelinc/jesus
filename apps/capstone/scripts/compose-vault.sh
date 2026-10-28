#!/usr/bin/env bash
# compose-vault.sh — run docker compose with this stack's `vault://` references resolved.
#
# The stack's secrets live in Cerulean Vault (HashiCorp Vault, KV v2), so `.env`
# may hold `KEY=vault://<mount>/<path>#<key>` instead of the secret itself.
# Compose cannot resolve that: it interpolates `.env` literally, so a service
# configured as `AUTHENTIK_CLIENT_SECRET: "${AUTHENTIK_CLIENT_SECRET:-}"`
# receives the *reference string* as its credential. That is exactly how the
# dograh OIDC login failed — the token exchange posted
# `client_secret=vault://cerulean/capstone#AUTHENTIK_CLIENT_SECRET` and
# Authentik answered `invalid_client`, with nothing in the API log saying why
# ("Token exchange rejected by the identity provider").
#
# So: resolve first, then compose. This runs `scripts/vault-env.py`, which is
# the estate's resolver, and hands compose the resolved file via --env-file —
# which replaces `.env` as the interpolation source, not augments it, so the
# resolved file must be a complete copy. It is (vault-env writes one).
#
#   scripts/compose-vault.sh up -d dograh-api
#   scripts/compose-vault.sh -f docker-compose.yml -f docker-compose.dograh-build.yml up -d --no-build
#   scripts/compose-vault.sh --check          # resolve and report, run nothing
#
# Every `docker compose` invocation for this stack should go through here; a
# plain `docker compose up` silently regresses any service whose credential is
# a reference. `--check` is the assertion to put in CI.
#
# VAULT_ADDR / VAULT_TOKEN_FILE (or VAULT_TOKEN) are read from the environment
# first and from `.env` second. With no VAULT_ADDR set, a stack whose `.env`
# still holds references is refused rather than started with literal
# `vault://` strings as credentials.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CAPSTONE_ENV_FILE:-$REPO_ROOT/.env}"
RESOLVED_ENV="${CAPSTONE_RESOLVED_ENV:-$REPO_ROOT/data/.env.resolved}"
RESOLVER="$REPO_ROOT/scripts/vault-env.py"

CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
  shift
fi

die() { printf 'compose-vault: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE (copy .env.example and fill it in)"
[ -f "$RESOLVER" ] || die "no resolver at $RESOLVER"

# One key from the env file, without sourcing it (a `.env` is not shell).
env_file_value() {
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true
}

# Environment wins over `.env`, matching compose's own precedence.
: "${VAULT_ADDR:=$(env_file_value VAULT_ADDR)}"
: "${VAULT_TOKEN:=$(env_file_value VAULT_TOKEN)}"
: "${VAULT_TOKEN_FILE:=$(env_file_value VAULT_TOKEN_FILE)}"
export VAULT_ADDR VAULT_TOKEN VAULT_TOKEN_FILE

# A token file named relative to the repo must resolve from the repo, not from
# wherever compose happened to be invoked.
case "${VAULT_TOKEN_FILE:-}" in
  /*|"") ;;
  *) VAULT_TOKEN_FILE="$REPO_ROOT/$VAULT_TOKEN_FILE"; export VAULT_TOKEN_FILE ;;
esac

REFS="$(grep -c 'vault://' "$ENV_FILE" 2>/dev/null || true)"

if [ "${REFS:-0}" -gt 0 ] && [ -z "${VAULT_ADDR:-}" ]; then
  die "$ENV_FILE has $REFS vault:// reference(s) but VAULT_ADDR is unset — \
set VAULT_ADDR (and VAULT_TOKEN_FILE) in .env, or the services will receive the \
reference string as a credential"
fi

if [ "${REFS:-0}" -eq 0 ]; then
  # Nothing to resolve; don't write a second copy of the env that could drift.
  if [ "$CHECK" = "1" ]; then
    echo "compose-vault: $ENV_FILE has no vault:// references — nothing to resolve"
    exit 0
  fi
  exec docker compose --env-file "$ENV_FILE" "$@"
fi

# Resolve into a sibling file first, then move into place: a crash midway must
# not leave a half-written env that the next compose run would happily read.
TMP="$(mktemp "$RESOLVED_ENV.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

python3 "$RESOLVER" --out "$TMP" "$ENV_FILE" >&2

if grep -q 'vault://' "$TMP"; then
  die "resolution left vault:// references in $TMP — refusing to start"
fi

chmod 600 "$TMP"
mv -f "$TMP" "$RESOLVED_ENV"
trap - EXIT

if [ "$CHECK" = "1" ]; then
  echo "compose-vault: resolved $REFS reference(s) into $RESOLVED_ENV (not running compose)"
  exit 0
fi

exec docker compose --env-file "$RESOLVED_ENV" "$@"
