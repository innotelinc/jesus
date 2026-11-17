#!/usr/bin/env bash
# Re-apply the estate's host tools, which otherwise live only under /usr/local,
# /etc/systemd/system and /etc, and are lost when a host is rebuilt.
#
#   ./install.sh --check    # syntax + the plan; writes nothing
#   ./install.sh            # install, enable the timers, run one pass of each
#
# Layout, and how it is applied:
#
#   sbin/<tool>                     every host gets this
#   systemd/<unit>                  every host gets this
#   systemd/<unit>.d/*.conf         drop-in for that unit, every host
#   hosts/<host>/sbin/<tool>        overrides the shared copy on that host only
#   hosts/<host>/systemd/...        units and drop-ins for that host only
#   etc/incus-rebalance.json        installed only when the host has no policy
#
# Idempotent. The policy file is never overwritten: a rebuilt host needs one, but
# a live host's re-keyed policy must not be replaced by the copy in this
# directory. Drift between the two is reported instead.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
host=$(hostname -s 2>/dev/null || hostname)
sbin_dir=/usr/local/sbin
bin_dir=/usr/local/bin
unit_dir=/etc/systemd/system

check_only=0
case "${1:-}" in
  --check) check_only=1 ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

target_for() {   # $1 = script basename; the guard's unit execs from bin
  case "$1" in
    cpk-limits-guard.sh) echo "$bin_dir/$1" ;;
    *) echo "$sbin_dir/$1" ;;
  esac
}

scripts() {   # shared first, then this host's overrides on top
  { find "$here/sbin" -maxdepth 1 -type f 2>/dev/null | sort || true; }
  { [ -d "$here/hosts/$host/sbin" ] && find "$here/hosts/$host/sbin" -maxdepth 1 -type f | sort; } || true
}

units() {
  { find "$here/systemd" -maxdepth 1 -type f \( -name '*.service' -o -name '*.timer' \) 2>/dev/null | sort || true; }
  { [ -d "$here/hosts/$host/systemd" ] && find "$here/hosts/$host/systemd" -maxdepth 1 -type f \( -name '*.service' -o -name '*.timer' \) | sort; } || true
}

dropins() {
  { find "$here/systemd" -mindepth 2 -maxdepth 2 -name '*.conf' 2>/dev/null | sort || true; }
  { [ -d "$here/hosts/$host/systemd" ] && find "$here/hosts/$host/systemd" -mindepth 2 -maxdepth 2 -name '*.conf' | sort; } || true
}

declared_timers() {   # which timers this host is supposed to run
  [ -f "$here/hosts/$host/timers" ] && grep -vE '^[[:space:]]*(#|$)' "$here/hosts/$host/timers"
}

runs_rebalance=0
if declared_timers 2>/dev/null | grep -qx 'incus-rebalance\.timer'; then
  runs_rebalance=1
fi

echo "== host: $host"
echo "== syntax"
for script in $(scripts); do
  name=$(basename "$script")
  case "$name" in
    incus-rebalance) python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$script" && echo "  $name ok (python)" ;;
    *) bash -n "$script" && echo "  $name ok" ;;
  esac
done

echo "== plan"
for script in $(scripts); do
  printf "  %-24s -> %s\n" "$(basename "$script")" "$(target_for "$(basename "$script")")"
done
for unit in $(units); do
  printf "  %-24s -> %s\n" "$(basename "$unit")" "$unit_dir/$(basename "$unit")"
done
for conf in $(dropins); do
  unit=$(basename "$(dirname "$conf")")
  printf "  %-24s -> %s\n" "$(basename "$conf")" "$unit_dir/$unit/$(basename "$conf")"
done
if [ "$runs_rebalance" -eq 0 ]; then
  echo "  incus-rebalance.json        skipped; this host declares no incus-rebalance.timer"
elif [ -e /etc/incus-rebalance.json ]; then
  echo "  incus-rebalance.json        present; left untouched (drift reported below)"
else
  echo "  incus-rebalance.json        -> /etc/incus-rebalance.json"
fi

if [ -f "$here/hosts/$host/timers" ]; then
  echo "== timers for $host"
  grep -vE '^[[:space:]]*(#|$)' "$here/hosts/$host/timers" | sed 's/^/  /'
else
  echo "== timers for $host: none declared (hosts/$host/timers missing)"
fi

if [ "$check_only" -eq 1 ]; then
  echo "check only; nothing installed"
  exit 0
fi

echo "== install"
for script in $(scripts); do
  name=$(basename "$script")
  install -m 0755 "$script" "$(target_for "$name")"
done
for unit in $(units); do
  install -m 0644 "$unit" "$unit_dir/$(basename "$unit")"
done
for conf in $(dropins); do
  unit=$(basename "$(dirname "$conf")")
  install -D -m 0644 "$conf" "$unit_dir/$unit/$(basename "$conf")"
done

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

systemctl daemon-reload
if declared_timers >/dev/null 2>&1; then
  while read -r timer; do
    [ -n "$timer" ] || continue
    if [ -e "$unit_dir/$timer" ]; then systemctl enable --now "$timer"; fi
  done < <(declared_timers)
else
  echo "  note: no hosts/$host/timers; enabling no timers."
  echo "        Add one listing the timers this host runs - a host must not"
  echo "        start a tool it has no remotes or data for."
fi

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
    [ -n "$timer" ] && [ -e "$unit_dir/$timer" ] && systemctl is-enabled "$timer"
  done < <(declared_timers)
fi
journalctl -u incus-rebalance --since -2min --no-pager 2>/dev/null | tail -2
