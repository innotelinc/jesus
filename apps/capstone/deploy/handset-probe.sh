#!/bin/bash
# handset-probe.sh — make the handset answer, so the RTP question can be settled.
#
# `rtp-stall-watch.sh` can only judge a call somebody answers, and nobody can be
# made to pick up a desk phone at 03:00. That is what kept the
# silence-suppression question open. A Grandstream (and most desk phones) will
# auto-answer an INVITE that carries `Call-Info: <sip:x>;answer-after=0` — the
# intercom/paging convention — so this rings the handset with that header, holds
# the call long enough for the watcher to capture and analyse it, and prints the
# `VERDICT:` line the watcher wrote.
#
# It is deliberately quiet and unrecorded: our side sends no audio at all
# (`Wait`), so an auto-answered handset hears silence rather than a stranger,
# and the pcap is read for RTP timing only.
#
# Asterisk's `channel originate` cannot add a SIP header, so the header lives in
# one managed dialplan block. This installs/refreshes that block in
# /etc/asterisk/extensions_custom.conf (with a backup) and reloads the dialplan;
# the block is idempotent, so running the probe twice is safe.
#
#   handset-probe.sh                      # probe 101
#   handset-probe.sh 102                  # another handset
#   PROBE_RING=20 PROBE_HOLD=90 handset-probe.sh 101
#
# Exit codes: 0 the call was answered and analysed, 3 the handset did not answer
# (auto-answer is off on the phone, which is a setting in its own web UI), 1 an
# error before the call could be made.
set -u

C=${FREEPBX_CONTAINER:-freepbx-qvifit87vftfxd9ejsch2vxy}
EXT=${1:-101}
RING=${PROBE_RING:-25}
HOLD=${PROBE_HOLD:-130}
DIR=${RTP_WATCH_DIR:-/var/log/rtp-watch}
CONF=/etc/asterisk/extensions_custom.conf
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
; desk. Do not edit by hand; re-run the script instead.
[capstone-handset-probe]
exten => _X.,1,NoOp(Capstone handset probe to ${EXTEN})
 same => n,Set(PJSIP_HEADER(add,Call-Info)=<sip:probe@localhost>;answer-after=0)
 same => n,Dial(PJSIP/${EXTEN},__RING__,tT)
 same => n,Hangup()
CONF
}

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT

docker cp "$C:$CONF" "$tmp/conf" >/dev/null 2>&1 || {
  echo "cannot read $CONF inside $C" >&2
  exit 1
}
cp -a "$tmp/conf" "/var/backups/extensions_custom.conf.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null

# Drop an older block (idempotence) and append the current one.
awk -v b="$BEGIN" -v e="$END" '
  index($0, b) { skip = 1 }
  !skip { print }
  index($0, e) { skip = 0 }
' "$tmp/conf" > "$tmp/stripped"
{ cat "$tmp/stripped"; echo; block | sed "s/__RING__/$RING/"; } > "$tmp/final"

docker cp "$tmp/final" "$C:$CONF" >/dev/null || { echo "cannot write $CONF" >&2; exit 1; }
ast "dialplan reload" | tail -1

if ! ast "dialplan show capstone-handset-probe" | grep -q "capstone-handset-probe"; then
  echo "the probe context did not load — check $CONF" >&2
  exit 1
fi

before=$(grep -c ' VERDICT:' "$DIR/watch.log" 2>/dev/null || true)
echo "ringing $EXT with an auto-answer INVITE (${RING}s ring, up to ${HOLD}s held)"

ast "channel originate Local/${EXT}@capstone-handset-probe application Wait ${HOLD}" >/dev/null

answered=0
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
else
  echo "$EXT did not answer. A Grandstream auto-answers this probe only when its"
  echo "  account has \"Allow Auto Answer by Call-Info\" enabled (in the phone's own"
  echo "  web UI); otherwise a person has to pick up once. No media was captured, so"
  echo "  this attempt settles nothing."
fi

# Wait for the call to end (or the hold to expire), then clean up any straggler.
end=$((SECONDS + HOLD + 10))
while [ $((SECONDS)) -lt "$end" ] && [ -n "$(channel_state "$EXT")" ]; do
  sleep 3
done
for ch in $(ast "core show channels concise" | grep -oE "^PJSIP/${EXT}-[0-9a-f]+" || true); do
  ast "channel request hangup $ch" >/dev/null
done

if [ "$answered" -eq 0 ]; then
  exit 3
fi

# The watcher analyses when the call ends; give it a tick plus the probe run.
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
