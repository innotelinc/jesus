#!/usr/bin/env bash
set -euo pipefail

TARGET="${CAPSTONE_TARGET:-/opt/capstone}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSET_DIR="${CAPSTONE_ASSET_DIR:-$ROOT}"
RELEASE_TAG="${CAPSTONE_RELEASE_TAG:-v1}"
REPO_SLUG="${CAPSTONE_REPO:-innotelinc/capstone}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

install_docker() {
  command -v docker >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1 && [ -n "${CAPSTONE_ALLOW_APT:-1}" ]; then
    $SUDO apt-get update
    $SUDO apt-get install -y docker.io docker-compose-plugin curl rsync openssl python3
    $SUDO systemctl enable --now docker || true
  fi
  command -v docker >/dev/null 2>&1 || {
    echo "Docker is unavailable. Connect to the internet or provide a preinstalled Docker runtime." >&2
    exit 2
  }
}

mkdir -p "$TARGET"
if [ "$ASSET_DIR" != "$TARGET" ]; then
  $SUDO rsync -a --delete --exclude '.env' "$ASSET_DIR/" "$TARGET/"
fi
install_docker

if [ -d "$TARGET/dist/docker-images-v1" ]; then
  for archive in "$TARGET/dist/docker-images-v1"/*.tar.gz; do
    [ -e "$archive" ] || continue
    echo "Loading $(basename "$archive")"
    gzip -dc "$archive" | $SUDO docker load
  done
fi

$SUDO mkdir -p /etc/capstone
$SUDO cp "$TARGET/systemd/capstone.service" /etc/systemd/system/capstone.service
$SUDO sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$TARGET|" /etc/systemd/system/capstone.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable capstone.service
$SUDO systemctl start capstone.service

echo "Capstone installed at $TARGET and started."
