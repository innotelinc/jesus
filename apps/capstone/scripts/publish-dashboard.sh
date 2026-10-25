#!/usr/bin/env bash
# publish-dashboard.sh — push the Control Center images to GHCR under the repo's
# own namespace, so another host pulls them instead of building them.
#
# Why: the images were built and kept only on this host. That is fine until the
# host is replaced or a second box joins — then the release is whatever that box
# happens to build. Publishing tags each image with the commit it was built from
# (`capstone-dashboard:<sha>`), which is the same version tag
# scripts/redeploy-dashboard.sh puts on the local images, plus `:latest`.
#
# Credentials: GHCR_USERNAME / GHCR_TOKEN from the environment, otherwise read
# from Vault (cerulean/capstone/docker) with this stack's VAULT_ADDR +
# VAULT_TOKEN / VAULT_TOKEN_FILE — the path the estate keeps registry logins in.
# No credentials is not a hard failure: the deploy is already live by then, so
# the script reports the skip and exits 0 unless --require is given.
#
# Usage:
#   scripts/publish-dashboard.sh                 # publish both images at HEAD
#   scripts/publish-dashboard.sh --dry-run       # print the tags, push nothing
#   scripts/publish-dashboard.sh --require       # exit 1 when it cannot publish
#   scripts/publish-dashboard.sh --tag v3.32     # extra tag beside :latest
#   scripts/publish-dashboard.sh dashboard       # only the named image(s)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${CAPSTONE_IMAGE_PREFIX:-ghcr.io/innotelinc/capstone}"
REGISTRY="${PREFIX%%/*}"
VAULT_MOUNT="${CAPSTONE_VAULT_MOUNT:-cerulean}"
VAULT_PATH="${CAPSTONE_VAULT_DOCKER_PATH:-capstone/docker}"

DRY_RUN=0; REQUIRE=0; EXTRA_TAG=""; IMAGES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --require) REQUIRE=1 ;;
    --tag)     EXTRA_TAG="${2:-}"; [ -n "$EXTRA_TAG" ] || { printf 'publish-dashboard: --tag needs a value\n' >&2; exit 2; }; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*)        printf 'publish-dashboard: unknown option: %s\n' "$1" >&2; exit 2 ;;
    *)         IMAGES+=("$1") ;;
  esac
  shift
done

log()  { printf 'publish-dashboard: %s\n' "$*"; }
skip() {
  if [ "$REQUIRE" = "1" ]; then printf 'publish-dashboard: %s\n' "$*" >&2; exit 1; fi
  log "$* — not publishing"
  exit 0
}

[ ${#IMAGES[@]} -gt 0 ] || IMAGES=(dashboard-api dashboard)

version="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
[ -n "$version" ] || skip "no git checkout to name the version from"

# image <service> -> the local image and its published name.
image_of() {
  case "$1" in
    dashboard-api) printf '%s %s\n' \
        "${DASHBOARD_API_IMAGE:-capstone-dashboard-api:local}" "$PREFIX/capstone-dashboard-api" ;;
    dashboard)     printf '%s %s\n' \
        "${DASHBOARD_IMAGE:-capstone-dashboard:local}" "$PREFIX/capstone-dashboard" ;;
    *) return 1 ;;
  esac
}

# ── credentials ─────────────────────────────────────────────────────────────
env_file_value() { sed -n "s/^$1=//p" "$ROOT/.env" 2>/dev/null | head -1; }

