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
    # Built name by name on purpose: `${NAME}` must stay literal here, and the
    # unquoted split of `env` is the point of the loop.
    defined_envs=""
    for name in $(env | cut -d= -f1); do
        defined_envs="${defined_envs}\${${name}} "
    done
    for template in /etc/nginx/templates/*.template; do
        [ -e "$template" ] || continue
        target="/etc/nginx/conf.d/$(basename "$template" .template)"
        envsubst "$defined_envs" < "$template" > "$target"
        echo "nginx-base: rendered $template -> $target"
    done
fi

exec "$@"
