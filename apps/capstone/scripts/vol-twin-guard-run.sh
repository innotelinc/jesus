#!/bin/sh
# Run the volume-twin guard, keep a rotating log, and make a failure reach a human.
#
# Three outputs, deliberately different:
#   /var/log/vol-twin-guard.log  every run, one line when healthy, full output on
#                                failure (rotated by /etc/logrotate.d/vol-twin-guard)
#   journal (user.err)           only failures, so `journalctl -t vol-twin-guard` stays useful
#   ntfy push                    only failures, urgent priority, body is the finding
#
# Two push channels, because "sent" is not "seen":
#   1. the estate topic in /etc/innotel/ntfy.env -- the same ntfy and the same
#      `estate-alerts` topic every other host's OnFailure unit uses, so it lands in the
#      app that is already being watched;
#   2. ALERT_NTFY_URL from /etc/vol-twin-guard.conf -- the per-guard URL, kept as a
#      second channel (and as the only one if the estate credential is absent).
#
# Credentials never appear in argv: curl reads the user/password from a mode-600 config
# on disk that is removed straight after the push, and the body goes in from a file.
set -u

CONF=/etc/vol-twin-guard.conf
ESTATE=/etc/innotel/ntfy.env
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

TITLE="$(hostname): a live volume looks empty"

# channel 1: the estate topic
estate_rc=1
if [ -r "$ESTATE" ]; then
  (
    set -a
    . "$ESTATE"
    set +a
    [ -n "${NTFY_URL:-}" ] && [ -n "${NTFY_TOPIC:-}" ] || exit 1
    cfg=$(mktemp) || exit 1
    body=$(mktemp) || { rm -f "$cfg"; exit 1; }
    (umask 077; printf 'user = "%s:%s"\n' "${NTFY_USER:-}" "${NTFY_PASSWORD:-}" > "$cfg")
    printf '%s\n' "$out" > "$body"
    if curl -fsS -m 20 -K "$cfg" \
        -H "Title: $TITLE" -H "Priority: urgent" -H "Tags: rotating_light" \
        --data-binary @"$body" "${NTFY_URL}/${NTFY_TOPIC}" >/dev/null 2>&1; then
      exit 0
    fi
    exit 1
  )
  estate_rc=$?
else
  estate_rc=2
fi

case "$estate_rc" in
  0) logger -t vol-twin-guard -p user.info "alert pushed to estate ntfy" ;;
  2) logger -t vol-twin-guard -p user.warning "no $ESTATE; estate channel skipped" ;;
  *) logger -t vol-twin-guard -p user.err "estate ntfy push failed" ;;
esac

# channel 2: the guard's own URL
if [ -n "$ALERT_NTFY_URL" ]; then
  if printf '%s\n' "$out" | curl -fsS -m 20 \
      -H "Title: $TITLE" -H "Priority: urgent" -H "Tags: rotating_light" \
      --data-binary @- "$ALERT_NTFY_URL" >/dev/null 2>&1; then
    logger -t vol-twin-guard -p user.info "alert pushed to guard ntfy url"
  else
    logger -t vol-twin-guard -p user.err "guard ntfy alert failed (guard result still exits $rc)"
  fi
fi

exit "$rc"
