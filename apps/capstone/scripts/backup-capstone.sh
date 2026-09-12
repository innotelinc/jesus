#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# backup-capstone.sh — DB + config backup for the Capstone stack.
#
# Captures everything needed to stand the data layer back up on a NEW server
# (the intended use: moving Capstone off this host). Deliberately NOT included:
# telemetry (SigNoz ClickHouse), model caches, and image layers — those are
# rebuilt, not restored.
#
# What lands in the backup:
#
#   config/   compose files, .env, n8n workflow JSON, the dograh workflow
#             definitions and scripts/ (the wiring + bootstrap helpers)
#   db/       pg_dumpall of the stack Postgres (pgvector), a dump of the
#             SigNoz metastore (dashboards/alerts), tar of the Grist and n8n
#             volumes (Grist docs + n8n database.sqlite), and the n8n workflow
#             JSON export
#   repo.bundle  `git bundle` of this checkout — every tracked file at HEAD
#   MANIFEST.txt / SHA256SUMS
#
# Output: $HOME/capstone-backup/ (working tree) and
#         $HOME/capstone-backup-<UTC timestamp>.tar.gz (the copy to move).
#
# Usage:
#   bash scripts/backup-capstone.sh                  # backup + tarball
#   CAPSTONE_BACKUP_DIR=/mnt/usb/capstone bash scripts/backup-capstone.sh
#   SKIP_TARBALL=1 bash scripts/backup-capstone.sh   # leave the directory only
# ═══════════════════════════════════════════════════════════════════════════

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="${CAPSTONE_BACKUP_DIR:-$HOME/capstone-backup}"
TARBALL="$HOME/capstone-backup-$STAMP.tar.gz"

PG_CONTAINER="${PG_CONTAINER:-capstone-voice-aiagent-platform-postgres-1}"
PG_USER="${PG_USER:-postgres}"
SIGNOZ_PG_CONTAINER="${SIGNOZ_PG_CONTAINER:-signoz-metastore-postgres}"
SIGNOZ_PG_USER="${SIGNOZ_PG_USER:-signoz}"
SIGNOZ_PG_DB="${SIGNOZ_PG_DB:-signoz}"

VOLUME_PREFIX="${VOLUME_PREFIX:-capstone-voice-aiagent-platform_}"
DOCKER_VOLUME_ROOT="${DOCKER_VOLUME_ROOT:-/var/lib/docker/volumes}"

