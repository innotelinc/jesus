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
# not touched when they match. The two images are hashed separately, so a
# backend-only change rebuilds only the API and a UI-only change only the UI.
#
# Bases are local: the build args come from scripts/local-bases.sh, which pins
# `capstone-base/{python,node,nginx}:local` to images already on this host, so a
# docker.io rate limit cannot block a deploy. Every build is also tagged with
# this checkout's version (`capstone-dashboard-api:<short-sha>`), so the images
# that ran are still addressable after the moving `:local` tag moves on.
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
    -h|--help)        sed -n '2,30p' "$0"; exit 0 ;;
    *) printf 'redeploy-dashboard: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf 'redeploy-dashboard: %s\n' "$*"; }

# The build args, as stable names — printed, never created here, so --check
# needs no docker and the hash does not move when a tag is re-pointed.
base_args() {
  "$ROOT/scripts/local-bases.sh" --print 2>/dev/null || true
}

# Files whose contents define each image.
api_file_list() {
  find "$ROOT/dashboard-backend/app" -type f -name '*.py' 2>/dev/null
  local f
  for f in "$ROOT/dashboard-backend/requirements.txt" \
           "$ROOT/dashboard-backend/Dockerfile" \
           "$ROOT/scripts/local-bases.sh"; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
}

ui_file_list() {
  find "$ROOT/dashboard/src" -type f 2>/dev/null
  find "$ROOT/dashboard/public" -type f 2>/dev/null
  local f
  find "$ROOT/dashboard/nginx-base" -type f 2>/dev/null
  for f in "$ROOT/dashboard/package.json" \
           "$ROOT/dashboard/package-lock.json" \
           "$ROOT/dashboard/Dockerfile" \
           "$ROOT/dashboard/nginx-base.Dockerfile" \
           "$ROOT/dashboard/nginx.conf" \
           "$ROOT/dashboard/index.html" \
           "$ROOT/dashboard/vite.config.ts" \
           "$ROOT/dashboard/vite.config.js" \
           "$ROOT/dashboard/tsconfig.json" \
           "$ROOT/dashboard/tailwind.config.js" \
           "$ROOT/dashboard/postcss.config.js" \
           "$ROOT/scripts/local-bases.sh"; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
}

# sha256 of (name + contents) for every file in a list, plus the build args, so
# a rename, a delete or a different base all move the hash.
hash_of() {
  local fn="$1"
  {
    "$fn" | LC_ALL=C sort | while IFS= read -r f; do
      [ -f "$f" ] && sha256sum "$f"
    done
    base_args
  } | sha256sum | awk '{print $1}'
}

api_hash="$(hash_of api_file_list)"
ui_hash="$(hash_of ui_file_list)"
current_hash="$(printf 'api=%s\nui=%s\n' "$api_hash" "$ui_hash" | sha256sum | awk '{print $1}')"

side_file="$STAMP.images"
prev_api=""; prev_ui=""
if [ -s "$side_file" ]; then
  prev_api="$(sed -n 's/^api=//p' "$side_file" | head -1)"
  prev_ui="$(sed -n 's/^ui=//p' "$side_file" | head -1)"
fi

if [ "$WRITE_BASELINE" = "1" ]; then
  [ -n "$BASELINE" ] || { log "--write-baseline needs --baseline FILE"; exit 2; }
  mkdir -p "$(dirname "$BASELINE")"
  printf '%s\n' "$current_hash" > "$BASELINE"
  printf 'api=%s\nui=%s\n' "$api_hash" "$ui_hash" > "$BASELINE.images"
  log "baseline updated (${current_hash:0:12})"
  exit 0
fi

compare_file=""
[ -n "$BASELINE" ] && [ -s "$BASELINE" ] && compare_file="$BASELINE"
[ -z "$compare_file" ] && [ -s "$STAMP" ] && compare_file="$STAMP"
prev_hash=""
[ -n "$compare_file" ] && prev_hash="$(tr -d '[:space:]' < "$compare_file")"

if [ -z "$compare_file" ] && [ "$CHECK" = "1" ]; then
  log "no deploy stamp/baseline on this runner — nothing to compare (${current_hash:0:12})"
  exit 0
fi

# Per image: changed when its own hash moved, or when there is no record of it.
changed_api=0; changed_ui=0
if [ -n "$prev_api" ] && [ "$api_hash" = "$prev_api" ]; then :; else changed_api=1; fi
if [ -n "$prev_ui" ] && [ "$ui_hash" = "$prev_ui" ]; then :; else changed_ui=1; fi

if [ "$FORCE" = "1" ]; then
  changed_api=1; changed_ui=1
fi

if [ "$changed_api" = "0" ] && [ "$changed_ui" = "0" ]; then
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

# Ensure the base tags exist (a no-op when they do) and turn the printed
# KEY=VALUE lines into --build-arg pairs.
base_pairs=()
while IFS= read -r line; do
  [ -n "$line" ] && base_pairs+=("$line")
done < <( "$ROOT/scripts/local-bases.sh" )
build_args=()
for pair in ${base_pairs[@]+"${base_pairs[@]}"}; do
  [ -n "$pair" ] && build_args+=(--build-arg "$pair")
done
log "bases: ${base_pairs[*]:-<defaults>}"

targets=()
[ "$changed_api" = "1" ] && targets+=(dashboard-api)
[ "$changed_ui" = "1" ] && targets+=(dashboard)
log "deploying ${targets[*]} (${prev_hash:0:12} → ${current_hash:0:12})"

run "${COMPOSE[@]}" -f docker-compose.yml build ${build_args[@]+"${build_args[@]}"} "${targets[@]}"
# --force-recreate, not a bare `up -d`: these images are tagged the same
# (`:local`) every build, and compose decides a running container is up to date
# from its config — which carries the tag, not the rebuilt image id. A plain
# `up -d` therefore reported the containers "Running" and left the OLD image in
# place, so a deploy that built the new code never actually ran it. The script
# only reaches this line when a hash changed (or --force), so recreating
# unconditionally is exactly the intent.
run "${COMPOSE[@]}" -f docker-compose.yml up -d --no-deps --force-recreate "${targets[@]}"

if [ "$DRY_RUN" != "1" ]; then
  version="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  version="${version:-$(date +%Y%m%d%H%M)}"
  for svc in "${targets[@]}"; do
    case "$svc" in
      dashboard-api) image="${DASHBOARD_API_IMAGE:-capstone-dashboard-api:local}" ;;
      dashboard)     image="${DASHBOARD_IMAGE:-capstone-dashboard:local}" ;;
      *) continue ;;
    esac
    run docker tag "$image" "${image%:*}:$version"
  done
  mkdir -p "$(dirname "$STAMP")"
  printf '%s\n' "$current_hash" > "$STAMP"
  printf 'api=%s\nui=%s\nversion=%s\n' "$api_hash" "$ui_hash" "$version" > "$side_file"
  log "deployed ${current_hash:0:12} as version $version (${targets[*]})"
fi
