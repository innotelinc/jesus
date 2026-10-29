# The Cantus switch.
#
# No build step and no dependencies: the image is Node plus this directory.
# That is the point of the protocol — a voice stack that needs a package manager
# at start-up is a voice stack that fails on the day the registry is unreachable.

FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    CANTUS_HTTP_PORT=8088 \
    CANTUS_BIND=0.0.0.0:7443 \
    CANTUS_RELAY_BIND=0.0.0.0:7444 \
    CANTUS_CONFIG_DIR=/data/cantus \
    CANTUS_RECORD_DIR=/data/recordings \
    CANTUS_PROMPTS=/data/prompts

COPY package.json ./
COPY src ./src
COPY README.md ./README.md

# One unprivileged account. Every port is above 1024, so nothing needs root:
# 7443/udp (Cantus), 7444/udp (relay) and 8088/tcp (control + ARI).
RUN groupadd --system --gid 997 cantus \
 && useradd --system --uid 997 --gid cantus --home /data --no-create-home --shell /usr/sbin/nologin cantus \
 && mkdir -p /data/recordings /data/cantus /data/prompts \
 && chown -R cantus:cantus /data

EXPOSE 8088 7443/udp 7444/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8088/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER cantus

ENTRYPOINT ["node", "src/cli.js", "run"]
