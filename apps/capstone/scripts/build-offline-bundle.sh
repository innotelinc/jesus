#!/usr/bin/env bash
set -euo pipefail

# Build the Capstone offline release bundle:
#
#   capstone-v2-deployment.tar.gz   - full source + compose + systemd payload
#   docker-images-v2-partN.tar.gz   - Docker image archives (split < 2 GB each
#                                     so they can be uploaded to GitHub)
#   SHA256SUMS                      - checksums for the above
#
# Output goes to dist/offline-bundle/ by default.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO/dist/offline-bundle}"
IMAGES_FILE="${IMAGES_FILE:-$REPO/scripts/offline-images.txt}"
MAX_PART_BYTES="${MAX_PART_BYTES:-1900000000}"   # stay under GitHub's 2 GB limit
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT_DIR"
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

echo "== Building deployment bundle (source + compose + systemd) =="
mkdir -p "$STAGE/src"
git -C "$REPO" archive --format=tar HEAD | tar -xf - -C "$STAGE/src"
for file in scripts/install-capstone.sh scripts/fetch-offline-bundle.sh \
            scripts/split-image-bundle.sh \
            scripts/build-source-bundle.sh scripts/build-offline-bundle.sh \
            scripts/build-live-usb.sh; do
  mkdir -p "$STAGE/src/$(dirname "$file")"
  cp "$REPO/$file" "$STAGE/src/$file"
done
rm -rf "$STAGE/src/.env" "$STAGE/src/.git" "$STAGE/src/dist" "$STAGE/src/.live-build"
tar -czf "$OUT_DIR/capstone-v2-deployment.tar.gz" -C "$STAGE/src" .

DEPLOYMENT_ONLY=0
[ "${1:-}" = "--deployment-only" ] && DEPLOYMENT_ONLY=1

if [ "$DEPLOYMENT_ONLY" -eq 1 ]; then
  echo "== Checksums (deployment + any existing image parts) =="
  ( cd "$OUT_DIR" && shopt -s nullglob && sha256sum capstone-v2-deployment.tar.gz docker-images-v2-part*.tar.gz > SHA256SUMS )
  echo "Created in $OUT_DIR:"
  ls -lh "$OUT_DIR"
  exit 0
fi

echo "== Building Docker image archives (streamed) =="
IMAGES=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="$(echo "$line" | xargs)"
  [ -n "$line" ] || continue
  IMAGES+=("$line")
done < "$IMAGES_FILE"

# Stream each `docker save` into the split parts directly, so we never hold
# both the unpacked image archives AND the packed parts on disk at once (the
# previous two-stage build kept ~2x the bundle size around and could exhaust
# a constrained CI runner). Each per-image gzip is a separate member of one
# multi-member gzip stream; the parts are just that stream split < 2 GB each
# (cat parts* reconstructs it). Consumers split members back out with
# scripts/split-image-bundle.sh.
rm -f "$OUT_DIR"/docker-images-v2-part*.tar.gz
{
  for img in "${IMAGES[@]}"; do
    case "$img" in
      innotel-n8n-otel:local)
        echo "-- Building $img from n8n.Dockerfile" >&2
        docker build -f "$REPO/n8n.Dockerfile" -t "$img" "$REPO" >&2 ;;
      innotel-dashboard:local)
        echo "-- Building $img from dashboard/Dockerfile" >&2
        docker build -f "$REPO/dashboard/Dockerfile" -t "$img" "$REPO/dashboard" >&2 ;;
      innotel-dashboard-api:local)
        echo "-- Building $img from dashboard-backend/Dockerfile" >&2
        docker build -f "$REPO/dashboard-backend/Dockerfile" -t "$img" "$REPO/dashboard-backend" >&2 ;;
      *)
        echo "-- Pulling $img" >&2
        # docker pull writes progress to stdout when stdout is not a TTY;
        # send it to stderr to keep the gzip image stream clean.
        docker pull "$img" >&2 ;;
    esac
    echo "-- Saving $img (streamed)" >&2
    # stdout in this branch is EXCLUSIVELY the gzipped docker save stream.
    docker save "$img" | gzip -1
  done
} | split -b "$MAX_PART_BYTES" -d -a 2 - "$OUT_DIR/docker-images-v2-part"
# split names parts part00, part01, ...; add the .tar.gz suffix and drop any
# trailing empty part produced by an exact-size split.
for f in "$OUT_DIR"/docker-images-v2-part??; do
  if [ ! -s "$f" ]; then
    rm -f "$f"
  else
    mv "$f" "$f.tar.gz"
  fi
done
[ -n "$(echo "$OUT_DIR"/docker-images-v2-part*.tar.gz)" ] || { \
  echo "No image parts produced - build or pull failed." >&2; exit 1; }

echo "== Verifying streamed bundle (cat parts* must be a valid multi-member gzip) =="
cat "$OUT_DIR"/docker-images-v2-part*.tar.gz | gzip -t && echo "gzip OK"

echo "== Checksums =="
( cd "$OUT_DIR" && sha256sum capstone-v2-deployment.tar.gz docker-images-v2-part*.tar.gz > SHA256SUMS )

echo "Created in $OUT_DIR:"
ls -lh "$OUT_DIR"
