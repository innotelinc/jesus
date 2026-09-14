#!/usr/bin/env bash
# apply-dograh-patches.sh — apply this repo's patches to dograh/upstream.
#
# dograh/upstream is cloned by scripts/setup.sh and is gitignored, so local
# fixes to the dograh UI/API cannot live in the clone: a fresh clone, a new
# host or a re-run of setup.sh would silently lose them. They are kept as
# patches in dograh/patches/ instead and re-applied here.
#
# Idempotent: a patch that is already applied is skipped, so this is safe to
# call on every setup run and before every build-from-source.
#
#   ./scripts/apply-dograh-patches.sh            # apply everything pending
#   ./scripts/apply-dograh-patches.sh --check    # report only, exit 1 if any
#                                                # patch is not applied
#
# Called automatically by scripts/setup.sh after the clone. The build-from-source
# override (docker-compose.dograh-build.yml) needs the patches applied first —
# run this script, or let setup.sh do it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="$REPO/dograh/upstream"
PATCH_DIR="$REPO/dograh/patches"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
err()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; }

if [ ! -d "$UPSTREAM/.git" ]; then
    warn "dograh/upstream is not cloned — nothing to patch (the stack can run the prebuilt image)"
    exit 0
fi
if [ ! -d "$PATCH_DIR" ] || [ -z "$(ls -A "$PATCH_DIR"/*.patch 2>/dev/null || true)" ]; then
    warn "no patches in dograh/patches — nothing to do"
    exit 0
fi

pending=0
for patch in "$PATCH_DIR"/*.patch; do
    name="$(basename "$patch")"
    # A patch that reverse-applies is already in the tree; one that applies
    # forward is missing. Anything else is a conflict and must not be forced.
    if git -C "$UPSTREAM" apply --reverse --check "$patch" >/dev/null 2>&1; then
        pass "$name — already applied"
    elif git -C "$UPSTREAM" apply --check "$patch" >/dev/null 2>&1; then
        if [ "$CHECK_ONLY" = "1" ]; then
            err "$name — NOT applied"
            pending=$((pending + 1))
        else
            git -C "$UPSTREAM" apply "$patch"
            pass "$name — applied"
        fi
    else
        err "$name — does not apply cleanly (upstream moved, or the tree has local edits)"
        pending=$((pending + 1))
    fi
done

if [ "$CHECK_ONLY" = "1" ] && [ "$pending" -gt 0 ]; then
    exit 1
fi
exit 0
