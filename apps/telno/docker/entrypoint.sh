#!/bin/sh
# Telno container entrypoint.
#
# Plug-and-play order of operations:
#   1. create the data directory and persist generated secrets
#   2. derive the switch configuration from the database
#   3. hand both processes to supervisor (PID 1, restarts on crash)
set -eu

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR" /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk
chown -R asterisk:asterisk "$DATA_DIR" 2>/dev/null || true

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

# Make sure Asterisk can read what we are about to write.
chown -R asterisk:asterisk "$ASTERISK_CONFIG_DIR" 2>/dev/null || true

echo "[entrypoint] bootstrapping database and switch configuration"
# Creates the database, the first owner account and every generated .conf.
node /app/src/index.js --provision-only

echo "[entrypoint] starting Asterisk and the platform"
exec /usr/bin/supervisord -c /etc/supervisor/telno.conf
