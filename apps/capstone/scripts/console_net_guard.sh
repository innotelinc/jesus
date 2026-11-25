#!/bin/sh
# Keep the asterisk console reachable from the AMI bridge, and keep python3 in it.
#
# Coolify re-creates the console container on every deploy, which drops the extra
# network attachment and re-installs the image (which ships without python3).
# Coolify 4.7.6 rejects `additional_networks` for this application and
# `post_deployment_command` needs a container name that changes per deploy, so the
# two facts are re-applied here on a timer instead.
#
# Runs as root on the PBX host (cron */2). Idempotent and silent unless it acts.
set -u

APP=jbtpvwsy7yiq4cawc4aoqf7n
NET=qvifit87vftfxd9ejsch2vxy

C=$(docker ps --filter "name=$APP" --format '{{.Names}}' | head -1)
[ -n "$C" ] || exit 0

if ! docker network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null \
    | grep -q "$C"; then
  docker network connect "$NET" "$C" 2>/dev/null \
    && echo "$(date -u +%FT%TZ) attached $C to $NET"
fi

if ! docker exec "$C" sh -c 'command -v python3' >/dev/null 2>&1; then
  docker exec -u 0 "$C" apk add --no-cache python3 >/dev/null 2>&1 \
    && echo "$(date -u +%FT%TZ) installed python3 in $C"
fi

exit 0
