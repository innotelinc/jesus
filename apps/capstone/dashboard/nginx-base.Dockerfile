# A registry-free nginx base for the Control Center image.
#
# WHY THIS EXISTS. `nginx:1.27-alpine` is a docker.io tag, and docker.io
# answered this host with 429 Too Many Requests often enough to block a deploy.
# The Control Center image only needs nginx, envsubst and a start-up hook that
# renders `/etc/nginx/templates/*.template` into `conf.d/` — about forty lines of
# packaging — so it builds that base from `alpine`, which this host already has.
#
# The rendered set matches the official image closely enough for
# dashboard/nginx.conf, which relies on two things: `${DASHBOARD_PBX_WSS_HOST}`
# being substituted at start, and nginx's own `$host` / `$remote_addr` being left
# alone. The entrypoint substitutes only names present in the environment, which
# is exactly what the official `20-envsubst-on-templates.sh` does.
#
# Built by scripts/local-bases.sh; not a compose service.
ARG ALPINE_IMAGE=alpine:3.20
FROM ${ALPINE_IMAGE}

RUN apk add --no-cache nginx gettext \
 && mkdir -p /etc/nginx/conf.d /etc/nginx/templates /usr/share/nginx/html /run/nginx

COPY nginx-base/nginx.conf /etc/nginx/nginx.conf
COPY nginx-base/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
