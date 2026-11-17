#!/usr/bin/env bash
# Re-apply the estate's host tools, which otherwise live only under /usr/local,
# /etc/systemd/system and /etc, and are lost when a host is rebuilt.
#
#   ./install.sh --check    # syntax + the plan + drift against the last install
#   ./install.sh --verify   # drift only, exit 1 if a managed file is not what it should be
#   ./install.sh            # install, record a manifest, enable the declared timers,
#                           # disable the ones this host no longer declares, run one pass each
#
# Layout, and how it is applied:
#
#   sbin/<tool>                     every host gets this
#   systemd/<unit>                  every host gets this
#   systemd/<unit>.d/*.conf         drop-in for that unit, every host
#   hosts/<host>/sbin/<tool>        overrides the shared copy on that host only
#   hosts/<host>/systemd/...        units and drop-ins for that host only
#   hosts/<host>/timers             the timers that host runs, and only those
#   hosts/<host>/pins               "this host deliberately runs a divergent copy":
#                                   tool + the md5 of sbin/<tool> when it was reviewed
#   etc/incus-rebalance.json        installed only where the allocator runs
#   retired/timers                  timers the estate has retired; disabled on sight
#
# Idempotent. The policy file is never overwritten: a rebuilt host needs one, but a
# live host's re-keyed policy must not be replaced by the copy in this directory.
# Drift between the two is reported instead.
#
# The manifest is what makes host-local edits visible. Versioning a tool stops it
# being lost; it does nothing about a host where somebody edited the installed copy
# during an incident, which is exactly how i1 came to run two tools that differed
# from i4's for weeks. Every install records md5 + path + time in
# /var/lib/estate-host-tools/manifest.tsv, and --verify compares three things: what
# the host has, what the manifest says was installed, and what the repo holds now.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
host=$(hostname -s 2>/dev/null || hostname)
sbin_dir=/usr/local/sbin
bin_dir=/usr/local/bin
unit_dir=/etc/systemd/system
state_dir=/var/lib/estate-host-tools
manifest=$state_dir/manifest.tsv

mode=install
case "${1:-}" in
  --check) mode=check ;;
  --verify) mode=verify ;;
  "") ;;
  *) echo "usage: $0 [--check|--verify]" >&2; exit 2 ;;
esac

target_for() {   # $1 = script basename; the guard's unit execs from bin
  case "$1" in
    cpk-limits-guard.sh) echo "$bin_dir/$1" ;;
    *) echo "$sbin_dir/$1" ;;
  esac
}

declared_timers() {   # which timers this host is supposed to run
  [ -f "$here/hosts/$host/timers" ] && grep -vE '^[[:space:]]*(#|$)' "$here/hosts/$host/timers"
}

runs_rebalance=0
if declared_timers 2>/dev/null | grep -qx 'incus-rebalance\.timer'; then
  runs_rebalance=1
fi

# target <TAB> source <TAB> mode, shared first then this host's overrides on top.
# Overrides come later on purpose: the map below keeps the last one for a target.
pairs() {
  local f name
  if [ -d "$here/sbin" ]; then
    find "$here/sbin" -maxdepth 1 -type f 2>/dev/null | sort | while IFS= read -r f; do
      name=$(basename "$f"); printf '%s\t%s\t0755\n' "$(target_for "$name")" "$f"
    done
  fi
  if [ -d "$here/hosts/$host/sbin" ]; then
    find "$here/hosts/$host/sbin" -maxdepth 1 -type f 2>/dev/null | sort | while IFS= read -r f; do
      name=$(basename "$f"); printf '%s\t%s\t0755\n' "$(target_for "$name")" "$f"
    done
  fi
  find "$here/systemd" -maxdepth 1 -type f \( -name '*.service' -o -name '*.timer' \) 2>/dev/null | sort | while IFS= read -r f; do
    printf '%s\t%s\t0644\n' "$unit_dir/$(basename "$f")" "$f"
  done
  if [ -d "$here/hosts/$host/systemd" ]; then
    find "$here/hosts/$host/systemd" -maxdepth 1 -type f \( -name '*.service' -o -name '*.timer' \) | sort | while IFS= read -r f; do
      printf '%s\t%s\t0644\n' "$unit_dir/$(basename "$f")" "$f"
    done
  fi
  find "$here/systemd" -mindepth 2 -maxdepth 2 -name '*.conf' 2>/dev/null | sort | while IFS= read -r f; do
    printf '%s\t%s\t0644\n' "$unit_dir/$(basename "$(dirname "$f")")/$(basename "$f")" "$f"
  done
  if [ -d "$here/hosts/$host/systemd" ]; then
    find "$here/hosts/$host/systemd" -mindepth 2 -maxdepth 2 -name '*.conf' | sort | while IFS= read -r f; do
      printf '%s\t%s\t0644\n' "$unit_dir/$(basename "$(dirname "$f")")/$(basename "$f")" "$f"
    done
  fi
  # etc/ is ordinary managed config, except the allocator's policy, which is handled
  # separately because a live host's re-keyed copy must never be replaced.
  if [ -d "$here/etc" ]; then
    find "$here/etc" -maxdepth 1 -type f ! -name 'incus-rebalance.json' 2>/dev/null | sort | while IFS= read -r f; do
      printf '/etc/%s\t%s\t0644\n' "$(basename "$f")" "$f"
    done
  fi
  if [ -d "$here/hosts/$host/etc" ]; then
    find "$here/hosts/$host/etc" -maxdepth 1 -type f 2>/dev/null | sort | while IFS= read -r f; do
      printf '/etc/%s\t%s\t0644\n' "$(basename "$f")" "$f"
    done
  fi
}

