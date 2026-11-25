#!/bin/bash
# rtp-stall-watch.sh — capture the media of the next real handset call.
#
# The two RTP inactivity notices ever logged (00:07:19 and 04:22:47 on
# 2026-11-25) both named PJSIP/101: the *handset* stopped sending RTP for 30 s
# and FreePBX's rtp_timeout tore the call down. Nothing in Asterisk's log says
# whether the phone went quiet because it stopped transmitting, because the path
# dropped, or because it suppressed silence — that needs the packets.
#
# The teardown is already fixed (deploy/pbx-voice-hardening.sh sets
# rtp_timeout=0), so this is about the next occurrence being evidence instead of
# a mystery. It watches for a call on a handset extension and captures that
# call's media, then analyses it with scripts/rtp_probe.py. Nobody has to be at a
# terminal when the phone rings.
#
# Note what will NOT appear: the dograh leg is a `WebSocket/dograh/…` channel
# over ARI, so only the handset legs emit RTP. Zero media for a local
# `Local/201@from-internal` test call is expected, not a capture failure.
#
# Installed on the PBX host as /usr/local/sbin/rtp-stall-watch.sh and run from
# /etc/cron.d/rtp-stall-watch every minute. Each run watches for a minute; a run
# that found a call keeps capturing until the call ends (hard stop: 2 h).
set -u

C=${FREEPBX_CONTAINER:-freepbx-qvifit87vftfxd9ejsch2vxy}
DIR=${RTP_WATCH_DIR:-/var/log/rtp-watch}
PROBE=${RTP_PROBE:-/usr/local/bin/rtp-probe.py}
TARGETS='^PJSIP/(101|102|301|302)-'
WINDOW=${RTP_WATCH_WINDOW:-55}
MAX_CALL=${RTP_WATCH_MAX_CALL:-7200}

mkdir -p "$DIR" || exit 1
# One watcher at a time: cron fires every minute, and a call can outlive a tick.
exec 9>"$DIR/.lock" || exit 0
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date -Is)" "$*" >>"$DIR/watch.log"; }
handsets() {
  docker exec "$C" asterisk -rx "core show channels concise" 2>/dev/null \
    | grep -Ec "$TARGETS" 2>/dev/null || true
}

cap=""
pcap=""
started=0

stop_capture() {
  [ -n "$cap" ] || return 0
  kill "$cap" 2>/dev/null
  wait "$cap" 2>/dev/null
  cap=""
  log "call ended; analysing $pcap"
  if [ -x "$PROBE" ] && [ -s "$pcap" ]; then
    python3 "$PROBE" --pcap "$pcap" --gap 2.0 >>"$DIR/watch.log" 2>&1
    rc=$?
    # Every analysed call gets one VERDICT line, not just the stalled ones: the
    # Control Center reads it to close the silence-suppression question, and a
    # call where the handset kept sending throughout is that answer. Without
    # this line, the healthy case leaves nothing behind to read.
    verdict=$(python3 "$PROBE" --pcap "$pcap" --verdict-line 2>/dev/null | head -1)
    log "${verdict:-VERDICT: unreadable — the probe printed no verdict} — $pcap"
    # rtp_probe exits 2 when some stream went silent for 30 s or more: that is
    # the event this watcher exists for, so it gets its own line — and the probe
    # names the cause (the handset stopped sending, or the path ate the packets),
    # which is the part Asterisk's "lack of audio RTP activity" cannot tell.
    if [ "$rc" -eq 2 ]; then
      line=$(python3 "$PROBE" --pcap "$pcap" --stall-line 2>/dev/null | head -1)
      log "${line:-STALL: a leg went silent for 30 s or more} — $pcap"
    fi
    [ "$rc" -eq 1 ] && log "note: could not analyse $pcap (see the error above)"
  else
    log "note: no probe at $PROBE, or the capture is empty; pcap kept at $pcap"
  fi
  pcap=""
}
trap 'stop_capture' EXIT INT TERM

deadline=$(( $(date +%s) + WINDOW ))
while :; do
  n=$(handsets)
  if [ "${n:-0}" -gt 0 ] && [ -z "$cap" ]; then
    pcap="$DIR/call-$(date -u +%Y%m%dT%H%M%SZ).pcap"
    tcpdump -i any -n -s 0 -U -w "$pcap" 'udp and not port 53' >/dev/null 2>&1 &
    cap=$!
    started=$(date +%s)
    log "capture started for $n handset channel(s) → $pcap"
  elif [ "${n:-0}" -eq 0 ] && [ -n "$cap" ]; then
    stop_capture
  fi
  if [ -z "$cap" ] && [ "$(date +%s)" -ge "$deadline" ]; then
    break   # idle and the tick's window is over
  fi
  if [ -n "$cap" ] && [ $(( $(date +%s) - started )) -gt "$MAX_CALL" ]; then
    log "capture has run ${MAX_CALL}s; stopping rather than leaving tcpdump behind"
    stop_capture
    break
  fi
  sleep 2
done
exit 0
