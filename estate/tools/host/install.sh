#!/usr/bin/env bash
# Re-apply a host tool that lives only under /usr/local and /etc/systemd/system,
# and would otherwise be lost when the host is rebuilt.
#
#   sudo ./install.sh            # install, enable the timer, run one pass
#   sudo ./install.sh --check    # syntax and dry behaviour only, /etc untouched
#
# The script is idempotent: re-running it replaces the files and restarts
# nothing that is already running.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bin=/usr/local/bin
unit=/etc/systemd/system

check_only=0
case "${1:-}" in
  --check) check_only=1 ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

echo "== syntax"
bash -n "$here/cpk-limits-guard.sh" && echo "  cpk-limits-guard.sh ok"

if [ "$check_only" -eq 1 ]; then
  echo "== dry behaviour (instance is expected to be absent)"
  CPK_REMOTE="${CPK_REMOTE:-i2}" bash "$here/cpk-limits-guard.sh" || true
  echo "check only; nothing installed"
  exit 0
fi

echo "== install"
install -m 0755 "$here/cpk-limits-guard.sh" "$bin/cpk-limits-guard.sh"
install -m 0644 "$here/cpk-limits-guard.service" "$unit/cpk-limits-guard.service"
install -m 0644 "$here/cpk-limits-guard.timer" "$unit/cpk-limits-guard.timer"
systemctl daemon-reload
systemctl enable --now cpk-limits-guard.timer
systemctl start cpk-limits-guard.service || true

echo "== result"
systemctl is-enabled cpk-limits-guard.timer
systemctl is-failed cpk-limits-guard.service || echo "  service not failed"
journalctl -u cpk-limits-guard --since -2min --no-pager | tail -3
