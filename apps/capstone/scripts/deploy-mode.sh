#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# deploy-mode.sh — convert this host between standalone and the Zeus add-on.
#
# The mode is not only a dashboard setting: it decides whether Capstone owns a
# PBX (the bundled `freepbx` container, compose profile `standalone`) or rides
# the Zeus one (`zeus-freepbx`). The dashboard and the compose profile have to
# agree, and only the host can start a container compose has never created —
# which is why this runs here, and why the Control Center's switch answers with
# this script's name when the target container does not exist.
#
#   ./scripts/deploy-mode.sh              # report the mode and what is running
#   ./scripts/deploy-mode.sh standalone   # own the PBX (create/start it)
#   ./scripts/deploy-mode.sh addon        # ride the shared Zeus PBX
#   ./scripts/deploy-mode.sh addon --dry-run
#
# What it changes on disk: `CAPSTONE_DEPLOY_MODE` and `CAPSTONE_PBX` in `.env`.
# What it changes on the box: starts (standalone) or stops (addon) the bundled
# `pbx-freepbx`, recreates `dashboard-api` so it reads the new mode, and checks
# that the PBX the mode points at serves `[dograh-inbound]` into Stasis.
# Switching BACK to a stopped bundled PBX keeps its container, so the Control
# Center's own switch can start it again without compose.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO/docker-compose.yml}"
BUNDLED_PBX="${BUNDLED_PBX:-pbx-freepbx}"
SHARED_PBX="${SHARED_PBX:-zeus-freepbx}"
DRY_RUN=0
FORCE=0
# The ports the bundled FreePBX publishes. The shared Zeus PBX publishes the
# same set, so on a host running both stacks only one can hold them.
CONFLICT_PORTS="5060/udp, 5061, 8083, 8088, 8089, 10000, 10101-10120/udp"

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

usage() {
    cat <<'USAGE'
usage: scripts/deploy-mode.sh [standalone|addon] [--dry-run]

  (no mode)    report the configured mode and what the two PBX containers are doing
  standalone   own the PBX: create/start the bundled FreePBX and point the dashboard at it
  addon        ride the shared Zeus PBX: stop the bundled FreePBX and point the dashboard at Zeus
  --dry-run    print the commands instead of running them
  --force      convert even when the shared PBX still holds the ports the bundled one needs

env: ENV_FILE (default ./.env), COMPOSE_FILE, BUNDLED_PBX, SHARED_PBX
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --dry-run) DRY_RUN=1 ;;
        --force) FORCE=1 ;;
        standalone|addon) MODE="$1" ;;
        *) fail "unknown argument: $1"; usage; exit 2 ;;
    esac
    shift
done
MODE="${MODE:-}"

if [ ! -f "$ENV_FILE" ]; then
    fail "$ENV_FILE not found — run from the repo root, or set ENV_FILE"
    exit 2
fi