log() { printf '  %s\n' "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }
# Human-readable file size that works on busybox/overlayfs (du -h reports block
# counts there, so use the apparent size).
size() { du -h --apparent-size "$1" 2>/dev/null | cut -f1 || stat -c%s "$1"; }

command -v docker >/dev/null 2>&1 || { echo "FAIL docker not found" >&2; exit 1; }

step "Preparing $BACKUP_DIR"
mkdir -p "$BACKUP_DIR/config" "$BACKUP_DIR/db"
chmod 700 "$BACKUP_DIR"
rm -f "$BACKUP_DIR"/config/* "$BACKUP_DIR"/db/* 2>/dev/null || true

# ── 1. Config files ───────────────────────────────────────────────────────
step "Config"
for f in docker-compose.yml docker-compose.dograh-build.yml docker-compose.dograh.yml \
         .env n8n-grader-workflow.json package.json; do
  if [ -f "$f" ]; then
    cp -p "$f" "$BACKUP_DIR/config/"
    log "config/$f"
  fi
done
if [ -d dograh ]; then
  mkdir -p "$BACKUP_DIR/config/dograh"
  find dograh -maxdepth 1 -name '*.json' -exec cp -p {} "$BACKUP_DIR/config/dograh/" \;
  log "config/dograh/*.json ($(find "$BACKUP_DIR/config/dograh" -name '*.json' | wc -l | tr -d ' ') files)"
fi
if [ -d scripts ]; then
  cp -a scripts "$BACKUP_DIR/config/scripts"
  # scratch output that should never travel with a backup
  find "$BACKUP_DIR/config/scripts" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  log "config/scripts/"
fi
if [ -d ansible ]; then
  cp -a ansible "$BACKUP_DIR/config/ansible"
  log "config/ansible/"
fi
if [ -d pbx ]; then
  cp -a pbx "$BACKUP_DIR/config/pbx"
  log "config/pbx/"
fi

# ── 2. Databases ──────────────────────────────────────────────────────────
step "Postgres (stack)"
if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  docker exec "$PG_CONTAINER" pg_dumpall -U "$PG_USER" | gzip -9 > "$BACKUP_DIR/db/postgres-all.sql.gz"
  log "db/postgres-all.sql.gz ($(size "$BACKUP_DIR/db/postgres-all.sql.gz"))"
else
  log "SKIP $PG_CONTAINER not running — no Postgres dump"
fi

step "Postgres (SigNoz metastore)"
if docker ps --format '{{.Names}}' | grep -qx "$SIGNOZ_PG_CONTAINER"; then
  docker exec "$SIGNOZ_PG_CONTAINER" pg_dump -U "$SIGNOZ_PG_USER" "$SIGNOZ_PG_DB" \
    | gzip -9 > "$BACKUP_DIR/db/signoz-metastore.sql.gz"
  log "db/signoz-metastore.sql.gz ($(size "$BACKUP_DIR/db/signoz-metastore.sql.gz"))"
else
  log "SKIP $SIGNOZ_PG_CONTAINER not running"
fi

# ── 3. Docker volumes (Grist docs, n8n database) ──────────────────────────
step "Docker volumes"
for vol in grist_data n8n_data redis_data omniroute_data minio-data; do
  src="$DOCKER_VOLUME_ROOT/${VOLUME_PREFIX}${vol}/_data"
  if [ -d "$src" ]; then
    tar -czf "$BACKUP_DIR/db/${vol}.tar.gz" -C "$src" . 2>/dev/null
    log "db/${vol}.tar.gz ($(size "$BACKUP_DIR/db/${vol}.tar.gz"))"
  else
    log "SKIP volume ${VOLUME_PREFIX}${vol} (not found)"
  fi
done

# ── 4. n8n workflow export (readable, in addition to the volume) ──────────
step "n8n workflows"
if docker ps --format '{{.Names}}' | grep -qx n8n; then
  if docker exec n8n n8n export:workflow --all --output=/tmp/n8n-workflows.json >/dev/null 2>&1; then
    if docker cp n8n:/tmp/n8n-workflows.json "$BACKUP_DIR/config/n8n-workflows.json" >/dev/null 2>&1; then
      log "config/n8n-workflows.json"
    else
      log "WARN workflow export copy failed"
    fi
    docker exec n8n rm -f /tmp/n8n-workflows.json >/dev/null 2>&1 || true
  else
    log "WARN n8n export:workflow failed (volume tar still has database.sqlite)"
  fi
else
  log "SKIP n8n not running"
fi

# ── 5. Git bundle — every tracked file at HEAD ────────────────────────────
step "Repo bundle"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git bundle create "$BACKUP_DIR/repo.bundle" --all >/dev/null 2>&1; then
    log "repo.bundle ($(size "$BACKUP_DIR/repo.bundle"))"
  else
    log "WARN git bundle failed (uncommitted work is NOT included)"
  fi
else
  log "SKIP not a git checkout"
fi

# ── 6. Manifest + checksums ───────────────────────────────────────────────
step "Manifest"
GIT_HEAD="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
{
  echo "Capstone DB + config backup"
  echo "created_utc: $STAMP"
  echo "host: $(hostname)"
  echo "repo: $ROOT"
  echo "git_head: $GIT_HEAD"
  echo "git_branch: $GIT_BRANCH"
  echo "compose_project: $(docker compose ls --format '{{.Name}}' 2>/dev/null | head -1 || echo unknown)"
  echo
  echo "Restore order:"
  echo "  1. clone/unbundle repo.bundle, copy config/.env into place"
  echo "  2. docker compose up -d postgres redis"
  echo "  3. gunzip -c db/postgres-all.sql.gz | docker exec -i $PG_CONTAINER psql -U $PG_USER -d postgres"
  echo "  4. restore db/grist_data.tar.gz + db/n8n_data.tar.gz into their volumes"
  echo "  5. docker compose up -d   (dograh-api, dashboard-api, n8n, grist, ...)"
  echo "  6. re-run scripts/grist_bootstrap.py and scripts/dograh_wire.py"
  echo
  echo "NOT included: SigNoz ClickHouse telemetry, model caches, image layers."
} > "$BACKUP_DIR/MANIFEST.txt"
log "MANIFEST.txt"

# shellcheck disable=SC2094  # SHA256SUMS is excluded by name, so this only adds
( cd "$BACKUP_DIR" && find . -type f ! -name SHA256SUMS -print0 \
  | sort -z | xargs -0 sha256sum > SHA256SUMS )
log "SHA256SUMS ($(wc -l < "$BACKUP_DIR/SHA256SUMS" | tr -d ' ') files)"

# ── 7. Single tarball to move to the new server ───────────────────────────
if [ -z "${SKIP_TARBALL:-}" ]; then
  step "Tarball"
  tar -czf "$TARBALL" -C "$(dirname "$BACKUP_DIR")" "$(basename "$BACKUP_DIR")"
  chmod 600 "$TARBALL"
  log "$TARBALL ($(size "$TARBALL"))"
fi

step "Done"
log "directory: $BACKUP_DIR"
if [ -z "${SKIP_TARBALL:-}" ]; then log "tarball:   $TARBALL"; fi