vault_creds() {
  local addr token_file token payload
  addr="${VAULT_ADDR:-$(env_file_value VAULT_ADDR)}"
  [ -n "$addr" ] || return 1
  token="${VAULT_TOKEN:-$(env_file_value VAULT_TOKEN)}"
  if [ -z "$token" ]; then
    token_file="${VAULT_TOKEN_FILE:-$(env_file_value VAULT_TOKEN_FILE)}"
    [ -n "$token_file" ] || return 1
    case "$token_file" in /*) ;; *) token_file="$ROOT/$token_file" ;; esac
    [ -f "$token_file" ] || return 1
    token="$(cat "$token_file")"
  fi
  [ -n "$token" ] || return 1
  payload="$(curl -s -m 10 -H "X-Vault-Token: $token" \
      "${addr%/}/v1/$VAULT_MOUNT/data/$VAULT_PATH" 2>/dev/null)" || return 1
  printf '%s' "$payload" | python3 -c '
import json, sys
try:
    data = (json.load(sys.stdin).get("data") or {}).get("data") or {}
except Exception:
    raise SystemExit(1)
print(data.get("GHCR_USERNAME", ""))
print(data.get("GHCR_TOKEN", ""))
'
}

ghcr_user="${GHCR_USERNAME:-}"; ghcr_token="${GHCR_TOKEN:-}"
if [ -z "$ghcr_user" ] || [ -z "$ghcr_token" ]; then
  vault_out="$(vault_creds)" || vault_out=""
  if [ -n "$vault_out" ]; then
    ghcr_user="${ghcr_user:-$(printf '%s\n' "$vault_out" | sed -n 1p)}"
    ghcr_token="${ghcr_token:-$(printf '%s\n' "$vault_out" | sed -n 2p)}"
    if [ -n "$ghcr_user" ] && [ -n "$ghcr_token" ]; then
      log "credentials: vault://$VAULT_MOUNT/$VAULT_PATH (GHCR_USERNAME)"
    else
      log "credentials: vault path $VAULT_MOUNT/$VAULT_PATH has no GHCR keys"
    fi
  fi
fi
[ -n "$ghcr_user" ] && [ -n "$ghcr_token" ] \
  || skip "no GHCR credentials (GHCR_USERNAME/GHCR_TOKEN, or the vault path)"

# ── plan ────────────────────────────────────────────────────────────────────
plan=()
for svc in "${IMAGES[@]}"; do
  case "$svc" in
    dashboard-api|dashboard) ;;
    *) printf 'publish-dashboard: unknown image: %s\n' "$svc" >&2; exit 2 ;;
  esac
  read -r local_image remote_image <<<"$(image_of "$svc")"
  if ! docker image inspect "$local_image" >/dev/null 2>&1; then
    printf 'publish-dashboard: %s is not on this host — build it first\n' "$local_image" >&2
    exit 1
  fi
  plan+=("$local_image $remote_image:$version")
  [ -n "$EXTRA_TAG" ] && plan+=("$local_image $remote_image:$EXTRA_TAG")
  plan+=("$local_image $remote_image:latest")
done

if [ "$DRY_RUN" = "1" ]; then
  log "would log in to $REGISTRY as $ghcr_user"
  for entry in "${plan[@]}"; do
    log "would push ${entry%% *} -> ${entry##* }"
  done
  exit 0
fi

if ! printf '%s' "$ghcr_token" | docker login "$REGISTRY" -u "$ghcr_user" --password-stdin >/dev/null 2>&1; then
  skip "docker login to $REGISTRY failed for $ghcr_user"
fi

failed=0
for entry in "${plan[@]}"; do
  src="${entry%% *}"; dst="${entry##* }"
  if ! docker tag "$src" "$dst"; then
    printf 'publish-dashboard: could not tag %s as %s\n' "$src" "$dst" >&2
    failed=1; continue
  fi
  if docker push "$dst" >/dev/null 2>&1; then
    log "pushed $dst"
  else
    printf 'publish-dashboard: push failed: %s\n' "$dst" >&2
    failed=1
  fi
done

if [ "$failed" = "1" ]; then
  [ "$REQUIRE" = "1" ] && exit 1
  log "some tags did not publish — the deploy itself is unaffected"
  exit 0
fi
log "published $(printf '%s\n' "${IMAGES[@]}" | tr '\n' ' ')at $version"
