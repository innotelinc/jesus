#!/bin/sh
# Refuse a deploy that would run on an empty copy of a stateful volume.
#
# Coolify can render a service's volume names in two shapes — `<uuid>_<name>`
# and `<uuid>_<uuid>-<name>` — and a re-render that flips the shape brings the
# stack up on the empty twin: every container healthy, the database gone.
# Recovering costs a stop-copy-start of each volume, so this runs as the first
# step of capstone-init (which the other services gate on) and fails the deploy
# before anything is recreated.
#
# Usage: volume_preflight.sh [volumes-root]        (read-only; never writes)
# Exit:  0 nothing to do / every live twin has data
#        1 a live twin is empty next to a populated sibling
#
# Written for BusyBox sh: the init container is alpine/git, which has no python.
set -eu

ROOT="${1:-/var/lib/docker/volumes}"
# Below this the comparison is noise (docker's own metadata directories).
MIN_KB=${MIN_KB:-1024}
# Volumes whose size says nothing about state: rotated logs, and the git
# checkout (a --depth 1 clone is legitimately smaller than a full one).
is_churn() {
  case "$1" in
    *-logs|*-repo) return 0 ;;
    *) return 1 ;;
  esac
}
is_soft() {
  case "$1" in
    *-spool) return 0 ;;
    *) return 1 ;;
  esac
}

[ -d "$ROOT" ] || { echo "volume-preflight: $ROOT is not mounted — nothing checked" >&2; exit 0; }

status=0
checked=0
for uuid in $(ls "$ROOT" | sed -n 's/^\([0-9a-zA-Z]\{8,40\}\)_\1-.*/\1/p' | sort -u); do
  [ -n "$uuid" ] || continue
  for dir in "$ROOT/${uuid}_"*; do
    [ -d "$dir" ] || continue
    base=${dir##*/}
    base=${base#"${uuid}_"}
    # the dash twin itself, and anything else not an old-shape name
    case "$base" in "$uuid"-*) continue ;; esac
    live="$ROOT/${uuid}_${uuid}-${base}"
    [ -d "$live/_data" ] || continue
    is_churn "$base" && continue
    old_kb=$(du -sk "$ROOT/${uuid}_${base}/_data" 2>/dev/null | cut -f1)
    live_kb=$(du -sk "$live/_data" 2>/dev/null | cut -f1)
    [ -n "$old_kb" ] && [ -n "$live_kb" ] || continue
    [ "$old_kb" -ge "$MIN_KB" ] || continue
    checked=$((checked + 1))
    # below half the sibling: the live copy is not the populated one
    if [ "$live_kb" -lt $((old_kb / 2)) ]; then
      if is_soft "$base"; then
        echo "volume-preflight: warn: $base live ${live_kb}K vs sibling ${old_kb}K (soft)" >&2
      else
        echo "volume-preflight: REFUSING: live volume $base is ${live_kb}K next to a ${old_kb}K sibling — this deploy would run on the empty twin of ${uuid}. Restore it first: docs/operations.md → Repairing a stateful volume from its twin" >&2
        status=1
      fi
    fi
  done
done

echo "volume-preflight: ${checked} volume pair(s) checked under ${ROOT}"
exit "$status"
