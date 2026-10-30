# CHRIST — the front door.
#
# The build context is the repository root, not this directory, for one reason:
# the wiring engine validates the routing document with the switch's own Router
# rather than a copy of the rules. That means the image carries
# apps/cantus-switch/src/router.js at the path `lib/wire.js` imports it from,
# and there is exactly one implementation of the dial-plan schema in the world.
#
#   docker build -f christ/Dockerfile -t christ .

FROM node:24-alpine

WORKDIR /jesus

# Only the file the wiring engine imports, not the whole switch: the image is
# the front door, and a copy of the voice plane in it would be a lie.
COPY apps/cantus-switch/src/router.js apps/cantus-switch/src/router.js
COPY christ christ

WORKDIR /jesus/christ

ENV NODE_ENV=production \
    PORT=8001

EXPOSE 8001

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No dependencies, no build step: `node server.js` is the whole runtime.
CMD ["node", "server.js"]
