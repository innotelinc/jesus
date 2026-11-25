#!/bin/bash
# prewarm-watch.sh — keep the greeting cache matching what calls will ask for.
#
# The shim prewarms the greetings listed in its prewarm file, and a cache hit is
# 74-84 ms against 1.76 s of dead air on a miss. The list is only correct while
# it matches the *rendered* greeting, and the greeting is rendered from the
# route's initial_context — so editing a greeting, or giving a route a name to
# greet, silently turns every call that route takes back into a 1.76 s miss.
#
# Every five minutes, offline:
#   1. re-export the live routes' contexts from dograh's tables
#   2. --check-prewarm compares the installed list with the greetings rendered
#      under those contexts
#   3. on drift: regenerate the list, install it into the shim's volume and
#      POST /prewarm — no restart, so no caller waits and no audio is dropped
#
# Quiet when in sync. Installed as /usr/local/sbin/prewarm-watch.sh, with the
# renderer in /usr/local/share/capstone (dograh-wire.py + dograh/*.json) and the
# generated list in /var/lib/capstone-prewarm/prewarm.txt.
set -u

WIRE=${PREWARM_WIRE:-/usr/local/share/capstone/dograh-wire.py}
WORKFLOWS=${PREWARM_WORKFLOWS:-/usr/local/share/capstone/dograh}
LIST=${PREWARM_LIST:-/var/lib/capstone-prewarm/prewarm.txt}
STATUS=${PREWARM_STATUS:-/var/lib/capstone-prewarm/status.json}
CONTEXTS=${PREWARM_CONTEXTS:-/etc/capstone/greeting-contexts.json}
CONTEXTS_BIN=${PREWARM_CONTEXTS_BIN:-/usr/local/sbin/greeting-contexts.sh}
SHIM=${TTS_SHIM_CONTAINER:-tts-shim-qvifit87vftfxd9ejsch2vxy}
SHIM_VOLUME=${TTS_SHIM_VOLUME:-/var/lib/docker/volumes/qvifit87vftfxd9ejsch2vxy_capstone-repo/_data}
LOG=/var/log/prewarm-watch.log

[ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ] && : >"$LOG"
say() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }

# What the Control Center shows and alerts on: when the list was last checked,
# whether it matched the routes, and how many greetings that came to. Quiet runs
# leave no log line, so without this file "in sync" and "the cron died" would
# look identical from outside.
write_status() {  # <in_sync> <greetings> <drift|-> <applied> <error|->
  python3 - "$STATUS" "$1" "$2" "$3" "$4" "$5" <<'PY' || say "note: could not write $STATUS"
import datetime, json, os, sys
path, in_sync, greetings, drift, applied, error = sys.argv[1:7]
payload = {
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "inSync": in_sync == "true",
    "greetings": int(greetings or 0),
    "drift": None if drift == "-" else drift,
    "applied": applied == "true",
    "error": None if error == "-" else error,
}
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(payload, fh, indent=2, sort_keys=True)
    fh.write("\n")
os.replace(tmp, path)
PY
}
count_greetings() { awk 'NF && $1 !~ /^#/' "$LIST" 2>/dev/null | wc -l; }
[ -f "$WIRE" ] || { say "no renderer at $WIRE — nothing to do"; exit 0; }

mkdir -p "$(dirname "$LIST")" || exit 1

# A failure here is not fatal: the previous contexts still describe the routes,
# and a stale context is what the drift check exists to catch anyway.
if [ -x "$CONTEXTS_BIN" ]; then
  "$CONTEXTS_BIN" >>"$LOG" 2>&1 || say "note: could not refresh $CONTEXTS; using the previous export"
fi

args=(--workflows-dir "$WORKFLOWS" --prewarm-file "$LIST")
[ -f "$CONTEXTS" ] && args+=(--context-json "$CONTEXTS")

# 1. In sync? Then there is nothing to say and nothing to re-prewarm.
if out=$(python3 "$WIRE" --check-prewarm "${args[@]}" 2>&1); then
  write_status true "$(count_greetings)" - false -
  exit 0
fi
drift=$(printf '%s' "$out" | head -4 | tr '\n' ' ')
say "drift: $drift"

# 2. Regenerate and apply without a restart.
if ! python3 "$WIRE" --write-prewarm "${args[@]}" >>"$LOG" 2>&1; then
  say "FAILED to regenerate $LIST"
  write_status false "$(count_greetings)" "$drift" false "could not regenerate the prewarm list"
  exit 1
fi
if ! cp -f "$LIST" "$SHIM_VOLUME/tts-shim/prewarm.txt"; then
  say "FAILED to install the new list into $SHIM_VOLUME/tts-shim/prewarm.txt"
  write_status false "$(count_greetings)" "$drift" false "could not install the list into the shim volume"
  exit 1
fi
code=$(docker exec "$SHIM" python -c "
import urllib.request
r = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8880/prewarm', method='POST'), timeout=300)
print(r.status)" 2>&1)
case "$code" in
  200) say "re-prewarmed the shim (POST /prewarm 200)"
       write_status true "$(count_greetings)" "$drift" true - ;;
  *)   say "FAILED to re-prewarm the shim: $code"
       write_status false "$(count_greetings)" "$drift" false "POST /prewarm failed: $code"
       exit 1 ;;
esac
exit 0
