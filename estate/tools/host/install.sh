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
if [ -e /etc/incus-rebalance.json ]; then
  echo "  incus-rebalance.json        present; left untouched (drift reported below)"
else
  echo "  incus-rebalance.json        -> /etc/incus-rebalance.json"
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

if [ -e /etc/incus-rebalance.json ]; then
  if ! diff -q "$here/etc/incus-rebalance.json" /etc/incus-rebalance.json >/dev/null 2>&1; then
    echo "  note: /etc/incus-rebalance.json differs from the copy here; not overwriting"
  fi
else
  install -m 0644 "$here/etc/incus-rebalance.json" /etc/incus-rebalance.json
  mkdir -p /var/lib/incus-rebalance
  echo "  policy installed"
fi

systemctl daemon-reload
for timer in incus-rebalance.timer swap-ceiling-check.timer cpk-limits-guard.timer; do
  [ -e "$unit_dir/$timer" ] && systemctl enable --now "$timer"
done

echo "== one pass each"
for svc in incus-rebalance.service swap-ceiling-check.service cpk-limits-guard.service; do
  [ -e "$unit_dir/$svc" ] && { systemctl start "$svc" || true; }
done

echo "== result"
for timer in incus-rebalance.timer swap-ceiling-check.timer cpk-limits-guard.timer; do
  [ -e "$unit_dir/$timer" ] && systemctl is-enabled "$timer"
done
journalctl -u incus-rebalance --since -2min --no-pager 2>/dev/null | tail -2
