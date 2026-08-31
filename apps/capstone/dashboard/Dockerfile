# Capstone Control Center — build the Vite SPA, serve via nginx. The built
# app points at the aggregator through the same-origin `/api` path, which the
# nginx server block below reverse-proxies to the `dashboard-api` service.
FROM node:20-alpine AS build
WORKDIR /app

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
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80