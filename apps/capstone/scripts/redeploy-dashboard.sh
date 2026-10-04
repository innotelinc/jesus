#!/usr/bin/env bash
# redeploy-dashboard.sh — rebuild + restart the Control Center's two images
# (dashboard-api, dashboard) when their source changed.
#
# Why this exists: both images are built from source, so editing
# dashboard-backend/app or dashboard/src does nothing to the running stack until
# the images are rebuilt and the containers recreated. That gap is how a fix
# "ships" while the deployed API keeps answering with the old code — e.g. the
# PBX self-healing change, where the old image still reported Docker's raw
# `409 … is not running`. This script IS that deploy step; run it from CI, a git
# hook, or the systemd timer that install-capstone.sh enables
# (capstone-dashboard-redeploy.timer).
#
# It is cheap when nothing changed: a content hash of the dashboard sources is
# compared with the stamp written by the last successful deploy, and Docker is
# not touched when they match.
#
# Usage:
#   scripts/redeploy-dashboard.sh            # deploy only when source changed
#   scripts/redeploy-dashboard.sh --force    # always rebuild + restart
#   scripts/redeploy-dashboard.sh --check    # report drift, exit 1, deploy nothing
#   scripts/redeploy-dashboard.sh --dry-run  # print the commands, run nothing
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/env-lib.sh disable=SC1091
. "$ROOT/scripts/env-lib.sh" 2>/dev/null || true
STAMP="${CAPSTONE_DASHBOARD_STAMP:-$ROOT/data/.dashboard-redeploy.stamp}"
# Optional committed baseline. When set, --check compares against it instead of
# the deploy stamp — the way CI can assert "the dashboard sources match the last
# reviewed baseline" without a deployment on the runner. A missing stamp AND
# missing baseline is not drift: --check reports it and passes.
BASELINE="${CAPSTONE_DASHBOARD_BASELINE:-}"

FORCE=0; CHECK=0; DRY_RUN=0; WRITE_BASELINE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force)          FORCE=1 ;;
    --check)          CHECK=1 ;;
    --dry-run)        DRY_RUN=1 ;;
    --baseline)       BASELINE="${2:-}"; shift; [ -n "$BASELINE" ] || { printf 'redeploy-dashboard: --baseline needs a path\n' >&2; exit 2; } ;;
    --write-baseline) WRITE_BASELINE=1 ;;
    -h|--help)        sed -n '2,25p' "$0"; exit 0 ;;
    *) printf 'redeploy-dashboard: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf 'redeploy-dashboard: %s\n' "$*"; }

# Every file whose contents define either image.
source_file_list() {
  find "$ROOT/dashboard-backend/app" -type f -name '*.py' 2>/dev/null
  find "$ROOT/dashboard/src" -type f 2>/dev/null
  find "$ROOT/dashboard/public" -type f 2>/dev/null
  local f
  for f in \
    "$ROOT/dashboard-backend/requirements.txt" \
    "$ROOT/dashboard-backend/Dockerfile" \
    "$ROOT/dashboard/package.json" \
    "$ROOT/dashboard/package-lock.json" \
    "$ROOT/dashboard/Dockerfile" \
    "$ROOT/dashboard/nginx.conf" \
    "$ROOT/dashboard/index.html" \
    "$ROOT/dashboard/vite.config.ts" \
    "$ROOT/dashboard/vite.config.js" \
    "$ROOT/dashboard/tsconfig.json" \
    "$ROOT/dashboard/tailwind.config.js" \
    "$ROOT/dashboard/postcss.config.js"; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
}

# sha256sum of (file name + contents) for every source, so a rename or a
# delete changes the hash too.
hash_sources() {
  while IFS= read -r f; do
    sha256sum "$f"
  done < <(source_file_list | LC_ALL=C sort) | sha256sum | awk '{print $1}'
}

current_hash="$(hash_sources)"

if [ "$WRITE_BASELINE" = "1" ]; then
  [ -n "$BASELINE" ] || { log "--write-baseline needs --baseline FILE"; exit 2; }
  mkdir -p "$(dirname "$BASELINE")"
  printf '%s\n' "$current_hash" > "$BASELINE"
  log "baseline updated (${current_hash:0:12})"
  exit 0
fi

# Prefer an explicit baseline (CI); otherwise the host's deploy stamp. Neither
# present is not drift — see the header.
compare_file=""
[ -n "$BASELINE" ] && [ -s "$BASELINE" ] && compare_file="$BASELINE"
[ -z "$compare_file" ] && [ -s "$STAMP" ] && compare_file="$STAMP"
prev_hash=""
[ -n "$compare_file" ] && prev_hash="$(tr -d '[:space:]' < "$compare_file")"

if [ -z "$compare_file" ]; then
  if [ "$CHECK" = "1" ]; then
    log "no deploy stamp/baseline on this runner — nothing to compare (${current_hash:0:12})"
    exit 0
  fi
fi

if [ "$FORCE" = "0" ] && [ -n "$prev_hash" ] && [ "$current_hash" = "$prev_hash" ]; then
  log "dashboard sources unchanged (${current_hash:0:12}) — nothing to deploy"
  exit 0
fi

if [ "$CHECK" = "1" ]; then
  log "dashboard sources changed: ${prev_hash:0:12} → ${current_hash:0:12} — deploy needed"
  exit 1
fi

# Resolve vault:// references when the stack uses them; compose-vault.sh refuses
# a stack whose .env still holds references but has no VAULT_ADDR, which is the
# behaviour we want here too.
COMPOSE=(docker compose)
if grep -q 'vault://' "$ROOT/.env" 2>/dev/null && [ -x "$ROOT/scripts/compose-vault.sh" ]; then
  COMPOSE=("$ROOT/scripts/compose-vault.sh")
fi

cd "$ROOT"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    log "would run: $*"
  else
    "$@"
  fi
}

log "deploying dashboard-api + dashboard (${prev_hash:0:12} → ${current_hash:0:12})"
run "${COMPOSE[@]}" -f docker-compose.yml build dashboard-api dashboard
# --force-recreate, not a bare `up -d`: these images are tagged the same
# (`:local`) every build, and compose decides a running container is up to date
# from its config — which carries the tag, not the rebuilt image id. A plain
# `up -d` therefore reported the containers "Running" and left the OLD image in
# place, so a deploy that built the new code never actually ran it. The script
# only reaches this line when the source hash changed (or --force), so
# recreating unconditionally is exactly the intent.
run "${COMPOSE[@]}" -f docker-compose.yml up -d --no-deps --force-recreate dashboard-api dashboard

if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$(dirname "$STAMP")"
  printf '%s\n' "$current_hash" > "$STAMP"
  log "deployed ${current_hash:0:12}"
fi
