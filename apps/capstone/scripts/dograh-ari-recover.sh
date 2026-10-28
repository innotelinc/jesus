#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# capstone — dograh Stasis app healthcheck + auto-recovery
#
# Asterisk routes every dograh extension (the static 8000-8007 set plus the
# ones the Control Center writes into extensions_custom_dograh.conf) into
# Stasis(<stasis app name>). If no ARI client is registered under that name,
# the Stasis() call never starts a call: Asterisk hangs up immediately and the
# caller hears nothing. The dashboard reports it as
#
#     Calls to 8008 will drop: ... registered: none
#
# The usual cause is not a misconfiguration but dograh's own parking policy.
# A telephony configuration whose ARI connection keeps failing is marked
# `inactive` and never retried on its own — upstream calls this "parking is
# one-way: the customer fixes their side and reactivates the configuration
# explicitly". A PBX that is down (or restarted and slow) for longer than the
# transient-failure window therefore leaves the range unable to take calls
# until somebody re-runs scripts/dograh_wire.py by hand, which is the documented
# remedy and now un-parks the configuration as well.
#
#   check   – is the Stasis app registered in Asterisk? (default)
#   recover – if not, re-run scripts/dograh_wire.py (which reactivates a parked
#             ARI config) and re-check, reporting whether calls can be taken
#
# Idempotent and safe to run on a schedule — see the capstone systemd units
# systemd/capstone-dograh-ari.{service,timer}:
#   • app registered                → exit 0, no changes
#   • app missing but recovered     → exit 0
#   • container/API unreachable, or still missing → logs, exit 1 (so the timer
#     run surfaces it in the journal instead of failing silently)
#
# Usage (from the repo root):
#   ./scripts/dograh-ari-recover.sh            # check + auto-recover
#   ./scripts/dograh-ari-recover.sh check      # verify only, no writes
#
# Options:
#   --container NAME   freepbx container (env FREEPBX_CONTAINER, default: the
#                      running container with the compose label, else pbx-freepbx)
#   --app NAME         Stasis app name (env DOGRAH_STASIS_APP_NAME)
#   --wait SECONDS     how long to wait for registration after a repair (60)
#   --env-file PATH    capstone .env (default <repo>/.env)
#
# Requires `docker` on the host (same as the other capstone systemd units) and
# python3 for scripts/dograh_wire.py.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION=recover
CONTAINER="${FREEPBX_CONTAINER:-}"
APP="${DOGRAH_STASIS_APP_NAME:-}"
WAIT_S=60
ENV_FILE="${REPO}/.env"
while [ $# -gt 0 ]; do
  case "$1" in
    check)       ACTION=check ;;
    recover|fix) ACTION=recover ;;
    --container) CONTAINER="${2:?--container needs a value}"; shift ;;
    --app)       APP="${2:?--app needs a value}"; shift ;;
    --wait)      WAIT_S="${2:?--wait needs a value}"; shift ;;
    --env-file)  ENV_FILE="${2:?--env-file needs a value}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[dograh-ari] %s\n' "$*"; }

# ── the repo's .env carries DOGRAH_STASIS_APP_NAME / DOGRAH_CONFIG_NAME ─────
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090  # the operator's own env file, not a tracked path
  . "$ENV_FILE"
  set +a
fi
APP="${APP:-${DOGRAH_STASIS_APP_NAME:-}}"

