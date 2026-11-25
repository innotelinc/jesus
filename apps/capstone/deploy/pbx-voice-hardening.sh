#!/bin/bash
# Re-asserts the estate's PJSIP endpoint settings on the FreePBX box.
#
# These settings were applied by hand on 2026-11-25 and lived only on the host,
# so a rebuilt config volume silently restores FreePBX's defaults:
#   * rtp_timeout=30 tears a call down after 30 s without inbound RTP. That is
#     how a 121 s interview ended: res_pjsip_sdp_rtp logged "lack of audio RTP
#     activity in 30 seconds" 30 s before the caller hung up. A media stall is
#     not a reason to drop the call, so the teardown is disabled (rtp_timeout=0)
#     and this side keeps the stream alive (rtp_keepalive=15).
#   * rtp_timeout_hold=300 drops a long hold mid-MOH.
#   * direct_media=yes would take Asterisk out of the media path, losing MOH and
#     hold for internal calls.
#
# Idempotent. The settings live in one managed block appended to
# pjsip.endpoint_custom_post.conf, which FreePBX includes after its generated
# endpoint config; endpoint sections are additive ("[101](+)"), so the same keys
# in several sections are legal. A *conflicting* value outside the block is
# reported instead of silently losing, because which section wins is not obvious
# from the file alone.
#
#   pbx-voice-hardening.sh --check    report drift, change nothing (exit 1 on drift)
#   pbx-voice-hardening.sh --render   print the managed block, touch nothing
#   pbx-voice-hardening.sh            apply, reload res_pjsip, verify live values
set -u

C=${FREEPBX_CONTAINER:-freepbx-qvifit87vftfxd9ejsch2vxy}
CONF=/etc/asterisk/pjsip.endpoint_custom_post.conf
LOG=/var/log/pbx-voice-hardening.log
BEGIN='; >>> telno-estate-voice-hardening (managed by deploy/pbx-voice-hardening.sh)'
END='; <<< telno-estate-voice-hardening'
ENDPOINTS="101 102 301 302"
DRY=0
case "${1:-}" in
  --check) DRY=1 ;;
  --render) RENDER=1 ;;
  '') ;;
  *) echo "usage: $0 [--check|--render]" >&2; exit 2 ;;
esac

[ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ] && : > "$LOG"
say() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; [ $DRY -eq 0 ] && printf '%s\n' "$*" >&2; return 0; }
ast() { docker exec "$C" asterisk -rx "$1" 2>&1; }

render_block() {
  printf '%s\n' "$BEGIN"
  printf '%s\n' "; Re-asserted by deploy/pbx-voice-hardening.sh; edit that script, not this block."
  local ep
  for ep in $ENDPOINTS; do
    printf '\n[%s](+)\n' "$ep"
    echo "; internal calls: keep Asterisk in the media path so hold/MOH works"
    echo "direct_media=no"
    # 102 is the fax device: FreePBX points its MWI at 102@device, and there is
    # no such mailbox, so no mailboxes line is written for it.
    if [ "$ep" != "102" ]; then
      echo "; MWI against a mailbox that exists in voicemail.conf"
      echo "mailboxes = ${ep}@default"
    fi
    echo "; a media stall must not end the call (FreePBX default 30 s)"
    echo "rtp_timeout=0"
    echo "; keep the stream alive from this side instead"
    echo "rtp_keepalive=15"
    echo "; do not drop a long hold mid-MOH (FreePBX default 300 s)"
    echo "rtp_timeout_hold=1800"
  done
  printf '\n%s\n' "$END"
}

if [ "${RENDER:-0}" = "1" ]; then render_block; exit 0; fi

# What the running Asterisk must report, keyed as `pjsip show endpoint` prints it.
expected() {
  case "$1" in
    direct_media) echo "false" ;;
    rtp_timeout) echo "0" ;;
    rtp_keepalive) echo "15" ;;
    rtp_timeout_hold) echo "1800" ;;
  esac
}

# `pjsip show endpoint 101` → "0" / "false" / "15", empty when absent.
live_value() {
  ast "pjsip show endpoint $1" | awk -v k="$2" '
    $1 == k && $2 == ":" { v = $3; gsub(/^[ \t]+|[ \t]+$/, "", v); print v; exit }'
}

drift=0
for ep in $ENDPOINTS; do
  for key in direct_media rtp_timeout rtp_keepalive rtp_timeout_hold; do
    want=$(expected "$key"); got=$(live_value "$ep" "$key")
    if [ "$got" != "$want" ]; then
      printf 'DRIFT endpoint %s %s=%s (want %s)\n' "$ep" "$key" "${got:-unset}" "$want"
      drift=1
    fi
  done
  if ast "pjsip show endpoint $ep" | grep -qE '^ *No such endpoint'; then
    printf 'DRIFT endpoint %s does not exist\n' "$ep"; drift=1
  fi
done

if [ $DRY -eq 1 ]; then
  if [ $drift -eq 0 ]; then
    say "PASS voice hardening holds on $ENDPOINTS"
  else
    say "voice hardening drifted on $C; run deploy/pbx-voice-hardening.sh to re-assert $CONF"
  fi
  exit $drift
fi

# ── apply ────────────────────────────────────────────────────────────────────
TMP=$(mktemp) || exit 1
NEW=$(mktemp) || exit 1
trap 'rm -f "$TMP" "$NEW"' EXIT
if ! docker cp "$C:$CONF" "$TMP" 2>/dev/null; then
  if docker exec "$C" test -f "$CONF"; then
    say "FAIL cannot read $CONF out of $C"; exit 1
  fi
  : >"$TMP"   # no file yet: create it from the block alone
fi

# Drop a previous block, keep everything else, then append the current one.
awk -v b="$BEGIN" -v e="$END" '
  $0 == b {skip = 1; next}
  $0 == e {skip = 0; next}
  {if (!skip) print}
' "$TMP" >"$NEW"
[ -s "$NEW" ] && [ -n "$(tail -c 1 "$NEW")" ] && echo >>"$NEW"
render_block >>"$NEW"

if cmp -s "$TMP" "$NEW"; then
  echo "note: $CONF already carries the current block; reloading res_pjsip anyway"
else
  BK=$CONF.bak-voice-$(date +%Y%m%dT%H%M%SZ)
  docker exec "$C" sh -c "test -f $CONF && cp -a $CONF $BK" 2>/dev/null
  if docker cp "$NEW" "$C:$CONF" 2>/dev/null; then
    say "wrote the managed block in $CONF (backup: ${BK:-none: file was absent})"
  else
    say "FAIL could not write $CONF back into $C"; exit 1
  fi
fi

# `pjsip reload` is not a command; the module reload is what re-reads the file.
ast "module reload res_pjsip.so" >/dev/null
sleep 2

fail=0
for ep in $ENDPOINTS; do
  for key in direct_media rtp_timeout rtp_keepalive rtp_timeout_hold; do
    want=$(expected "$key"); got=$(live_value "$ep" "$key")
    [ "$got" = "$want" ] || { printf 'FAIL endpoint %s %s=%s (want %s)\n' "$ep" "$key" "${got:-unset}" "$want"; fail=1; }
  done
done
if [ $fail -eq 0 ]; then
  say "PASS voice hardening applied and verified on $ENDPOINTS"
  exit 0
fi
say "FAIL applied but the live values did not take; check 'Config file $CONF could not be loaded' in /var/log/asterisk/full"
exit 1
