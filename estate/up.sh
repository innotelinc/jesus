#!/bin/sh
# Bring the estate up in one command.
#
#   ./up.sh            build and start everything, wait until the switch answers
#   ./up.sh env        reconcile .env (missing keys, new trunk values) and stop
#   ./up.sh logs       follow the logs instead
#   ./up.sh down       stop, keep data
#   ./up.sh reset      stop and delete the volumes (recordings, telno database)
#
# Secrets are generated once into .env and reused after that. They are never
# printed: the only thing this script tells you is where to click.
set -eu

cd "$(dirname "$0")"

# Secrets must exist before docker compose reads this file, so they cannot come
# from a container. Node is used when it is there (laptops) and openssl or the
# kernel's urandom otherwise — a fresh cloud box has Docker and no Node, and the
# first deploy died with `node: not found` and an .env full of empty values,
# which docker compose then refuses to start.
gen() {
  if command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))"
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '\n=+/' | cut -c1-32
  else
    od -An -tx1 -N24 /dev/urandom | tr -d ' \n'
  fi
}

if [ ! -f .env ]; then
  echo "[estate] writing .env with fresh secrets"
  # A cloud box has no domain yet, so the platform's links point at the public
  # address it actually has. On a laptop this resolves to the local address and
  # the override below keeps it localhost.
  PUBLIC_URL="${PUBLIC_URL:-}"
  if [ -z "$PUBLIC_URL" ]; then
    ip=$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)
    if [ -n "$ip" ]; then PUBLIC_URL="http://$ip:${TELNO_PORT:-8090}"; else PUBLIC_URL="http://localhost:${TELNO_PORT:-8090}"; fi
  fi
  # The gateway puts this in Contact and SDP, so it must be the address the
  # carrier can reach — derived from PUBLIC_URL, never the container's own.
  PUBLIC_IP="${PUBLIC_IP:-$(printf '%s' "$PUBLIC_URL" | sed -E 's#^https?://([^:/]+).*#\1#')}"
  cat > .env <<EOF
PUBLIC_IP=$PUBLIC_IP
# The carrier half of the estate. Empty means no trunk: the gateway boots, says
# it is unregistered, and every PSTN call fails with a cause instead of hanging.
VOIPMS_SIP_HOST=${VOIPMS_SIP_HOST:-}
VOIPMS_SIP_PORT=${VOIPMS_SIP_PORT:-5060}
VOIPMS_SIP_USERNAME=${VOIPMS_SIP_USERNAME:-}
VOIPMS_SIP_PASSWORD=${VOIPMS_SIP_PASSWORD:-}
VOIPMS_SIP_DOMAIN=${VOIPMS_SIP_DOMAIN:-}
CANTUS_DOMAIN=estate.local
VOIPMS_SIP_FROM_USER=${VOIPMS_SIP_FROM_USER:-}
CANTUS_SECRET=$(gen)
CANTUS_CONTROL_TOKEN=$(gen)
CANTUS_ARI_USER=dograh
CANTUS_ARI_PASSWORD=$(gen)
ESTATE_PORT=8000
SWITCH_PORT=8188
TELNO_PORT=8090
PUBLIC_URL=$PUBLIC_URL
EOF
  chmod 600 .env
fi

# `.env` is written once, so a box that was deployed before a setting existed
# never gets it — and an estate with no PUBLIC_IP is a gateway that puts its
# container address in Contact and SDP, where no carrier can send media. The
# keys below are reconciled on every run instead: a value passed in the
# environment is applied, a value already in the file is left alone, and a key
# that is missing is added (empty, so the operator can see what to fill in).
write_key() { # write_key KEY VALUE
  key=$1
  value=$2
  tmp=$(mktemp)
  found=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*)
        printf '%s=%s\n' "$key" "$value" >>"$tmp"
        found=1
        ;;
      *)
        printf '%s\n' "$line" >>"$tmp"
        ;;
    esac
  done <.env
  [ "$found" = 1 ] || printf '%s=%s\n' "$key" "$value" >>"$tmp"
  cat "$tmp" >.env
  rm -f "$tmp"
}

ensure_key() { # ensure_key KEY [VALUE] — an explicit value wins, otherwise only add
  key=$1
  value=${2:-}
  current=$(sed -n "s/^$key=//p" .env | head -1)
  if [ -n "$value" ]; then
    [ "$current" = "$value" ] || write_key "$key" "$value"
  elif [ -z "$current" ] && ! grep -q "^$key=" .env; then
    write_key "$key" ""
  fi
}

# The address the carrier must send to, derived from the public URL the estate
# already publishes unless the operator says otherwise.
public_ip=${PUBLIC_IP:-$(sed -n 's/^PUBLIC_URL=//p' .env | head -1 | sed -E 's#^https?://([^:/]+).*#\1#')}
ensure_key PUBLIC_IP "$public_ip"
ensure_key VOIPMS_SIP_HOST "${VOIPMS_SIP_HOST:-}"
ensure_key VOIPMS_SIP_PORT "${VOIPMS_SIP_PORT:-}"
ensure_key VOIPMS_SIP_USERNAME "${VOIPMS_SIP_USERNAME:-}"
ensure_key VOIPMS_SIP_PASSWORD "${VOIPMS_SIP_PASSWORD:-}"
ensure_key VOIPMS_SIP_FROM_USER "${VOIPMS_SIP_FROM_USER:-}"
ensure_key VOIPMS_SIP_DOMAIN "${VOIPMS_SIP_DOMAIN:-}"
ensure_key SIP_SRTP "${SIP_SRTP:-}"

case "${1:-up}" in
  up)
    docker compose up -d --build
    printf '[estate] waiting for the switch'
    i=0
    while [ "$i" -lt 60 ]; do
      if curl -fsS "http://127.0.0.1:${SWITCH_PORT:-8188}/healthz" >/dev/null 2>&1; then break; fi
      printf '.'; i=$((i + 1)); sleep 2
    done
    printf '\n'
    curl -fsS "http://127.0.0.1:${SWITCH_PORT:-8188}/healthz" >/dev/null 2>&1 || {
      echo "[estate] the switch did not answer; docker compose logs switch" >&2
      exit 1
    }
    echo
    echo "  console   http://localhost:${ESTATE_PORT:-8000}"
    echo "  switch    http://localhost:${SWITCH_PORT:-8188}/v1/status"
    echo "  telno     http://localhost:${TELNO_PORT:-8090}   (owner login: admin@estate.local, password in its boot log)"
    echo "  ARI       http://localhost:${SWITCH_PORT:-8188}/ari/asterisk/info   user ${CANTUS_ARI_USER:-dograh}"
    echo
    echo "  docker compose logs -f        # everything"
    ;;
  env)
    # Reconcile .env only: used to hand the gateway its trunk without paying
    # for a rebuild of everything else. `docker compose up -d gateway` after
    # this recreates just that container with the new values.
    echo "[estate] $PWD/.env reconciled"
    ;;
  logs)
    exec docker compose logs -f --tail=100
    ;;
  down)
    exec docker compose down
    ;;
  reset)
    # Volumes hold the telno database, recordings and prompts. `down -v` is the
    # only thing that removes them, and it is never implied by `down`.
    docker compose down -v
    ;;
  *)
    echo "usage: $0 [up|logs|down|reset]" >&2
    exit 2
    ;;
esac
