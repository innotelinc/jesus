#!/bin/sh
# Render this container's configuration from the environment, then start it.
#
# Everything device-specific is rendered here rather than baked into the image,
# because the same image has to be a loopback test rig (no carrier) and a real
# fax machine on a fax DID. The only thing that changes is the environment.
set -eu

FAX_SECRET=${FAX_SECRET:-telno-fax-local}
FAX_NUMBER=${FAX_NUMBER:-14132642700}
FAX_STATION_ID=${FAX_STATION_ID:-Telno}
FAX_ENGINE_TOKEN=${FAX_ENGINE_TOKEN:-}
FAX_ENGINE_PORT=${FAX_ENGINE_PORT:-8080}
FAX_SIP_USER=${FAX_SIP_USER:-}
FAX_SIP_SECRET=${FAX_SIP_SECRET:-}
FAX_SIP_HOST=${FAX_SIP_HOST:-newyork1.voip.ms}
FAX_SIP_PORT=${FAX_SIP_PORT:-5060}
FAX_SIP_BIND_PORT=${FAX_SIP_BIND_PORT:-5060}
PUBLIC_IP=${PUBLIC_IP:-}
SPOOL=/var/spool/hylafax

log() { echo "[fax] $*"; }

# 1. The spool. A named volume mounted over the spool is empty on first boot,
#    and an empty spool means faxsetup would have to run again — interactively.
#    The image carries a finished one, so first boot is a copy, not a setup.
if [ ! -f "$SPOOL/etc/setup.cache" ]; then
  log "seeding the HylaFAX spool from the image"
  mkdir -p "$SPOOL"
  cp -a /opt/fax/spool-seed/. "$SPOOL"/
fi
mkdir -p "$SPOOL/recvq" "$SPOOL/sendq" "$SPOOL/doneq" "$SPOOL/docq" \
         "$SPOOL/archive" "$SPOOL/log" "$SPOOL/tmp" "$SPOOL/status"

# 2. One HylaFAX config and one iaxmodem config per modem.
index=0
while [ "$index" -lt 2 ]; do
  device="ttyIAX$index"
  port=$((4570 + index))
  sed -e "s|__NUMBER__|$FAX_NUMBER|g" \
      -e "s|__STATION__|$FAX_STATION_ID|g" \
      -e "s|__DEVICE__|$device|g" \
      /opt/fax/config.ttyIAX > "$SPOOL/etc/config.$device"
  sed -e "s|__DEVICE__|/dev/$device|g" \
      -e "s|__PORT__|$port|g" \
      -e "s|__PEER__|iax$index|g" \
      -e "s|__SECRET__|$FAX_SECRET|g" \
      -e "s|__STATION__|$FAX_STATION_ID|g" \
      -e "s|__NUMBER__|$FAX_NUMBER|g" \
      /etc/iaxmodem/iaxmodem.conf.ttyIAX > "/etc/iaxmodem/$device.conf"
  index=$((index + 1))
done

# 3. Asterisk: the IAX2 switchboard, and the SIP door when a carrier is set.
sed -e "s|__FAX_SECRET__|$FAX_SECRET|g" \
    -e "s|__FAX_NUMBER__|$FAX_NUMBER|g" \
    /etc/asterisk/iax.conf.tmpl > /etc/asterisk/iax.conf
sed -e "s|__FAX_NUMBER__|$FAX_NUMBER|g" \
    /etc/asterisk/extensions.conf.tmpl > /etc/asterisk/extensions.conf

if [ -n "$PUBLIC_IP" ]; then
  external="external_media_address=$PUBLIC_IP
external_signaling_address=$PUBLIC_IP"
else
  external="; no PUBLIC_IP given: the carrier sees the container's own address"
fi
sed -e "s|__SIP_BIND_PORT__|$FAX_SIP_BIND_PORT|g" \
    -e "s|; __SIP_EXTERNAL_LINES__|$external|" \
    /etc/asterisk/pjsip.conf.tmpl > /etc/asterisk/pjsip.conf

if [ -n "$FAX_SIP_USER" ] && [ -n "$FAX_SIP_SECRET" ]; then
  log "carrier trunk enabled for $FAX_SIP_USER@$FAX_SIP_HOST"
  sed -e "s|__SIP_USER__|$FAX_SIP_USER|g" \
      -e "s|__SIP_SECRET__|$FAX_SIP_SECRET|g" \
      -e "s|__SIP_HOST__|$FAX_SIP_HOST|g" \
      -e "s|__SIP_PORT__|$FAX_SIP_PORT|g" \
      /etc/asterisk/pjsip-carrier.conf.tmpl >> /etc/asterisk/pjsip.conf
else
  log "no carrier credentials: loopback only (the self-test path)"
fi

# 4. Ownership. HylaFAX runs as uucp, the modems are owned by uucp, and
#    Asterisk needs its own runtime and log directories.
chown -R uucp:uucp "$SPOOL"
mkdir -p /var/run/asterisk /var/log/asterisk
chown -R asterisk:asterisk /var/run/asterisk /var/log/asterisk

export FAX_ENGINE_TOKEN FAX_ENGINE_PORT FAX_NUMBER FAX_STATION_ID
log "station $FAX_STATION_ID · number $FAX_NUMBER · status on :$FAX_ENGINE_PORT"
exec supervisord -n -c /etc/supervisor/supervisord.conf
