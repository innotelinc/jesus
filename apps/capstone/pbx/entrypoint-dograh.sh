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
#   websocket_client.conf   external media WS -> dograh-api (host mode :3010)
#   extensions_custom.conf  [dograh-inbound] dialplan context -> Stasis(dograh)
#   rtp_custom.conf         cap RTP range to the compose-published 10101-10120
#
# /etc/asterisk is the named volume pbx-asterisk-config; FreePBX manages its
# own files there (extensions.conf, http_additional.conf, ...) and does NOT
# regenerate the four files above, so the injection survives Apply Config.
#
# Env overrides (from the compose .env):
#   DOGRAH_ARI_PASSWORD  strong password for the ARI user (sed'd into ari.conf)
#   DOGRAH_WS_URI        media WebSocket URI (default ws://host.docker.internal:3010/...)
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
# NOTE: the fullstack image ships http.conf → FreePBX's managed file, and its
# boot-time `fwconsole reload` REGENERATES http_additional.conf from the
# freepbx_settings DB. So enabling HTTP at the file level does not survive a
# boot. The durable enable happens post-boot via the settings DB (see the
# background hook at the bottom of this script); this file stays as a base
# fallback for images that ship no http.conf at all.
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

# ── rtp_custom.conf (fallback RTP cap; the kvstore write below is the real
# fix on FreePBX). The compose publishes a configurable RTP range
# (FREEPBX_RTP_PORT_START..END, default 10101-10120). On FreePBX, Asterisk's
# config reader returns the FIRST value it sees for rtpstart/rtpend, so an
# included file can't override the generated rtp_additional.conf — the
# durable fix is the kvstore_Sipsettings write in the settings loop below
# (fwconsole reload regenerates rtp_additional.conf from it). This file stays
# as a fallback for images/versions where last-wins applies, or where
# FreePBX isn't in the picture.
RTP_START="${FREEPBX_RTP_PORT_START:-10101}"
RTP_END="${FREEPBX_RTP_PORT_END:-10120}"
if [ -f "${SRC}/rtp_custom.conf" ]; then
  touch "${DEST}/rtp_custom.conf"
  if ! grep -q "^rtpstart=${RTP_START}" "${DEST}/rtp_custom.conf" 2>/dev/null; then
    printf '[general]\nrtpstart=%s\nrtpend=%s\n' "${RTP_START}" "${RTP_END}" >> "${DEST}/rtp_custom.conf"
    echo ">>> [dograh-ari] rtp_custom.conf: fallback RTP cap ${RTP_START}-${RTP_END} appended"
  fi
fi

# ── extensions_custom.conf (merge idempotently, preserves existing content) ──
# Appends the [dograh-inbound] context if missing; otherwise appends only the
# extensions from the source file that aren't already defined (with their
# `same =>` continuations) — so adding an exten to
# pbx/asterisk/extensions_custom.conf propagates on the next boot without
# duplicating extensions that are already present.
inject_dialplan() {
  local src="$1" dst="$2"
  if ! grep -q '^\[dograh-inbound\]' "${dst}" 2>/dev/null; then
    cat "${src}" >> "${dst}"
    echo ">>> [dograh-ari] appended [dograh-inbound] context to extensions_custom.conf"
    return 0
  fi
  local ext added=0
  for ext in $(sed -n 's/^exten => \([0-9_]*\),.*/\1/p' "${src}"); do
    if grep -qE "^exten => ${ext}," "${dst}"; then
      continue
    fi
    # Emit this exten plus its `same =>` continuations from the source file.
    awk -v e="${ext}" '
      $0 ~ "^exten => " e "," { print; keep=1; next }
      keep && /^ same =>/ { print; next }
      keep { keep=0 }
    ' "${src}" >> "${dst}"
    echo ">>> [dograh-ari] added exten ${ext} to [dograh-inbound]"
    added=1
  done
  [ "${added}" = 0 ] && echo ">>> [dograh-ari] [dograh-inbound] extensions already present"
}
if [ -f "${SRC}/extensions_custom.conf" ]; then
  touch "${DEST}/extensions_custom.conf"
  inject_dialplan "${SRC}/extensions_custom.conf" "${DEST}/extensions_custom.conf"
fi