compose() {
    if [ "$DRY_RUN" = 1 ]; then
        info "would run: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE $*"
        return 0
    fi
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

running() {  # running <container> → 0 when it reports running
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

env_value() {  # env_value <KEY> → the value in .env, or empty
    grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-
}

set_env() {  # set_env <KEY> <VALUE> — idempotent, keeps every other line
    if [ "$DRY_RUN" = 1 ]; then
        info "would set $1=$2 in $ENV_FILE"
        return 0
    fi
    python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import pathlib, re, sys
path, key, value = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text().splitlines()
out, seen = [], False
for line in lines:
    if re.match(rf"^{re.escape(key)}=", line):
        out.append(f"{key}={value}")
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
}

report() {
    local configured
    configured="$(env_value CAPSTONE_DEPLOY_MODE)"; configured="${configured:-standalone (default)}"
    echo "── deploy mode ──"
    info "configured: CAPSTONE_DEPLOY_MODE=$configured"
    for c in "$SHARED_PBX" "$BUNDLED_PBX"; do
        if docker inspect "$c" >/dev/null 2>&1; then
            local state
            state="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)"
            info "$c: $state"
        else
            info "$c: absent"
        fi
    done
}

verify_dialplan() {
    local container="$1" dp
    if [ "$DRY_RUN" = 1 ]; then
        info "would check: docker exec $container asterisk -rx 'dialplan show dograh-inbound'"
        return 0
    fi
    dp="$(docker exec "$container" asterisk -rx 'dialplan show dograh-inbound' 2>&1 || true)"
    if printf '%s' "$dp" | grep -q 'Stasis('; then
        pass "$container serves [dograh-inbound] into Stasis"
    else
        warn "$container does not serve [dograh-inbound] into Stasis yet"
        info "run: docker exec $container asterisk -rx 'dialplan reload' (the dashboard re-syncs on the next Agents load)"
    fi
}

report
[ -n "$MODE" ] || { echo; info "pass 'standalone' or 'addon' to convert"; exit 0; }

# A conversion that fails half-way must not leave .env claiming a mode the box
# is not in, so the two keys are restored to what they were.
ORIG_MODE="$(env_value CAPSTONE_DEPLOY_MODE)"
ORIG_PBX="$(env_value CAPSTONE_PBX)"

unset_env() {  # unset_env <KEY> — drop the line entirely (it was not there before)
    [ "$DRY_RUN" = 1 ] && return 0
    python3 - "$ENV_FILE" "$1" <<'PY'
import pathlib, re, sys
path, key = pathlib.Path(sys.argv[1]), sys.argv[2]
lines = [l for l in path.read_text().splitlines()
         if not re.match(rf"^{re.escape(key)}=", l)]
path.write_text("\n".join(lines) + "\n")
PY
}

revert_env() {
    [ "$DRY_RUN" = 1 ] && return 0
    if [ -n "$ORIG_MODE" ]; then set_env CAPSTONE_DEPLOY_MODE "$ORIG_MODE"; else unset_env CAPSTONE_DEPLOY_MODE; fi
    if [ -n "$ORIG_PBX" ]; then set_env CAPSTONE_PBX "$ORIG_PBX"; else unset_env CAPSTONE_PBX; fi
    warn "restored CAPSTONE_DEPLOY_MODE=${ORIG_MODE:-<unset>} — the box is still in the mode it was"
}

# Both PBXs publish the same host ports, so converting to standalone while the
# shared stack runs cannot work: docker will refuse to bind 5060 and the new
# container exits. Say so before touching .env, and let --force try anyway.
if [ "$MODE" = "standalone" ] && [ "$FORCE" != 1 ] && running "$SHARED_PBX"; then
    echo
    fail "$SHARED_PBX is running and holds the ports the bundled FreePBX publishes"
    info "ports in conflict: $CONFLICT_PORTS"
    info "stop the Zeus stack first, or re-run with --force to try anyway"
    exit 1
fi

echo
echo "── converting to $MODE ──"
set_env CAPSTONE_DEPLOY_MODE "$MODE"

if [ "$MODE" = "standalone" ]; then
    set_env CAPSTONE_PBX standalone
    # The bundled PBX lives behind the `standalone` compose profile, so this is
    # also the step that creates it on a box that has only ever been an add-on.
    if compose --profile standalone up -d --no-deps freepbx; then
        [ "$DRY_RUN" = 1 ] || pass "bundled FreePBX up (profile standalone)"
    else
        fail "could not bring up the bundled FreePBX — see the compose output above"
        info "when the error names 'port is already allocated', the shared PBX above is holding it"
        revert_env
        exit 1
    fi
    target="$BUNDLED_PBX"
else
    set_env CAPSTONE_PBX zeus
    if docker inspect "$BUNDLED_PBX" >/dev/null 2>&1; then
        if compose --profile standalone stop freepbx; then
            [ "$DRY_RUN" = 1 ] || pass "bundled FreePBX stopped (its container is kept, so a switch back is instant)"
        else
            warn "could not stop $BUNDLED_PBX — stop it by hand before trusting the mode"
        fi
    else
        [ "$DRY_RUN" = 1 ] || pass "no bundled FreePBX on this host — nothing to stop"
    fi
    if ! running "$SHARED_PBX"; then
        fail "$SHARED_PBX is not running — start the Zeus stack first"
        revert_env
        exit 1
    fi
    target="$SHARED_PBX"
fi

# dashboard-api reads CAPSTONE_DEPLOY_MODE from its environment at create time,
# so a recreate (not a restart) is what makes the change stick there. Its own
# switch writes a state file the same process reads, which is why the Control
# Center can convert without this; .env is what survives a recreate.
if compose up -d --no-deps dashboard-api; then
    [ "$DRY_RUN" = 1 ] || pass "dashboard-api recreated with CAPSTONE_DEPLOY_MODE=$MODE"
else
    warn "dashboard-api was not recreated — its next recreate will pick up the mode"
fi

verify_dialplan "$target"

echo
if [ "$DRY_RUN" = 1 ]; then
    info "dry run — nothing was changed"
else
    pass "mode is $MODE"
fi
info "the Control Center's Agents page shows it; 'bash scripts/deploy-mode.sh' reports the host's view"
