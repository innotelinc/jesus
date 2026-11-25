#!/bin/sh
# Run the volume-twin guard, keep a rotating log, and make a failure reach a human.
#
# Three outputs, deliberately different:
#   /var/log/vol-twin-guard.log  every run, one line when healthy, full output on
#                                failure (rotated by /etc/logrotate.d/vol-twin-guard)
#   journal (user.err)           only failures, so `journalctl -t vol-twin-guard` stays useful
#   ntfy push                    only failures, urgent priority, body is the finding
#
# The push URL lives in /etc/vol-twin-guard.conf so the topic is not in the cron
# file, in this script, or in the repo. No config means journal-only, not silence.
set -u

CONF=/etc/vol-twin-guard.conf
LOG=/var/log/vol-twin-guard.log
[ -r "$CONF" ] && . "$CONF"
ALERT_NTFY_URL=${ALERT_NTFY_URL:-}

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out=$(/usr/bin/python3 /usr/local/bin/vol-twin-guard.py --all 2>&1)
rc=$?

if [ "$rc" -eq 0 ]; then
  printf '%s ok %s\n' "$ts" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)" >> "$LOG"
  exit 0
fi

{
  printf '%s FAIL rc=%s\n' "$ts" "$rc"
  printf '%s\n' "$out"
} >> "$LOG"

printf '%s' "$out" | logger -t vol-twin-guard -p user.err

if [ -n "$ALERT_NTFY_URL" ]; then
  if printf '%s\n' "$out" | curl -fsS -m 20 \
      -H "Title: $(hostname): a live volume looks empty" \
      -H "Priority: urgent" \
      -H "Tags: rotating_light" \
      --data-binary @- "$ALERT_NTFY_URL" >/dev/null 2>&1; then
    logger -t vol-twin-guard -p user.info "alert pushed to ntfy"
  else
    logger -t vol-twin-guard -p user.err "ntfy alert failed (guard result still exits $rc)"
  fi
fi

exit "$rc"
