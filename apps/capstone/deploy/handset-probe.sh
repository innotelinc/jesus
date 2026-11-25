#!/bin/bash
# handset-probe.sh — make the handset answer, and prove what it was asked.
#
# `rtp-stall-watch.sh` can only judge a call somebody answers, and nobody can be
# made to pick up a desk phone at 03:00. That is what kept the
# silence-suppression question open. A Grandstream (and most desk phones) will
# auto-answer an INVITE carrying one of two vendor conventions, so this rings the
# handset with each in turn, holds the call long enough for the watcher to
# capture it, and prints the `VERDICT:` line the watcher wrote.
#
# It also proves what the phone was asked: the INVITE, the auto-answer header on
# it, and the status codes that came back. That has already caught two wrong
# conclusions here, so it is part of the tool rather than an afterthought:
#
#   * a `Set(PJSIP_HEADER(add,Call-Info)…)` on the *calling* channel never
#     reaches the outgoing INVITE — the header belongs to the dialed channel, so
#     it is set in a pre-dial handler (`Dial(…,b(handler^1^1))`);
#   * the value's `;` is a dialplan comment character, so a header can silently
#     lose everything after it.
#
# SAFETY: this used to rewrite /etc/asterisk/extensions_custom.conf in place.
# It must not. That file is the estate's whole hand-written dialplan, and a
# mistake there takes the agents down. The probe's contexts now live in their own
# file, extensions_custom_handset_probe.conf, and this only ever appends one
# `#include` line to the main file (once, backed up first).
#
# Variants (PROBE_VARIANTS, default both, in this order):
#   call-info   Call-Info: <sip:probe@localhost>;answer-after=0   (the intercom convention;
#               on the T54W at 192.168.1.10 this is Features → General →
#               "Allow Auto Answer by Call-Info")
#   alert-info  Alert-Info: <http://127.0.0.1>;info=alert-autoanswer
#
#   handset-probe.sh                      # probe 101, both variants
#   handset-probe.sh 102
#   PROBE_RING=20 PROBE_HOLD=90 PROBE_VARIANTS=call-info handset-probe.sh 101
#
# Exit codes: 0 the call was answered and analysed, 3 no variant was answered
# (the SIP evidence says whether the header was even sent), 1 an error.
set -u

C=${FREEPBX_CONTAINER:-freepbx-qvifit87vftfxd9ejsch2vxy}
EXT=${1:-101}
RING=${PROBE_RING:-25}
HOLD=${PROBE_HOLD:-130}
VARIANTS=${PROBE_VARIANTS:-"call-info alert-info"}
DIR=${RTP_WATCH_DIR:-/var/log/rtp-watch}

# The variant names carry a hyphen (`call-info`); the dialplan contexts do not
# (`…-callinfo`). One place maps one to the other, because when they disagreed
# `channel originate` logged "No such extension/context" and never rang the
# handset at all — the probe then reported an empty SIP capture as if the phone
# had refused.
ctx_name() {
  case $1 in
    call-info) echo capstone-handset-probe-callinfo ;;
    alert-info) echo capstone-handset-probe-alertinfo ;;
    *) echo "" ;;
  esac
}

MAIN=/etc/asterisk/extensions_custom.conf
HELPER=/etc/asterisk/extensions_custom_handset_probe.conf
INCLUDE='#include extensions_custom_handset_probe.conf'

ast() { docker exec "$C" asterisk -rx "$1" 2>&1; }
channel_state() {
  # A ringing channel is already listed, so the name proves nothing — the state
  # column (Ring / Up / Down) is what says the handset actually picked up.
  ast "core show channels" | awk -v pat="^PJSIP/$1-" '$0 ~ pat { print $3; exit }'
}

