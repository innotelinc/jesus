#!/bin/sh
# Telno container entrypoint.
#
# Plug-and-play order of operations:
#   1. make sure the data volume is ours to write
#   2. create the data directory and persist generated secrets
#   3. derive the switch configuration from the database
#   4. hand both processes to supervisor (PID 1, restarts on crash)
#
# This script runs unprivileged (USER telno in the image). It never chowns
# anything it does not already own, because it cannot — and that is the point.
set -eu

DATA_DIR="${DATA_DIR:-/data}"

# An existing volume written by an older image belongs to another account, and
# a non-root process cannot take it over. Say exactly what to run instead of
# failing later with an obscure SQLITE_READONLY or a supervisor that cannot
# write its own pidfile.
if [ -d "$DATA_DIR" ] && ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  cat >&2 <<EOF
[entrypoint] $DATA_DIR is not writable by uid $(id -u).

This happens when the volume was created by an image that ran as a different
user. Hand it over once, on the host:

  docker compose run --rm --user root --entrypoint sh telno -c \\
    'chown -R telno:telno /data /etc/asterisk /var/spool/asterisk'

Nothing is lost: the database, recordings and spool are only re-owned.
EOF
  exit 1
fi
rm -f "$DATA_DIR/.write-test"

mkdir -p "$DATA_DIR" "$DATA_DIR/run" /var/lib/asterisk /var/log/asterisk \
         /var/spool/asterisk /var/run/asterisk

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

# The API connects to AMI with this secret, and manager.conf is generated from
# it, so the two can never drift.
if [ -z "${AMI_SECRET:-}" ]; then
  AMI_SECRET="$(persist_secret AMI_SECRET ami.secret)"
  export AMI_SECRET
fi

export ASTERISK_CONFIG_DIR="${ASTERISK_CONFIG_DIR:-/etc/asterisk}"

# A volume written by an image that ran as root carries runuser/rungroup=asterisk.
# This container is unprivileged and that account no longer exists, and Asterisk
# refuses to start over a name it cannot resolve, so the directives are removed
# rather than left to fail.
if [ -f "$ASTERISK_CONFIG_DIR/asterisk.conf" ] && grep -qE '^[[:space:]]*(runuser|rungroup)[[:space:]]*=' "$ASTERISK_CONFIG_DIR/asterisk.conf"; then
  echo "[entrypoint] dropping runuser/rungroup from $ASTERISK_CONFIG_DIR/asterisk.conf (unprivileged container)"
  # '#' as the delimiter on purpose: the pattern itself uses '|' as alternation.
  sed -i -E 's#^[[:space:]]*(runuser|rungroup)[[:space:]]*=.*$#;\1 removed: this container is unprivileged#' "$ASTERISK_CONFIG_DIR/asterisk.conf"
fi

# Only meaningful when the container is deliberately started as root (for
# example the one-time volume migration above); as telno this is a no-op.
if [ "$(id -u)" = "0" ]; then
  chown -R telno:telno "$DATA_DIR" "$ASTERISK_CONFIG_DIR" /var/spool/asterisk 2>/dev/null || true
fi

echo "[entrypoint] bootstrapping database and switch configuration"
# Creates the database, the first owner account and every generated .conf.
# A production boot refuses to continue with a weak owner password or an
# insecure public URL, so this is also where those are caught.
node /app/src/index.js --provision-only

echo "[entrypoint] starting Asterisk and the platform as uid $(id -u)"
exec /usr/bin/supervisord -c /etc/supervisor/telno.conf
