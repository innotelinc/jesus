#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${CAPSTONE_REPO:-innotelinc/capstone}"
RELEASE_TAG="${CAPSTONE_RELEASE_TAG:-v1}"
OUT_DIR="${1:-dist/offline-bundle}"
BASE_URL="https://github.com/${REPO_SLUG}/releases/download/${RELEASE_TAG}"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

for file in capstone-v1-deployment.tar.gz docker-images-v1.tar.gz SHA256SUMS; do
  curl -fL --retry 3 --retry-delay 2 -o "$file" "$BASE_URL/$file"
done
sha256sum -c SHA256SUMS --ignore-missing

echo "Offline bundle ready at $(pwd). Copy it to the live USB's /opt/capstone assets directory."
