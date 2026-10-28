#!/usr/bin/env bash
# Provision a Motorola (or any) Android phone as a Capstone SMS node.
#
# Run this ON THE PHONE, inside Termux, from the repo checkout:
#
#     bash phone-node/install-termux.sh
#
# It installs the Termux-side dependencies, generates the bearer key, and
# drops a Termux:Boot script so the gateway comes back after a reboot. It needs
# no root and touches nothing outside $HOME and Termux's own $PREFIX.
#
# Two companion apps must be installed from the SAME source as Termux
# (F-Droid or GitHub — not a mix, the signatures must match):
#   * Termux:API   — provides termux-sms-send
#   * Termux:Boot  — runs ~/.termux/boot/* on startup
set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
HOME_DIR="${HOME:-/data/data/com.termux/files/home}"
STATE_DIR="$HOME_DIR/.opensms-bridge"
KEY_FILE="$STATE_DIR/key"
PORT="${OPENSMS_PORT:-9292}"
BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/opensms_termux_bridge.py"
# Optional: the inbound (reply) half. Both must be set, or neither is wired.
FORWARD_URL="${FORWARD_URL:-}"
INBOUND_TOKEN="${CAPSTONE_SMS_INBOUND_TOKEN:-}"

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

if [ ! -d "$PREFIX" ]; then
  warn "this does not look like Termux (no $PREFIX). Run it on the phone, inside Termux."
  exit 1
fi
[ -f "$BRIDGE" ] || { warn "bridge not found at $BRIDGE"; exit 1; }

say "Installing Termux packages (python, termux-api)"
pkg update -y >/dev/null 2>&1 || warn "pkg update failed; continuing with what is installed"
pkg install -y python termux-api >/dev/null || { warn "pkg install python termux-api failed"; exit 1; }

say "Generating the bearer key"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
if [ -s "$KEY_FILE" ]; then
  echo "    keeping the existing key at $KEY_FILE"
else
  python -c "import secrets;print(secrets.token_urlsafe(32))" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "    wrote a new key to $KEY_FILE (mode 600)"
fi

INBOUND_ARG=""
if [ -n "$FORWARD_URL" ] && [ -n "$INBOUND_TOKEN" ]; then
  say "Configuring inbound SMS forwarding"
  printf '%s' "$INBOUND_TOKEN" >"$STATE_DIR/inbound-token"
  chmod 600 "$STATE_DIR/inbound-token"
  INBOUND_ARG="--forward-url $FORWARD_URL --forward-token-file $STATE_DIR/inbound-token"
  echo "    replies -> $FORWARD_URL (token stored in $STATE_DIR/inbound-token)"
elif [ -n "$FORWARD_URL" ] || [ -n "$INBOUND_TOKEN" ]; then
  warn "inbound needs BOTH FORWARD_URL and CAPSTONE_SMS_INBOUND_TOKEN — skipping inbound"
fi

say "Writing the Termux:Boot startup script"
BOOT_DIR="$HOME_DIR/.termux/boot"
mkdir -p "$BOOT_DIR"
BOOT_SCRIPT="$BOOT_DIR/90-opensms-bridge"
cat >"$BOOT_SCRIPT" <<BOOT
#!$PREFIX/bin/sh
# Installed by Capstone phone-node/install-termux.sh — starts the SMS gateway.
# A wake lock keeps the CPU up for ordinary sleep; Android's Doze can still
# ignore it, so exempt Termux from battery optimisation in Android settings.
termux-wake-lock
exec $PREFIX/bin/python $BRIDGE --key-file $KEY_FILE --port $PORT --log-file $STATE_DIR/bridge.log $INBOUND_ARG
BOOT
chmod 700 "$BOOT_SCRIPT"
echo "    $BOOT_SCRIPT"

say "Preflight (binary + SMS permission)"
if ! python "$BRIDGE" --key-file "$KEY_FILE" --check; then
  warn "the gateway is installed but cannot send yet."
  cat >&2 <<'NEXT'
    * Install the Termux:API app (same source as Termux) and launch it once.
    * Grant Termux:API the SMS permission in Android Settings -> Apps.
    * Re-run: python ~/phone-node/opensms_termux_bridge.py --check
NEXT
fi

IP="$(ip -4 addr show 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | grep -v '^127\.' | head -1 || true)"
say "Done"
cat <<SUMMARY

  Gateway:  http://${IP:-<phone-lan-ip>}:$PORT
  Key file: $KEY_FILE   (cat it to copy into .env on the Capstone host)
  Log:      $STATE_DIR/bridge.log

  Start it now (foreground):
      python $BRIDGE --key-file $KEY_FILE --port $PORT

  Start it now (background, survives leaving the terminal):
      nohup python $BRIDGE --key-file $KEY_FILE --port $PORT \\
          --log-file $STATE_DIR/bridge.log >/dev/null 2>&1 &

  Then, on the Capstone host, add to .env:
      SMS_PROVIDER=opensms
      OPENSMS_URL=http://${IP:-<phone-lan-ip>}:$PORT
      OPENSMS_API_KEY=$(cat "$KEY_FILE")
      OPENSMS_TIMEOUT_MS=15000
      CAPSTONE_SMS_INBOUND_TOKEN=<a 32-byte hex secret>

  For replies, re-run with the forward target:
      FORWARD_URL=https://<capstone-host>/api/sms-inbound \\
      CAPSTONE_SMS_INBOUND_TOKEN=<the same secret> \\
        bash phone-node/install-termux.sh

  Verify from the host: python3 scripts/opensms_client.py --check
SUMMARY
