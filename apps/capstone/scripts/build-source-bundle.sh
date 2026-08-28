#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO/dist/source-bundle}"
NAME="${NAME:-capstone-source-bundle.tar.gz}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT_DIR"

# Export tracked files plus intentionally included deployment assets, while
# excluding secrets, Git metadata, runtime state, and generated archives.
git -C "$REPO" archive --format=tar HEAD | tar -xf - -C "$STAGE"
# Include current tracked deployment scripts even when this builder is run from
# a worktree whose HEAD predates the latest installer additions.
for file in scripts/build-live-usb.sh scripts/build-source-bundle.sh scripts/fetch-offline-bundle.sh scripts/install-capstone.sh; do
  mkdir -p "$STAGE/$(dirname "$file")"
  cp "$REPO/$file" "$STAGE/$file"
done
rm -rf "$STAGE/.env" "$STAGE/.git" "$STAGE/dist" "$STAGE/.live-build"
tar -czf "$OUT_DIR/$NAME" -C "$STAGE" .
sha256sum "$OUT_DIR/$NAME" > "$OUT_DIR/$NAME.sha256"
echo "Created $OUT_DIR/$NAME"
