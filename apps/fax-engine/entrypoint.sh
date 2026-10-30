#!/bin/sh
# Render this container's configuration from the environment, then start it.
#
# Everything device-specific is rendered here rather than baked into the image,
# because the same image has to be a loopback test rig (no carrier) and a real
# fax machine on a fax DID. The only thing that changes is the environment.
set -eu

FAX_SECRET=${FAX_SECRET:-telno-fax-local}
FAX_NUMBER=${FAX_NUMBER:-14132642700}
# One modem can sit on its own line: modem 0 on the first DID, modem 1 on the
# second. Both default to FAX_NUMBER, because a single line is the normal case
# and a two-line engine that says which modem is which is the useful one.
FAX_NUMBER0=${FAX_NUMBER0:-$FAX_NUMBER}
FAX_NUMBER1=${FAX_NUMBER1:-$FAX_NUMBER}
# The fax's own carrier sub-account. An IAX2 identity is the better door for a
# fax — the modem already speaks IAX2 — so it is preferred over SIP when both
# are present.
FAX_IAX_USER=${FAX_IAX_USER:-}
FAX_IAX_SECRET=${FAX_IAX_SECRET:-}
FAX_IAX_HOST=${FAX_IAX_HOST:-newyork1.voip.ms}
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
  if [ "$index" -eq 0 ]; then number=$FAX_NUMBER0; else number=$FAX_NUMBER1; fi
  sed -e "s|__NUMBER__|$number|g" \
      -e "s|__STATION__|$FAX_STATION_ID|g" \
      -e "s|__DEVICE__|$device|g" \
      /opt/fax/config.ttyIAX > "$SPOOL/etc/config.$device"
  sed -e "s|__DEVICE__|/dev/$device|g" \
      -e "s|__PORT__|$port|g" \
      -e "s|__PEER__|iax$index|g" \
      -e "s|__SECRET__|$FAX_SECRET|g" \
      -e "s|__STATION__|$FAX_STATION_ID|g" \
      -e "s|__NUMBER__|$number|g" \
      /etc/iaxmodem/iaxmodem.conf.ttyIAX > "/etc/iaxmodem/$device.conf"
  index=$((index + 1))
done

# 3. Asterisk: the IAX2 switchboard, the carrier door when one is set, and the
#    SIP door for a carrier that only offers SIP.
#
#    One switch, two shapes: without a sub-account a modem's outbound call goes
#    to the sibling modem (the loopback rig), with one it goes to the carrier.
#    The dialplan is rendered either way, so there is no half-configured state
#    where a page is queued and never leaves.
if [ -n "$FAX_IAX_USER" ] && [ -n "$FAX_IAX_SECRET" ]; then
  register="register => $FAX_IAX_USER:$FAX_IAX_SECRET@$FAX_IAX_HOST"
  outbound0="IAX2/carrier"
  outbound1="IAX2/carrier"
  log "carrier trunk enabled over IAX2 for $FAX_IAX_USER@$FAX_IAX_HOST"
else
  register="; no carrier sub-account: loopback only (the self-test rig)"
  outbound0="IAX2/iax1"
  outbound1="IAX2/iax0"
fi

sed -e "s|__FAX_SECRET__|$FAX_SECRET|g" \
    -e "s|__NUMBER0__|$FAX_NUMBER0|g" \
    -e "s|__NUMBER1__|$FAX_NUMBER1|g" \
    -e "s|; __IAX_REGISTER__|$register|" \
    /etc/asterisk/iax.conf.tmpl > /etc/asterisk/iax.conf
sed -e "s|__OUTBOUND0__|$outbound0|g" \
    -e "s|__OUTBOUND1__|$outbound1|g" \
    -e "s|__NUMBER0__|$FAX_NUMBER0|g" \
    -e "s|__NUMBER1__|$FAX_NUMBER1|g" \
    /etc/asterisk/extensions.conf.tmpl > /etc/asterisk/extensions.conf

if [ -n "$FAX_IAX_USER" ] && [ -n "$FAX_IAX_SECRET" ]; then
  sed -e "s|__IAX_USER__|$FAX_IAX_USER|g" \
      -e "s|__IAX_SECRET__|$FAX_IAX_SECRET|g" \
      -e "s|__IAX_HOST__|$FAX_IAX_HOST|g" \
      -e "s|__NUMBER0__|$FAX_NUMBER0|g" \
      /etc/asterisk/iax-carrier.conf.tmpl >> /etc/asterisk/iax.conf
fi

# Two substitutions, not one: a replacement containing a newline ends the sed
# command, so a single two-line value silently made this file unrenderable on
# every host that sets PUBLIC_IP.
if [ -n "$PUBLIC_IP" ]; then
  media_line="external_media_address=$PUBLIC_IP"
  signaling_line="external_signaling_address=$PUBLIC_IP"
else
  media_line="; no PUBLIC_IP given: the carrier sees the container's own address"
  signaling_line="; (no PUBLIC_IP: signalling address left to the container)"
fi
sed -e "s|__SIP_BIND_PORT__|$FAX_SIP_BIND_PORT|g" \
    -e "s|; __SIP_EXTERNAL_MEDIA__|$media_line|" \
    -e "s|; __SIP_EXTERNAL_SIGNALING__|$signaling_line|" \
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

export FAX_ENGINE_TOKEN FAX_ENGINE_PORT FAX_NUMBER FAX_NUMBER0 FAX_NUMBER1 \
       FAX_STATION_ID FAX_IAX_USER FAX_IAX_HOST
log "station $FAX_STATION_ID · numbers $FAX_NUMBER0/$FAX_NUMBER1 · status on :$FAX_ENGINE_PORT"
exec supervisord -n -c /etc/supervisor/supervisord.conf