managed() {   # one line per target, the effective source, mode
  pairs | awk -F'\t' '{src[$1]=$2; md[$1]=$3} END{for (t in src) printf "%s\t%s\t%s\n", t, src[t], md[t]}' | sort
}

expected_md5() {   # target -> md5 of the file the repo would install there
  local t s m
  while IFS=$'\t' read -r t s _; do printf '%s\t%s\n' "$t" "$(md5sum "$s" | cut -d' ' -f1)"; done < <(managed)
}

repo_timers() {
  local d
  for d in "$here/systemd" "$here/hosts/$host/systemd"; do
    [ -d "$d" ] && find "$d" -maxdepth 1 -name '*.timer' 2>/dev/null | sort | xargs -r -n1 basename
  done | sort -u
}

retired_timers() {
  [ -f "$here/retired/timers" ] && grep -vE '^[[:space:]]*(#|$)' "$here/retired/timers" | awk '{print $1}'
}

drift() {
  local problems=0 t s m at cur want
  declare -A expected=()
  while IFS=$'\t' read -r t want; do expected[$t]=$want; done < <(expected_md5)

  echo "== manifest ($manifest)"
  if [ ! -r "$manifest" ]; then
    echo "  none yet; the first ./install.sh writes it"
  else
    while IFS=$'\t' read -r cur t at; do
      [ -n "${cur:-}" ] || continue
      if [ ! -e "$t" ]; then
        echo "  MISSING  $t (recorded $(date -d "@$at" '+%Y-%m-%d %H:%M' 2>/dev/null))"
        problems=$((problems + 1)); continue
      fi
      if [ "$(md5sum "$t" | cut -d' ' -f1)" != "$cur" ]; then
        echo "  EDITED   $t (changed on this host since it was installed)"
        problems=$((problems + 1))
      fi
      if [ -z "${expected[$t]:-}" ]; then
        echo "  ORPHAN   $t (installed once, no longer in the repo)"
        problems=$((problems + 1))
      elif [ "${expected[$t]}" != "$cur" ]; then
        echo "  PENDING  $t (the repo has moved; ./install.sh would update it)"
        problems=$((problems + 1))
      fi
    done <"$manifest"
    while IFS=$'\t' read -r t _; do
      cut -f2 "$manifest" | grep -qxF "$t" || {
        echo "  NEW      $t (in the repo, never installed here)"
        problems=$((problems + 1))
      }
    done < <(expected_md5)
  fi

  echo "== pins for $host"
  if [ -f "$here/hosts/$host/pins" ]; then
    local tool pin
    while read -r tool pin _; do
      case "${tool:-}" in ''|\#*) continue ;; esac
      if [ ! -f "$here/sbin/$tool" ]; then
        echo "  BAD PIN  $tool (hosts/$host/pins names a tool the repo does not have)"
        problems=$((problems + 1)); continue
      fi
      if [ "$(md5sum "$here/sbin/$tool" | cut -d' ' -f1)" != "$pin" ]; then
        echo "  STALE    $tool (sbin/$tool moved since this host's override was reviewed"
        echo "           - read both, then update hosts/$host/pins)"
        problems=$((problems + 1))
      fi
    done <"$here/hosts/$host/pins"
  else
    echo "  no hosts/$host/pins: this host runs the shared copies"
  fi
  return "$problems"
}

