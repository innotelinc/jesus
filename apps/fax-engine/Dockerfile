# The fax machine the estate does not otherwise have.
#
# Cantus carries voice only: no T.38, no in-band modem signalling, so nothing in
# the switch can terminate a fax. This container is the machine that does — two
# iaxmodems (a modem implemented in software over IAX2), HylaFAX driving them
# through a tty, and an Asterisk that exists only to be the IAX2 server those
# modems register to. No carrier fax API and no per-page fee.
#
# Asterisk is not the fax machine here and res_fax is not used: the modem lives
# in iaxmodem and the pages are HylaFAX's. Asterisk is a switchboard for two
# local IAX2 peers and (optionally) a SIP trunk.
FROM andrius/asterisk:latest

ENV DEBIAN_FRONTEND=noninteractive

# Two things have to be true before `hylafax-server` is installed, or its
# postinst runs `faxsetup` and the build hangs or fails:
#
#  * `/etc/hylafax/setup.cache` must not exist, so faxsetup does run — but with
#    a scheduler config already in place, so it never asks the country/area
#    questions that loop for ever on a closed stdin.
#  * `/var/spool/hylafax/etc` must be the configuration directory faxsetup
#    writes to. Debian bind-mounts `/etc/hylafax` there, and a container build
#    has no CAP_SYS_ADMIN, so the mount fails and the postinst then decides
#    faxsetup did nothing — the install fails. A symlink is the same directory
#    without needing a mount.
COPY hylafax/config /etc/hylafax/config
RUN set -eux; \
    mkdir -p /etc/hylafax /var/spool/hylafax; \
    ln -sfn /etc/hylafax /var/spool/hylafax/etc

RUN set -eux; \
    apt-get update; \
    # --force-confold: /etc/hylafax/config is a conffile the package also ships,
    # and our station's version is already in place. dpkg would otherwise stop
    # to ask which one to keep, which no build can answer.
    apt-get install -y --no-install-recommends \
        -o Dpkg::Options::="--force-confold" \
        iaxmodem \
        hylafax-server \
        hylafax-client \
        ghostscript \
        netpbm \
        python3-minimal \
        supervisor \
        tini; \
    rm -rf /var/lib/apt/lists/*; \
    test -f /etc/hylafax/setup.cache; \
    mkdir -p /var/spool/hylafax/recvq /var/spool/hylafax/sendq \
             /var/spool/hylafax/doneq /var/spool/hylafax/docq \
             /var/spool/hylafax/archive /var/spool/hylafax/log \
             /var/spool/hylafax/tmp /var/spool/hylafax/status; \
    chown uucp:uucp /var/spool/hylafax

COPY asterisk/iax.conf /etc/asterisk/iax.conf.tmpl
COPY asterisk/iax-carrier.conf.tmpl /etc/asterisk/iax-carrier.conf.tmpl
COPY asterisk/extensions.conf /etc/asterisk/extensions.conf.tmpl
COPY asterisk/pjsip.conf.tmpl /etc/asterisk/pjsip.conf.tmpl
COPY asterisk/pjsip-carrier.conf.tmpl /etc/asterisk/pjsip-carrier.conf.tmpl
COPY asterisk/logger.conf /etc/asterisk/logger.conf
COPY hylafax/config.ttyIAX /opt/fax/config.ttyIAX
COPY hylafax/config.ttyIAX /etc/hylafax/config.ttyIAX
COPY iaxmodem/iaxmodem.conf.ttyIAX /etc/iaxmodem/iaxmodem.conf.ttyIAX
COPY supervisord.conf /etc/supervisor/conf.d/fax.conf
COPY status.py /opt/fax/status.py
COPY entrypoint.sh /opt/fax/entrypoint.sh
COPY test/loopback.sh /opt/fax/loopback.sh

RUN set -eux; \
    chmod +x /opt/fax/entrypoint.sh /opt/fax/loopback.sh /opt/fax/status.py; \
    # A copy of the finished spool, so a named volume mounted over it is seeded
    # on first boot instead of starting empty and leaving faxsetup to run again.
    cp -a /var/spool/hylafax /opt/fax/spool-seed

EXPOSE 8080

# tini as PID 1: supervisord reaps its own children, but the container also
# gets modem processes that can be killed by the tty going away.
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/fax/entrypoint.sh"]
