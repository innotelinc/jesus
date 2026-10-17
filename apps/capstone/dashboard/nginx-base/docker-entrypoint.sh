#!/bin/sh
# Render /etc/nginx/templates/*.template into /etc/nginx/conf.d/ before nginx
# starts, substituting only the names that are actually in the environment.
#
# The restriction matters: dashboard/nginx.conf is full of nginx's own variables
# ($host, $remote_addr, $pbx_wss …) and a bare `envsubst` would blank every one
# of them. Substituting `$(env | cut -d= -f1)` reproduces what the official
# nginx image's 20-envsubst-on-templates.sh does, which is what this base
# replaces.
set -eu

if [ -d /etc/nginx/templates ]; then
    defined_envs="$(printf '${%s} ' $(env | cut -d= -f1))"
    for template in /etc/nginx/templates/*.template; do
        [ -e "$template" ] || continue
        target="/etc/nginx/conf.d/$(basename "$template" .template)"
        envsubst "$defined_envs" < "$template" > "$target"
        echo "nginx-base: rendered $template -> $target"
    done
fi

exec "$@"
