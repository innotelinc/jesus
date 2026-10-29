# cantus-gateway — Cantus on one side, SIP/RTP on the other.
#
# The gateway imports the switch's protocol modules (wire format, identity,
# sessions, media) rather than keeping a second copy of them: one implementation
# of Cantus in this repository, and the gateway is a client of it.
#
#   Build (from the repository root):  docker build -f apps/cantus-gateway/Dockerfile .
#   Run:                               docker run --rm -p 5060:5060/udp apps/cantus-gateway

FROM node:24-alpine

# No dependencies to install: the switch has none, and neither does this.
WORKDIR /app

COPY apps/cantus-switch /app/cantus-switch
COPY apps/cantus-gateway /app/cantus-gateway

# Unprivileged. SIP and RTP are unprivileged ports once the container maps them,
# and nothing here needs to write to disk.
USER 65534:65534

ENV NODE_ENV=production
WORKDIR /app/cantus-gateway

EXPOSE 5060/udp
EXPOSE 7454/tcp

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7454/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