# Asterisk reads configs as the asterisk user — match the image's ownership.
chown -R asterisk:asterisk \
  "${DEST}/ari.conf" \
  "${DEST}/websocket_client.conf" \
  "${DEST}/extensions_custom.conf" \
  "${DEST}/rtp_custom.conf" 2>/dev/null || true
[ -f "${DEST}/http.conf" ] && chown asterisk:asterisk "${DEST}/http.conf" 2>/dev/null || true

echo ">>> [dograh-ari] configs injected — starting stock entrypoint in background"

# ── Run the stock entrypoint in the background so we can enable Asterisk ──
# HTTP/ARI at the FreePBX settings-DB level AFTER it boots. The entrypoint's
# own `fwconsole reload` regenerates http_additional.conf from the DB, so the
# file-level http.conf above is not enough — HTTPENABLED must be flipped in
# freepbx_settings (idempotent; harmless if already set).
/usr/local/bin/entrypoint.sh "$@" &
ENTRYPOINT_PID=$!

trap 'kill -TERM ${ENTRYPOINT_PID} 2>/dev/null; exit 0' TERM INT

# Wait for MariaDB to accept connections (the entrypoint starts it). Root
# auth works via the unix socket — plain `mysql -u root` (no -h) is correct.
for i in $(seq 1 120); do
  if mysqladmin ping --silent 2>/dev/null; then
    echo ">>> [dograh-ari] MariaDB up (attempt ${i})"
    break
  fi
  sleep 5
done

# Flip HTTP on at the settings level (survives fwconsole reloads). Retry
# until it actually takes effect — on first boot FreePBX may still be
# populating freepbx_settings when MariaDB first answers. Guard everything
# against `set -e` (a failed probe must NOT kill this wrapper).
for i in $(seq 1 24); do
  set +e
  done=$(mysql -u root asterisk -N -B 2>/dev/null \
    -e "UPDATE freepbx_settings SET value='1' WHERE keyword='HTTPENABLED' AND value!='1'; \
        UPDATE freepbx_settings SET value='0.0.0.0' WHERE keyword='HTTPBINDADDRESS' AND value!='0.0.0.0'; \
        INSERT INTO kvstore_Sipsettings (\`key\`, val, type, id) VALUES ('rtpstart','${RTP_START}',NULL,'noid') ON DUPLICATE KEY UPDATE val='${RTP_START}'; \
        INSERT INTO kvstore_Sipsettings (\`key\`, val, type, id) VALUES ('rtpend','${RTP_END}',NULL,'noid') ON DUPLICATE KEY UPDATE val='${RTP_END}'; \
        SELECT COUNT(*) FROM freepbx_settings WHERE keyword='HTTPENABLED' AND value='1';" \
    2>/dev/null | tail -1)
  rc=$?
  set -e
  if [ "${rc}" -eq 0 ] && [ "${done:-0}" = "1" ]; then
    echo ">>> [dograh-ari] HTTPENABLED=1 / HTTPBINDADDRESS=0.0.0.0 written to freepbx_settings"
    # FreePBX may leave a stale generated file after the DB update. Ensure the
    # generated config explicitly enables the HTTP server before reloading.
    HTTP_ADDITIONAL="${DEST}/http_additional.conf"
    if [ -f "${HTTP_ADDITIONAL}" ]; then
      if grep -q '^enabled[[:space:]]*=' "${HTTP_ADDITIONAL}"; then
        sed -i 's/^enabled[[:space:]]*=.*/enabled = yes/' "${HTTP_ADDITIONAL}"
      else
        printf '\n[general]\nenabled = yes\nbindaddr = 0.0.0.0\nbindport = 8088\n' >> "${HTTP_ADDITIONAL}"
      fi
      chown asterisk:asterisk "${HTTP_ADDITIONAL}" 2>/dev/null || true
    fi
    break
  fi
  sleep 5
done

# Wait for the entrypoint's boot reload + web stack to finish (Apache on :80),
# then reload once more so Asterisk picks up the DB change cleanly.
for i in $(seq 1 60); do
  if timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/80' 2>/dev/null; then
    echo ">>> [dograh-ari] web UI up (attempt ${i}) — reloading for ARI"
    fwconsole reload >/tmp/dograh-ari-reload.log 2>&1 || true
    break
  fi
  sleep 5
done

echo ">>> [dograh-ari] bootstrap complete — following stock entrypoint"
wait "${ENTRYPOINT_PID}"