# ── resolve the freepbx container ──────────────────────────────────────────
# The compose container_name is pbx-freepbx, but a daemon hiccup can leave it
# named <hash>_pbx-freepbx, and on a shared voice host the PBX belongs to
# another stack entirely (zeus's zeus-freepbx). Prefer the running container
# with the compose service label, exactly as scripts/smoke-e2e.sh does.
if [ -z "$CONTAINER" ]; then
  for c in $(docker ps -aq --filter "label=com.docker.compose.service=freepbx" 2>/dev/null); do
    if [ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" = "running" ]; then
      CONTAINER="$c"
      break
    fi
  done
  CONTAINER="${CONTAINER:-pbx-freepbx}"  # fallback: the compose container_name
fi

# Ask docker about the container directly rather than matching it against
# `docker ps` names: the label lookup above yields an ID, the fallback yields a
# name, and the check has to accept either.
if [ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)" != "running" ]; then
  log "ERROR: PBX container '$CONTAINER' is not running — ARI cannot be checked"
  exit 1
fi

ari_apps() { docker exec "$CONTAINER" asterisk -rx "ari show apps" 2>&1; }

registered() {
  [ -n "$APP" ] || return 1
  ari_apps | grep -qw -- "$APP"
}

# ARI is served by the same Asterisk, on 8088. When that port is closed there
# is nothing to repair: dograh cannot connect to a PBX that isn't answering,
# and reactivating the config on a loop would only churn (and this runs on a
# timer). Report it and stop — the operator's job is the PBX, not dograh.
ari_reachable() {
  docker exec "$CONTAINER" bash -c \
    "exec 3<>/dev/tcp/127.0.0.1/8088 2>/dev/null" 2>/dev/null
}

if [ -z "$APP" ]; then
  log "WARNING: no Stasis app name known (DOGRAH_STASIS_APP_NAME unset in $ENV_FILE)"
fi

# ── healthy? ───────────────────────────────────────────────────────────────
if registered; then
  log "OK — Stasis app '$APP' is registered (container '$CONTAINER')"
  exit 0
fi

log "WARNING — Stasis app '${APP:-<unknown>}' is NOT registered in Asterisk; calls routed into it hang up"
if [ "$ACTION" = "check" ]; then
  log "registered apps: $(ari_apps | tail -n +3 | tr -s ' ' | paste -sd, -)"
  exit 1
fi

if ! ari_reachable; then
  log "ERROR — Asterisk ARI is not listening inside '$CONTAINER' (checked its own loopback)"
  log "       dograh cannot register the Stasis app until the PBX answers; not repairing"
  exit 1
fi

# ── recover ───────────────────────────────────────────────────────────────
# scripts/dograh_wire.py is the repair, not merely a verification: it
# reactivates a configuration dograh parked and re-asserts the Stasis app name
# the dialplan must route into. It is idempotent, so running it here is safe.
WIRE="${REPO}/scripts/dograh_wire.py"
if [ ! -f "$WIRE" ]; then
  log "ERROR: $WIRE is missing — cannot repair the ARI configuration"
  exit 1
fi

log "repairing: python3 scripts/dograh_wire.py --env-file $ENV_FILE"
if ! wire_out="$(python3 "$WIRE" --env-file "$ENV_FILE" 2>&1)"; then
  log "ERROR: dograh_wire.py failed:"
  printf '%s\n' "$wire_out" | sed 's/^/    /'
  exit 1
fi
printf '%s\n' "$wire_out" | grep -E "reactivat|parked|Stasis app name|PROBLEM" | sed 's/^/    /'

# Re-read the env now: the wire script persists a freshly-learned app name, and
# that is the name the entrypoint will have injected into the dialplan.
if [ -z "$APP" ] && [ -f "$ENV_FILE" ]; then
  APP="$(grep -E '^DOGRAH_STASIS_APP_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  log "learned Stasis app name from $ENV_FILE: ${APP:-<none>}"
fi

# dograh's ARI manager polls on its own schedule, so registration is not
# instantaneous — give it the full window before calling the repair a failure.
log "waiting up to ${WAIT_S}s for '$APP' to register…"
deadline=$(( $(date +%s) + WAIT_S ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if registered; then
    log "OK — recovered: Stasis app '$APP' is registered again"
    exit 0
  fi
  sleep 3
done

log "ERROR — '$APP' still not registered after ${WAIT_S}s; calls to the dograh extensions will still hang up"
log "       check that ARI is reachable and the PBX is up, then re-run scripts/dograh_wire.py"
exit 1
