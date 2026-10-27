# Telno — all-in-one telephony platform.
#
#   Asterisk  +  control API  +  public directory  in a single image.
#   One database, one process tree, one port to publish (plus SIP/RTP when
#   you actually terminate calls here).
#
#   Build:  docker build -t telno .
#   Run:    docker compose up -d

# ---------------------------------------------------------------- build -----
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web ./web
RUN npm run build

# --------------------------------------------------------------- switch -----
# Asterisk is built here, with its own pjproject, and the reason is a single
# constant: PJSIP_MAX_PKT_LEN.
#
# A distribution Asterisk links the distribution pjproject, which keeps that
# limit at pjproject's 4000-byte default. A browser's WebRTC INVITE — audio
# plus the video codec list Chrome offers — is 5-6 kB, so chan_pjsip drops it
# with "Rx buffer overflow (PJSIP_ERXOVERFLOW)" and the call never rings, even
# though registration and the WebSocket are perfectly healthy. Asterisk's
# bundled pjproject configuration raises the limit to 65535, and because the
# macro sizes packet buffers inside structs shared by the switch and pjproject,
# the two have to be compiled together. That is what this stage does.
#
# The base is glibc on purpose: Asterisk redirects libc allocators to its own
# debug ones with function-like macros, and musl re-declares calloc/free after
# those macros exist, so a musl build fails in its own headers.
FROM debian:bookworm AS switch

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential autoconf automake libtool pkg-config \
      libssl-dev libedit-dev libxml2-dev libsqlite3-dev libjansson-dev \
      libsrtp2-dev libcap-dev uuid-dev \
      curl ca-certificates xz-utils bzip2 python3 patch \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
ARG ASTERISK_VERSION=22-current
RUN curl -fsSL "https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_VERSION}.tar.gz" \
      | tar xz --strip-components=1

RUN ./configure --with-pjproject-bundled --with-jansson-bundled \
 && make -j"$(nproc)" \
 && make install DESTDIR=/staging \
 # Asterisk builds with -g3; the debug info is most of the module size and is
 # of no use in the runtime image.
 && find /staging/usr/sbin /staging/usr/lib -type f \
      \( -name 'asterisk' -o -name '*.so' -o -name '*.so.*' \) \
      -exec strip --strip-unneeded {} +

# Ship the switch, not its sample configuration: ours is generated from the
# database on every boot.
RUN rm -rf /staging/etc/asterisk /staging/usr/share/doc /staging/usr/lib/systemd \
 && mkdir -p /staging/etc/asterisk

# -------------------------------------------------------------- runtime -----
FROM node:24-bookworm-slim AS runtime

# supervisor runs both processes under one root; curl backs the health check;
# openssl mints the WSS certificate on first boot. The rest are the runtime
# libraries of the switch built above.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      supervisor curl openssl ca-certificates tzdata \
      libssl3 libedit2 libxml2 libsqlite3-0 libjansson4 libsrtp2-1 \
      libcap2 libuuid1 zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 # One unprivileged account owns the database, the switch configuration and the
 # spool. Nothing in this image needs root: every port it listens on is above
 # 1024 (8080 API, 8089 WSS, 5038 AMI, 5060/udp SIP, 10000+ RTP).
 && addgroup --system --gid 999 telno \
 && adduser --system --uid 999 --ingroup telno --home /data \
      --no-create-home --shell /usr/sbin/nologin telno

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    ASTERISK_CONFIG_DIR=/etc/asterisk \
    TELEPHONY_ENABLED=true \
    AMI_HOST=127.0.0.1 \
    AMI_PORT=5038 \
    AMI_USER=telno

# Runtime dependencies only: the UI is prebuilt static assets, so React, Vite
# and the rest of the build toolchain stay out of the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY --from=build /app/web/dist ./web/dist
COPY scripts ./scripts

COPY --from=switch /staging/usr/sbin/asterisk /usr/sbin/asterisk
# Asterisk's own shared objects (libasteriskpj, libasteriskssl) live beside the
# module directory, not inside it.
COPY --from=switch /staging/usr/lib/libasterisk* /usr/lib/
COPY --from=switch /staging/usr/lib/asterisk /usr/lib/asterisk
COPY --from=switch /staging/var/lib/asterisk /var/lib/asterisk
COPY docker/asterisk/ /etc/asterisk/
COPY docker/supervisord.conf /etc/supervisor/telno.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint

# A missing runtime library is a build failure, not a container that dies on
# boot with "error while loading shared libraries".
RUN set -e; \
    missing="$(ldd /usr/sbin/asterisk /usr/lib/asterisk/modules/*.so 2>/dev/null | grep 'not found' || true)"; \
    if [ -n "$missing" ]; then echo "unresolved libraries:"; echo "$missing"; exit 1; fi

RUN chmod +x /usr/local/bin/entrypoint \
 && mkdir -p /data /var/lib/asterisk /var/log/asterisk /var/spool/asterisk \
      /var/run/asterisk /var/lib/asterisk/keys \
 && chown -R telno:telno /etc/asterisk /var/lib/asterisk /var/log/asterisk \
      /var/spool/asterisk /var/run/asterisk /data \
 && chmod 750 /data

EXPOSE 8080
# 8089 is the browser softphone's secure WebSocket (chan_pjsip WSS).
# AMI, SIP and RTP are only published by compose when you need them.
EXPOSE 5038 8089 5060/udp 10000-10100/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/healthz >/dev/null || exit 1

# Everything below this line runs unprivileged, supervisor (PID 1) included.
# On a fresh volume this needs no preparation; an existing volume written by an
# older image has to change hands once, and the entrypoint says so with the
# exact command rather than failing obscurely.
USER telno

ENTRYPOINT ["/usr/local/bin/entrypoint"]
