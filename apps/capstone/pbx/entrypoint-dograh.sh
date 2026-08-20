#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# dograh-ARI bootstrap for the Innotel FreePBX fullstack image.
#
# Injects the dograh ARI wiring into /etc/asterisk BEFORE the stock entrypoint
# (entrypoint.sh) starts, so the config is in place for the first boot and
# re-applied (idempotently) on every restart:
#
#   ari.conf                ARI user [dograh] (Stasis app name = "dograh")
#   http.conf               Asterisk HTTP on 8088 (only if the image lacks one)
#   websocket_client.conf   external media WS -> dograh-api (host mode :8000)
#   extensions_custom.conf  [dograh-inbound] dialplan context -> Stasis(dograh)
#
# /etc/asterisk is the named volume pbx-asterisk-config; FreePBX manages its
# own files there (extensions.conf, http_additional.conf, ...) and does NOT
# regenerate the four files above, so the injection survives Apply Config.
#
# Env overrides (from the compose .env):
#   DOGRAH_ARI_PASSWORD  strong password for the ARI user (sed'd into ari.conf)
#   DOGRAH_WS_URI        media WebSocket URI (default ws://host.docker.internal:8000/...)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SRC="/opt/pbx-dograh"
DEST="/etc/asterisk"

echo ">>> [dograh-ari] injecting dograh ARI config into ${DEST}"

# ── ari.conf (always install) ──────────────────────────────────────────────
if [ -f "${SRC}/ari.conf" ]; then
  cp -f "${SRC}/ari.conf" "${DEST}/ari.conf"
  if [ -n "${DOGRAH_ARI_PASSWORD:-}" ]; then
    sed -i "s/^password = .*/password = ${DOGRAH_ARI_PASSWORD}/" "${DEST}/ari.conf"
    echo ">>> [dograh-ari] ari.conf password set from DOGRAH_ARI_PASSWORD"
  else
    echo ">>> [dograh-ari] WARNING: DOGRAH_ARI_PASSWORD unset — ari.conf keeps CHANGE_ME_ARI_PASSWORD"
  fi
fi

# ── http.conf (only if the image doesn't ship one — FreePBX manages HTTP) ──
if [ -f "${SRC}/http.conf" ] && [ ! -f "${DEST}/http.conf" ]; then
  cp -f "${SRC}/http.conf" "${DEST}/http.conf"
  echo ">>> [dograh-ari] installed http.conf (was missing)"
fi

# ── websocket_client.conf (always install; URI overridable) ────────────────
if [ -f "${SRC}/websocket_client.conf" ]; then
  cp -f "${SRC}/websocket_client.conf" "${DEST}/websocket_client.conf"
  if [ -n "${DOGRAH_WS_URI:-}" ]; then
    sed -i "s|^uri = .*|uri = ${DOGRAH_WS_URI}|" "${DEST}/websocket_client.conf"
    echo ">>> [dograh-ari] websocket_client.conf uri set from DOGRAH_WS_URI"
  fi
fi

# ── extensions_custom.conf (append idempotently, preserves existing content) ──
if [ -f "${SRC}/extensions_custom.conf" ]; then
  touch "${DEST}/extensions_custom.conf"
  if ! grep -q '\[dograh-inbound\]' "${DEST}/extensions_custom.conf" 2>/dev/null; then
    cat "${SRC}/extensions_custom.conf" >> "${DEST}/extensions_custom.conf"
    echo ">>> [dograh-ari] appended [dograh-inbound] context to extensions_custom.conf"
  else
    echo ">>> [dograh-ari] extensions_custom.conf already has [dograh-inbound]"
  fi
fi

# Asterisk reads configs as the asterisk user — match the image's ownership.
chown -R asterisk:asterisk \
  "${DEST}/ari.conf" \
  "${DEST}/websocket_client.conf" \
  "${DEST}/extensions_custom.conf" 2>/dev/null || true
[ -f "${DEST}/http.conf" ] && chown asterisk:asterisk "${DEST}/http.conf" 2>/dev/null || true

echo ">>> [dograh-ari] done — exec'ing stock entrypoint"
exec /usr/local/bin/entrypoint.sh "$@"
