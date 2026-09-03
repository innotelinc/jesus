#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# capstone — FreePBX web-UI healthcheck + auto-recovery
#
# The freepbx container's Docker healthcheck probes Asterisk (`asterisk -rx
# core show version`), NOT the web UI. So a stale /var/run/apache2/apache2.pid
# from a previous boot (docker restart preserves /var/run) makes apache2ctl
# refuse to start with "httpd (pid N) already running", the GUI stays down, and
# the container still reports healthy. This script closes that gap:
#
#   check   – is the web UI responding on :80?
#   recover – if not, clear any stale pid and start Apache, then re-verify
#
# It is idempotent and safe to run on a schedule (see the capstone systemd
# units systemd/capstone-freepbx-web.{service,timer}):
#   • healthy UI  → exit 0, no changes
#   • UI down but recoverable (stale pid / Apache died) → recovers, exit 0
#   • container missing / unrecoverable → logs, exit 1 (so the timer surfaces it)
#
# Usage (from the repo root):
#   ./scripts/freepbx-web-recover.sh check     # verify only (default behaviour)
#   ./scripts/freepbx-web-recover.sh recover   # check + auto-recover
#   ./scripts/freepbx-web-recover.sh           # same as recover
#
# Options:
#   --container NAME   freepbx container (env FREEPBX_CONTAINER, default pbx-freepbx)
#   --port N           web port to probe (default 80)
#
# Requires `docker` on the host (same as the capstone systemd units).
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

CONTAINER="${FREEPBX_CONTAINER:-pbx-freepbx}"
PORT=80
ACTION=recover
while [ $# -gt 0 ]; do
  case "$1" in
    check)   ACTION=check ;;
    recover|fix|start) ACTION=recover ;;
    --container) CONTAINER="${2:?--container needs a value}"; shift ;;
    --port)   PORT="${2:?--port needs a value}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '[freepbx-web] %s\n' "$*"; }

# ── presence ────────────────────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  log "ERROR: container '$CONTAINER' is not running — web UI cannot be checked"
  exit 1
fi

# ── is Apache serving the web UI? ───────────────────────────────────────────
web_ok() {
  # Return 0 only if something answers TCP on the web port inside the container.
  # NB: use `bash` here — /dev/tcp is a bashism and the container's /bin/sh is
  # dash, which cannot open it ("/dev/tcp/...: Directory nonexistent"). The
  # stock entrypoint uses the same bash-based probe to wait for the web UI.
  docker exec "$CONTAINER" bash -c \
    "exec 3<>/dev/tcp/127.0.0.1/$PORT 2>/dev/null" 2>/dev/null && return 0
  return 1
}

if web_ok; then
  log "OK — web UI responding on 127.0.0.1:$PORT (container '$CONTAINER')"
  exit 0
fi
log "WARNING — web UI NOT responding on 127.0.0.1:$PORT"

# ── diagnose: is it a stale pid? is Apache even running? ────────────────────
pidfile="/var/run/apache2/apache2.pid"
stale=""; apache_running=""
if docker exec "$CONTAINER" sh -c "[ -f $pidfile ]" 2>/dev/null; then
  pid=$(docker exec "$CONTAINER" sh -c "cat $pidfile" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$pid" ]; then
    if docker exec "$CONTAINER" sh -c "kill -0 $pid" 2>/dev/null; then
      apache_running=1   # a live apache pid exists but the port is closed → broken/deadlock
    else
      stale=1            # the pid file points at a dead process → classic stale-pid case
    fi
  fi
fi

if [ "$ACTION" = "check" ]; then
  if [ "${stale:-}" = "1" ]; then
    log "DETECTED stale apache2.pid ($pidfile → pid ${pid:-?}) — run 'recover' to fix"
  else
    log "DETECTED web UI down (apache_running=${apache_running:-no} stale_pid=${stale:-no})"
  fi
  log "mode=check — not changing anything"
  exit 1
fi

# ── recover ────────────────────────────────────────────────────────────────
log "recovering web UI in '$CONTAINER'..."
if [ "${stale:-}" = "1" ] || [ -z "${apache_running:-}" ]; then
  log "clearing stale pidfile $pidfile"
  docker exec "$CONTAINER" sh -c "rm -f $pidfile" 2>/dev/null || true
fi

# Start Apache the same way the stock entrypoint does. apache2ctl reads
# /etc/apache2/envvars (so it runs as asterisk:asterisk, matching the Apply
# Config fix) and daemonizes; FOREGROUND is fine under docker exec but plain
# start is simpler for a detached recover.
docker exec -d "$CONTAINER" sh -c "apache2ctl -D FOREGROUND >/tmp/freepbx-web-recover.log 2>&1" \
  || docker exec "$CONTAINER" sh -c "apache2ctl start >/tmp/freepbx-web-recover.log 2>&1" \
  || { log "ERROR: apache2ctl failed — see /tmp/freepbx-web-recover.log"; exit 1; }

# Give Apache a moment then re-verify.
for _ in $(seq 1 15); do
  if web_ok; then
    log "OK — web UI recovered and responding on 127.0.0.1:$PORT"
    exit 0
  fi
  sleep 1
done

log "ERROR — web UI still not responding after recovery (see $CONTAINER:/tmp/freepbx-web-recover.log)"
exit 1