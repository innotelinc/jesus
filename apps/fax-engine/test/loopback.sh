#!/bin/sh
# Prove the fax machine works without a carrier: send one page from one modem to
# the other and check it arrived in recvq as a real fax TIFF.
#
# This is the whole path — HylaFAX renders and queues, faxsend drives the tty,
# iaxmodem modulates over IAX2, Asterisk hands the call to the sibling modem,
# faxgetty answers, and the page lands in recvq. If any link is broken this
# fails with the reason instead of reporting a healthy container.
set -eu

SPOOL=${FAX_SPOOL:-/var/spool/hylafax}
TO=${1:-9999}
WAIT=${2:-150}

# A marker newer than the file we are waiting for: recvq gains a zero-length
# placeholder the moment the call is answered, so counting files is not enough —
# the page is only there once faxinfo can read it.
marker=/tmp/fax-selftest-$$.stamp
touch "$marker"
trap 'rm -f "$marker"' EXIT
stamp=$(date +%s)
page=/tmp/fax-selftest-$$.ps
tiff=/tmp/fax-selftest-$$.tif

cat > "$page" <<'PS'
%!PS-Adobe-3.0
/Helvetica-Bold findfont 22 scalefont setfont
72 700 moveto (TELNO FAX ENGINE) show
/Helvetica findfont 13 scalefont setfont
72 670 moveto (Self-test page: one page, sent through an IAX2 modem pair.) show
72 650 moveto (If this page arrived, the modem path works end to end.) show
showpage
PS

# A fax TIFF, not a picture: 204x196 dpi, G3, which is what a Class 1 modem
# transmits. faxsend rejects anything that does not look like a fax page.
gs -q -dNOPAUSE -dBATCH -sDEVICE=tiffg3 -r204x196 -sOutputFile="$tiff" "$page"
rm -f "$page"

echo "[self-test] sending one page to $TO"
sendfax -n -d "$TO" "$tiff"
rm -f "$tiff"

waited=0
while [ "$waited" -lt "$WAIT" ]; do
  newest=$(find "$SPOOL/recvq" -maxdepth 1 -name 'fax*.tif*' -newer "$marker" 2>/dev/null | head -1)
  if [ -n "$newest" ]; then
    pages=$(faxinfo "$newest" 2>/dev/null | awk -F: '/^[ \t]*Pages/{gsub(/[ \t]/,"",$2);print $2}')
    if [ -n "$pages" ] && [ "$pages" -ge 1 ]; then
      echo "[self-test] received $(basename "$newest") · ${pages} page(s) · $(( $(date +%s) - stamp ))s"
      echo "[self-test] PASS: a page went out of one modem and arrived at the other"
      exit 0
    fi
    # Still being written, or not a fax yet: keep waiting rather than call a
    # half-written page a failure.
  fi
  sleep 3
  waited=$((waited + 3))
  if [ $((waited % 30)) -eq 0 ]; then
    echo "[self-test] ${waited}s … faxstat:" >&2
    faxstat -s 2>&1 | sed 's/^/[self-test]   /' >&2 || true
    tail -n 20 "$SPOOL/log/xferfaxlog" 2>/dev/null | sed 's/^/[self-test]   /' >&2 || true
  fi
done

echo "[self-test] FAIL: nothing arrived in recvq within ${WAIT}s" >&2
faxstat -s 2>&1 | sed 's/^/[self-test]   /' >&2 || true
exit 1