echo "== host: $host"
echo "== syntax"
while IFS=$'\t' read -r t s m; do
  name=$(basename "$s")
  case "$name" in
    incus-rebalance) python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$s" && echo "  $name ok (python)" ;;
    *.service|*.timer|*.conf) ;;
    *) bash -n "$s" && echo "  $name ok" ;;
  esac
done < <(managed)

echo "== plan"
while IFS=$'\t' read -r t s m; do printf '  %-36s -> %s\n' "$(basename "$s")" "$t"; done < <(managed)
if [ "$runs_rebalance" -eq 0 ]; then
  echo "  incus-rebalance.json                 skipped; this host declares no incus-rebalance.timer"
elif [ -e /etc/incus-rebalance.json ]; then
  echo "  incus-rebalance.json                 present; left untouched (drift reported below)"
else
  echo "  incus-rebalance.json                 -> /etc/incus-rebalance.json"
fi

if [ -f "$here/hosts/$host/timers" ]; then
  echo "== timers for $host"
  declared_timers | sed 's/^/  /'
else
  echo "== timers for $host: none declared (hosts/$host/timers missing)"
fi
if retired_timers | grep -q .; then
  echo "== retired (disabled on sight)"
  retired_timers | sed 's/^/  /'
fi

drift || true

if [ "$mode" = verify ]; then
  if drift >/dev/null; then
    echo "verify: clean"
    exit 0
  fi
  echo "verify: drift found (see above)"
  exit 1
fi
if [ "$mode" = check ]; then
  echo "check only; nothing installed"
  exit 0
fi

echo "== install"
while IFS=$'\t' read -r t s m; do install -D -m "$m" "$s" "$t"; done < <(managed)

if [ "$runs_rebalance" -eq 0 ]; then
  # A host that does not run the allocator has no use for its policy, and a
  # stale policy sitting in /etc is exactly what a later reader would trust.
  if [ -e /etc/incus-rebalance.json ]; then
    echo "  note: /etc/incus-rebalance.json exists, but $host declares no"
    echo "        incus-rebalance.timer; left untouched"
  else
    echo "  policy not installed: $host runs no incus-rebalance.timer"
  fi
elif [ -e /etc/incus-rebalance.json ]; then
  if ! diff -q "$here/etc/incus-rebalance.json" /etc/incus-rebalance.json >/dev/null 2>&1; then
    echo "  note: /etc/incus-rebalance.json differs from the copy here; not overwriting"
  fi
else
  install -m 0644 "$here/etc/incus-rebalance.json" /etc/incus-rebalance.json
  mkdir -p /var/lib/incus-rebalance
  echo "  policy installed"
fi

echo "== manifest"
mkdir -p "$state_dir"
tmp=$(mktemp "$state_dir/.manifest.XXXXXX")
while IFS=$'\t' read -r t want; do
  printf '%s\t%s\t%s\n' "$want" "$t" "$(date +%s)" >>"$tmp"
done < <(expected_md5)
sort -t$'\t' -k2 "$tmp" -o "$tmp" && mv "$tmp" "$manifest"
echo "  $(wc -l <"$manifest") file(s) recorded in $manifest"

systemctl daemon-reload
echo "== timers"
while IFS= read -r timer; do
  [ -n "$timer" ] || continue
  if declared_timers 2>/dev/null | grep -qx "$timer"; then
    [ -e "$unit_dir/$timer" ] && systemctl enable --now "$timer"
  elif systemctl is-enabled --quiet "$timer" 2>/dev/null; then
    systemctl disable --now "$timer"
    echo "  disabled $timer: installed here, but no longer declared for $host"
  fi
done < <(repo_timers)
while IFS= read -r timer; do
  [ -n "$timer" ] || continue
  if systemctl is-enabled --quiet "$timer" 2>/dev/null || systemctl is-active --quiet "$timer" 2>/dev/null; then
    systemctl disable --now "$timer"
    echo "  retired $timer (retired/timers)"
  fi
done < <(retired_timers)

echo "== one pass each"
if declared_timers >/dev/null 2>&1; then
  while read -r timer; do
    svc="${timer%.timer}.service"
    [ -n "$timer" ] && [ -e "$unit_dir/$svc" ] && { systemctl start "$svc" || true; }
  done < <(declared_timers)
fi

echo "== result"
if declared_timers >/dev/null 2>&1; then
  while read -r timer; do
    [ -n "$timer" ] && [ -e "$unit_dir/$timer" ] && printf '  %-30s %s\n' "$timer" "$(systemctl is-enabled "$timer")"
  done < <(declared_timers)
fi
journalctl -u incus-rebalance --since -2min --no-pager 2>/dev/null | tail -2