block() {
  cat <<'CONF'
; Managed by deploy/handset-probe.sh — an auto-answer INVITE to a handset, so
; the RTP-stall watcher has an answered call to analyse without a human at the
; desk. Included from extensions_custom.conf; do not edit by hand.
[capstone-handset-probe-callinfo]
exten => _X.,1,NoOp(Capstone handset probe (call-info) to ${EXTEN})
 same => n,Dial(PJSIP/${EXTEN},__RING__,b(capstone-handset-probe-hdr-callinfo^1^1)tT)
 same => n,Hangup()

[capstone-handset-probe-hdr-callinfo]
exten => 1,1,NoOp(Adding Call-Info auto-answer header)
 same => n,Set(PJSIP_HEADER(add,Call-Info)=<sip:probe@localhost>\;answer-after=0)
 same => n,Return()

[capstone-handset-probe-alertinfo]
exten => _X.,1,NoOp(Capstone handset probe (alert-info) to ${EXTEN})
 same => n,Dial(PJSIP/${EXTEN},__RING__,b(capstone-handset-probe-hdr-alertinfo^1^1)tT)
 same => n,Hangup()

[capstone-handset-probe-hdr-alertinfo]
exten => 1,1,NoOp(Adding Alert-Info auto-answer header)
 same => n,Set(PJSIP_HEADER(add,Alert-Info)=<http://127.0.0.1>\;info=alert-autoanswer)
 same => n,Return()
CONF
}

sip_summary() {
  # The INVITE, the header it carried, and the phone's status codes — read from
  # the packets, which is the only place that shows what the phone was told.
  local pcap=$1 text invite header codes
  if [ ! -s "$pcap" ]; then
    echo "  (no SIP packets captured — this attempt proves nothing)"
    return
  fi
  text=$(tcpdump -r "$pcap" -n -A 2>/dev/null | tr -d '\r')
  # Each of these is captured first and defaulted second: a pipeline ending in
  # `head` exits 0 even when it printed nothing, so `|| echo` never fired and the
  # probe printed a blank line where the evidence should be.
  invite=$(printf '%s\n' "$text" | grep -aoE "INVITE sip:${EXT}@[^ ]+ SIP/2\.0" | head -1 || true)
  header=$(printf '%s\n' "$text" | grep -aoE '(Call-Info|Alert-Info): [^\r]*' | sort -u | paste -sd'; ' - || true)
  codes=$(printf '%s\n' "$text" | grep -aoE 'SIP/2\.0 [0-9]{3}[A-Za-z ]*' | sort -u | paste -sd'; ' - || true)
  printf '  INVITE to the handset: %s\n' "${invite:-NOT PRESENT — no call left this box}"
  printf '  auto-answer header: %s\n' "${header:-NOT PRESENT on the INVITE}"
  printf '  handset status codes: %s\n' "${codes:-none}"
}

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$DIR"

# Our own dialplan file, plus one include line in the main file — nothing else.
block | sed "s/__RING__/$RING/" > "$tmp/helper"
docker cp "$tmp/helper" "$C:$HELPER" >/dev/null || { echo "cannot write $HELPER" >&2; exit 1; }

docker cp "$C:$MAIN" "$tmp/main" >/dev/null 2>&1 || { echo "cannot read $MAIN" >&2; exit 1; }
if grep -qxF "$INCLUDE" "$tmp/main"; then
  echo "include already present in $MAIN"
else
  cp -a "$tmp/main" "/var/backups/extensions_custom.conf.$(date -u +%Y%m%dT%H%M%SZ)"
  before=$(wc -l < "$tmp/main")
  printf '\n%s\n' "$INCLUDE" >> "$tmp/main"
  after=$(wc -l < "$tmp/main")
  if [ "$after" -gt $((before + 2)) ]; then
    echo "refusing to write $MAIN: the include append grew it by more than two lines" >&2
    exit 1
  fi
  docker cp "$tmp/main" "$C:$MAIN" >/dev/null || { echo "cannot write $MAIN" >&2; exit 1; }
  echo "added '$INCLUDE' to $MAIN (backed up)"
fi

ast "dialplan reload" | tail -1

for variant in $VARIANTS; do
  context=$(ctx_name "$variant")
  if [ -z "$context" ]; then
    echo "unknown PROBE_VARIANTS entry '$variant' (use call-info / alert-info)" >&2
    exit 1
  fi
  if ! ast "dialplan show $context" | grep -q "$context"; then
    echo "the probe context $context did not load — check $HELPER" >&2
    exit 1
  fi
done

before=$(grep -c ' VERDICT:' "$DIR/watch.log" 2>/dev/null || true)
answered=0

for variant in $VARIANTS; do
  sipcap="$DIR/sip-$(date -u +%Y%m%dT%H%M%SZ)-$variant.pcap"
  echo "--- $variant: ringing $EXT (${RING}s ring)"

  tcpdump -i any -n -s 0 -U -w "$sipcap" 'port 5060' >/dev/null 2>&1 &
  sip_pid=$!
  sleep 2
  ast "channel originate Local/${EXT}@$(ctx_name "$variant") application Wait $HOLD" >/dev/null

  start=$SECONDS
  while [ $((SECONDS - start)) -lt "$((RING + 3))" ]; do
    if [ "$(channel_state "$EXT")" = "Up" ]; then
      answered=1
      break
    fi
    sleep 2
  done

  if [ "$answered" -eq 1 ]; then
    echo "$EXT answered — holding the call so the watcher can capture it"
    end=$((SECONDS + HOLD + 10))
    while [ $((SECONDS)) -lt "$end" ] && [ -n "$(channel_state "$EXT")" ]; do
      sleep 3
    done
  fi
  for ch in $(ast "core show channels" | grep -oE "PJSIP/${EXT}-[0-9a-f]+" || true); do
    ast "channel request hangup $ch" >/dev/null
  done

  kill "$sip_pid" 2>/dev/null
  wait "$sip_pid" 2>/dev/null
  [ -f "$sipcap" ] && chmod 600 "$sipcap"
  echo "  SIP (from the packets of this attempt):"
  sip_summary "$sipcap"

  [ "$answered" -eq 1 ] && break
  echo "$EXT did not answer this variant"
done

if [ "$answered" -eq 0 ]; then
  echo
  echo "No variant was answered on $EXT. If the auto-answer header above is on the"
  echo "INVITE, the refusal is the handset's: on its web UI (https://192.168.1.10/)"
  echo "set Features -> General -> \"Allow Auto Answer by Call-Info\" = Enabled."
  echo "If the header is NOT PRESENT, it was never sent and this probe proves"
  echo "nothing about the phone."
  exit 3
fi

echo "waiting for the watcher's verdict ..."
line=""
deadline=$((SECONDS + 150))
while [ "$SECONDS" -lt "$deadline" ]; do
  now=$(grep -c ' VERDICT:' "$DIR/watch.log" 2>/dev/null || true)
  if [ "${now:-0}" -gt "${before:-0}" ]; then
    line=$(grep ' VERDICT:' "$DIR/watch.log" | tail -1)
    break
  fi
  sleep 5
done

if [ -n "$line" ]; then
  echo "${line#* }"
  exit 0
fi
echo "no verdict appeared in $DIR/watch.log — the watcher may have been mid-tick; re-run, or check $DIR/watch.log" >&2
exit 0
