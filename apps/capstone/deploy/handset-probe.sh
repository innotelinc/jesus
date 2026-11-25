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
# It also proves what the phone was asked. "It did not answer" is only useful if
# you can tell *why*, and that has already caught one wrong conclusion here: a
# `Set(PJSIP_HEADER(add,Call-Info)…)` on the calling channel never reaches the
# outgoing INVITE at all (the header belongs to the *dialed* channel), so the
# first attempt looked like a refusal when the phone had never been asked. The
# header is therefore added in a pre-dial handler — `Dial(…,b(handler^1^1))` —
# and the probe now reads the INVITE and the phone's replies out of Asterisk's
# own pjsip logger for a deliberate few seconds. The logger is switched off as
# soon as the call is over; nothing is left on.
#
# Variants (PROBE_VARIANTS, default both, in this order):
#   call-info   Call-Info: <sip:probe@localhost>;answer-after=0   (Grandstream intercom)
#   alert-info  Alert-Info: <http://127.0.0.1>;info=alert-autoanswer
#
#   handset-probe.sh                      # probe 101, both variants
#   handset-probe.sh 102
#   PROBE_RING=20 PROBE_HOLD=90 PROBE_VARIANTS=call-info handset-probe.sh 101
#
# Exit codes: 0 the call was answered and analysed, 3 no variant was answered
# (and the SIP evidence says whether the header was actually sent), 1 an error
# before a call could be made.
set -u

C=${FREEPBX_CONTAINER:-freepbx-qvifit87vftfxd9ejsch2vxy}
EXT=${1:-101}
RING=${PROBE_RING:-25}
HOLD=${PROBE_HOLD:-130}
VARIANTS=${PROBE_VARIANTS:-"call-info alert-info"}
DIR=${RTP_WATCH_DIR:-/var/log/rtp-watch}
CONF=/etc/asterisk/extensions_custom.conf
FULL_LOG=/var/log/asterisk/full
BEGIN='; >>> capstone-handset-probe >>>'
END='; <<< capstone-handset-probe <<<'

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
; desk. The header must be added on the DIALED channel, hence the pre-dial
; handlers: a Set(PJSIP_HEADER(...)) on the caller never reaches the INVITE.
; Do not edit by hand; re-run the script instead.
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

log_lines() {
  docker exec "$C" sh -c "wc -l < $FULL_LOG 2>/dev/null || echo 0" 2>/dev/null | tr -dc '0-9'
}

sip_evidence() {
  # Only the lines that answer the question: the INVITE to the handset, the
  # header it carried, and the status codes the phone sent back. This reads
  # Asterisk's pjsip logger for the seconds this attempt lasts — the logger is
  # switched off again immediately afterwards, and never left on.
  local from=${1:-0}
  docker exec "$C" sh -c "tail -n +$(( from + 1 )) $FULL_LOG" 2>/dev/null \
    | tr -d '\r' \
    | grep -aE "INVITE sip:${EXT}@|Call-Info:|Alert-Info:|SIP/2\.0 [1-5][0-9][0-9]" \
    | sed -E 's/^ *//' \
    | sort | uniq -c | sort -rn | head -12 \
    | sed 's/^/    /'
}

cleanup() {
  ast "pjsip set logger off" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

tmp=$(mktemp -d) || exit 1
mkdir -p "$DIR"

docker cp "$C:$CONF" "$tmp/conf" >/dev/null 2>&1 || {
  echo "cannot read $CONF inside $C" >&2
  exit 1
}
cp -a "$tmp/conf" "/var/backups/extensions_custom.conf.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null

# Remove *every* accumulated block, however many got in there, then append one.
# A strip that only removes the first leaves two identical contexts behind, and
# the second silently wins nothing — it just makes the file unreadable.
awk -v b="$BEGIN" -v e="$END" '
  index($0, b) { skip = 1; next }
  skip && index($0, e) { skip = 0; next }
  skip { next }
  { print }
' "$tmp/conf" > "$tmp/stripped"
{ cat "$tmp/stripped"; echo; block | sed "s/__RING__/$RING/"; } > "$tmp/final"

docker cp "$tmp/final" "$C:$CONF" >/dev/null || { echo "cannot write $CONF" >&2; exit 1; }
installed=$(docker exec "$C" sh -c "grep -c 'capstone-handset-probe >>>' $CONF" 2>/dev/null | tr -dc '0-9')
if [ "${installed:-0}" -ne 1 ]; then
  echo "expected exactly one managed block in $CONF, found ${installed:-0}" >&2
  exit 1
fi
ast "dialplan reload" | tail -1

for variant in $VARIANTS; do
  if ! ast "dialplan show capstone-handset-probe-$variant" | grep -q "capstone-handset-probe-$variant"; then
    echo "the probe context capstone-handset-probe-$variant did not load — check $CONF" >&2
    exit 1
  fi
done

before=$(grep -c ' VERDICT:' "$DIR/watch.log" 2>/dev/null || true)
answered=0

for variant in $VARIANTS; do
  echo "--- $variant: ringing $EXT (${RING}s ring)"

  from=$(log_lines)
  ast "pjsip set logger on" >/dev/null

  ast "channel originate Local/${EXT}@capstone-handset-probe-$variant application Wait $HOLD" >/dev/null

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

  ast "pjsip set logger off" >/dev/null
  echo "  SIP (pjsip logger, on only for this attempt):"
  sip_evidence "$from"

  [ "$answered" -eq 1 ] && break
  echo "$EXT did not answer this variant"
done

if [ "$answered" -eq 0 ]; then
  echo
  echo "No variant was answered on $EXT. If the header above is on the INVITE, the"
  echo "refusal is the handset's: enable \"Allow Auto Answer by Call-Info\" (or the"
  echo "phone's intercom/paging auto-answer) in its own web UI. If the header is"
  echo "missing, the dialplan did not apply it and this probe proves nothing."
  echo "No media was captured either way, so the media question stays open."
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
