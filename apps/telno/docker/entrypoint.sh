#!/bin/sh
# Telno container entrypoint.
#
# Plug-and-play order of operations:
#   1. make sure the data volume is ours to write
#   2. create the data directory and persist generated secrets
#   3. derive the routing document from the database
#   4. hand the process the console (PID 1) — there is no switch to supervise
#
# This script runs unprivileged (USER telno in the image). It never chowns
# anything it does not already own, because it cannot — and that is the point.
set -eu

DATA_DIR="${DATA_DIR:-/data}"

# An existing volume written by an older image belongs to another account, and
# a non-root process cannot take it over. Say exactly what to run instead of
# failing later with an obscure SQLITE_READONLY.
if [ -d "$DATA_DIR" ] && ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  cat >&2 <<EOF
[entrypoint] $DATA_DIR is not writable by uid $(id -u).

This happens when the volume was created by an image that ran as a different
user. Hand it over once, on the host:

  docker compose run --rm --user root --entrypoint sh telno -c 'chown -R telno:telno /data'

Nothing is lost: the database, recordings and prompts are only re-owned.
EOF
  exit 1
fi
rm -f "$DATA_DIR/.write-test"

mkdir -p "$DATA_DIR" "$DATA_DIR/run" "${CANTUS_CONFIG_DIR:-$DATA_DIR/cantus}" \
         "${CANTUS_RECORD_DIR:-$DATA_DIR/recordings}" "$DATA_DIR/prompts"

# Persisted secrets: generate once, reuse forever, never printed.
persist_secret() {
  name="$1"
  file="$DATA_DIR/$2"
  if [ -f "$file" ]; then
    cat "$file"
    return
  fi
  value=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-40)
  printf '%s' "$value" > "$file"
  chmod 600 "$file"
  printf '%s' "$value"
}

if [ -z "${SESSION_SECRET:-}" ]; then
  SESSION_SECRET="$(persist_secret SESSION_SECRET session.secret)"
  export SESSION_SECRET
fi

if [ -z "${API_KEY_PEPPER:-}" ]; then
  API_KEY_PEPPER="$(persist_secret API_KEY_PEPPER api-key.pepper)"
  export API_KEY_PEPPER
fi

# The control plane authenticates to the switch with this token. It is not
# generated here on purpose: the switch needs the same value in its own
# environment, and a secret only one container knows is a secret that makes the
# two disagree after a restart. Compose (or the deploy script) sets it for both.
if [ -z "${CANTUS_CONTROL_TOKEN:-}" ]; then
  echo "[entrypoint] CANTUS_CONTROL_TOKEN is empty: the switch will refuse this platform's requests" >&2
fi

echo "[entrypoint] bootstrapping database and routing document"
# Creates the database, the first owner account and the Cantus routing document.
# A production boot refuses to continue with a weak owner password or an
# insecure public URL, so this is also where those are caught.
node /app/src/index.js --provision-only

echo "[entrypoint] starting the platform as uid $(id -u)"
exec node /app/src/index.js
