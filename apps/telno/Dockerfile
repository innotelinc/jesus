# Telno — all-in-one telephony platform.
#
#   control API  +  public directory  +  console  in a single image.
#   The switch is a separate service: it speaks Cantus, this image speaks JSON.
#
#   Build:  docker build -t telno .
#   Run:    docker compose up -d

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------- build -----
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# The heap is bounded on purpose: this stage runs on the demo box (1 GB RAM plus
# swap) and an unbounded V8 heap there does not fail the build, it starves the
# machine — sshd stops answering mid-build. 640 MB is comfortably above what the
# bundle needs and well under the box.
ENV NODE_OPTIONS=--max-old-space-size=640

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web ./web
RUN npm run build

# -------------------------------------------------------------- runtime -----
FROM ${NODE_IMAGE} AS runtime

# curl backs the health check; ghostscript renders a fax document to the TIFF a
# T.38 gateway transmits. There is no switch binary in this image at all — the
# whole point of Cantus is that the voice stack is a service, not a build stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates tzdata ghostscript \
 && rm -rf /var/lib/apt/lists/* \
 # One unprivileged account owns the database, the prompts and the recordings.
 && addgroup --system --gid 999 telno \
 && adduser --system --uid 999 --ingroup telno --home /data \
      --no-create-home --shell /usr/sbin/nologin telno

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    CANTUS_CONFIG_DIR=/data/cantus \
    CANTUS_RECORD_DIR=/data/recordings \
    TELEPHONY_ENABLED=true \
    CANTUS_URL=http://cantus:8088

# Runtime dependencies only: the UI is prebuilt static assets, so React, Vite
# and the rest of the build toolchain stay out of the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY --from=build /app/web/dist ./web/dist
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/entrypoint

# The base image is an argument, so a mirror or a pin can point it at an older
# Node. Fail the build with the reason instead of shipping an image that dies on
# its first import with "No such built-in module: node:sqlite".
RUN node scripts/check-node.mjs

RUN chmod +x /usr/local/bin/entrypoint \
 && mkdir -p /data /data/recordings /data/cantus /data/prompts \
 && chown -R telno:telno /data \
 && chmod 750 /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/healthz >/dev/null || exit 1

USER telno

ENTRYPOINT ["/usr/local/bin/entrypoint"]
