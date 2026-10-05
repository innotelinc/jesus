# Capstone Control Center — build the Vite SPA, serve via nginx. The built
# app points at the aggregator through the same-origin `/api` path, which the
# nginx server block below reverse-proxies to the `dashboard-api` service.
FROM node:20-alpine AS build
WORKDIR /app

# Cap the Node heap so the build survives small/loaded hosts. Left uncapped,
# node sizes its default heap from the host's RAM, grows past what is actually
# available, and is OOM-killed mid-build (exit 137) instead of finishing in a
# bounded footprint. Overridable for a CI runner with more headroom.
ARG NODE_OPTIONS=--max-old-space-size=1400
ENV NODE_OPTIONS=$NODE_OPTIONS
# Playwright is a devDependency for the smoke test only; its postinstall would
# otherwise download a browser into the build stage — hundreds of MB the image
# never uses. The CI smoke job installs the browser itself.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html tailwind.config.js postcss.config.js ./
COPY public ./public
COPY src ./src

# Where the browser reaches the aggregator. `/api` is same-origin (nginx
# proxies it to dashboard-api), so no host/port wiring or CORS is needed.
ARG VITE_DASHBOARD_BASE_URL=/api
ENV VITE_DASHBOARD_BASE_URL=$VITE_DASHBOARD_BASE_URL

RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# DASHBOARD_PBX_WSS_HOST names the PBX for the /ws upstream at RUNTIME (the
# zeus add-on's shared PBX is only reachable from a network joined at
# `docker compose up`, so it cannot be baked at build time). envsubst
# renders it into the config on start; the image's own envsubst template
# machinery handles the rest of the nginx defaults.
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV DASHBOARD_PBX_WSS_HOST=pbx-freepbx
EXPOSE 80