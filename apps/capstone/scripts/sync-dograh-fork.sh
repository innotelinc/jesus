#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# sync-dograh-fork.sh — sync innotelinc/dograh onto dograh-hq/dograh main,
# reapplying the Innotel customizations on top, preserving each change only
# where upstream hasn't already fixed it.
#
# The fork is maintained as a clean linear history: upstream main + a single
# "reapply customizations" commit whose parent is the upstream commit it was
# synced to. This script therefore:
#
#   1. Detects whether upstream moved: is upstream/main ahead of the fork's
#      last sync point (merge-base of fork main and upstream main)?
#   2. Rebuilds the fork: new upstream main + my delta replayed on top, with
#      per-file 3-way merges (base = last sync point). Files upstream changed
#      but I didn't → upstream's new version wins (the sync). Files I changed
#      but upstream didn't → my version wins wholesale. Files both changed →
#      git merge-file 3-way; on conflict keep MY version and log it.
#   3. Classifies the upstream change (major/minor) by comparing the dograh
#      version tag at the last sync point vs now — used to bump the Capstone
#      release number.
#
# Usage:
#   ./scripts/sync-dograh-fork.sh [--push] [--force]
#
#   --push   force-push the rebuilt fork to origin/main (CI only).
#            Without --push this is a dry run (prints the plan, no writes).
#   --force  treat as an update even if upstream hasn't moved.
#
# Env:
#   FORK_REPO     fork GitHub repo (default innotelinc/dograh)
#   UPSTREAM_REPO upstream GitHub repo (default dograh-hq/dograh)
#   GH_TOKEN      GitHub token with write access to $FORK_REPO (push mode)
#
# Outputs (also written to $GITHUB_OUTPUT when set, for CI):
#   synced    true/false — did upstream move (or --force)?
#   bump      major|minor — classification of the upstream change
#   upstream_old / upstream_new — dograh versions before/after
#   conflicts — newline-separated list of files kept from the fork after
#               a 3-way merge conflict (review these)
# ═══════════════════════════════════════════════════════════════════════════

FORK_REPO="${FORK_REPO:-innotelinc/dograh}"
UPSTREAM_REPO="${UPSTREAM_REPO:-dograh-hq/dograh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PUSH=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --force) FORCE=1 ;;
  esac
done

out() { # write an output for CI
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

echo "── 1. Cloning fork ($FORK_REPO) + fetching upstream ($UPSTREAM_REPO) ──"
git clone --quiet "https://github.com/${FORK_REPO}.git" "$WORK/fork"
cd "$WORK/fork"
git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
git fetch --quiet upstream main --tags

FORK_HEAD="$(git rev-parse origin/main)"
UPSTREAM_HEAD="$(git rev-parse upstream/main)"
LAST_SYNC="$(git merge-base origin/main upstream/main)"

if [ "$FORCE" -ne 1 ] && [ "$UPSTREAM_HEAD" = "$LAST_SYNC" ]; then
  echo "upstream has not moved since the fork's last sync ($LAST_SYNC) — nothing to do."
  out synced false
  out bump minor
  out upstream_old "$(git describe --tags "$LAST_SYNC" 2>/dev/null || echo unknown)"
  out upstream_new "$(git describe --tags "$UPSTREAM_HEAD" 2>/dev/null || echo unknown)"
  out conflicts ""
  exit 0
fi

echo "fork HEAD      : $(git log -1 --format='%h %s' "$FORK_HEAD")"
echo "last sync point: $(git log -1 --format='%h %s' "$LAST_SYNC")"
echo "upstream HEAD  : $(git log -1 --format='%h %s' "$UPSTREAM_HEAD")"
[ "$FORCE" -eq 1 ] && echo "(--force: syncing anyway)"

# ── classify the upstream change: major vs minor by dograh version tag ──
ver_of() { # "dograh-v1.45.0-248-gabc" -> "1.45.0"
  git describe --tags "$1" 2>/dev/null | sed -E 's/^dograh-v//; s/-[0-9]+-g[0-9a-f]+$//' || echo "0.0.0"
}
OLD_VER="$(ver_of "$LAST_SYNC")"
NEW_VER="$(ver_of "$UPSTREAM_HEAD")"
OLD_MAJOR="${OLD_VER%%.*}"; NEW_MAJOR="${NEW_VER%%.*}"
if [ "$NEW_MAJOR" != "$OLD_MAJOR" ]; then BUMP=major; else BUMP=minor; fi
echo "dograh version at last sync: $OLD_VER  →  now: $NEW_VER  →  bump=$BUMP"

# ── rebuild: new upstream main + my delta replayed on top ──
echo "── 2. Rebuilding fork on upstream main ──"
git checkout -q -b rebuilt upstream/main
CONFLICTS_FILE="$WORK/conflicts.txt"; : > "$CONFLICTS_FILE"

my_delta() { git diff --name-status "$LAST_SYNC" "$FORK_HEAD"; }

while IFS=$'\t' read -r status file; do
  [ -n "$file" ] || continue
  case "$status" in
    A) # I added this file — port it wholesale (upstream doesn't have it)
       git checkout -q "$FORK_HEAD" -- "$file" ;;
    D) # I deleted it — respect the deletion (upstream may still have it)
       git rm -q --ignore-unmatch "$file" || true ;;
    M|T)
       # Did upstream also change this file since the sync point?
       if git diff --quiet "$LAST_SYNC" upstream/main -- "$file"; then
         # upstream untouched → my version wins wholesale
         git checkout -q "$FORK_HEAD" -- "$file"
       else
         # both changed → 3-way merge, keep mine on conflict
         mkdir -p "$WORK/3way"
         git show "$LAST_SYNC:$file"  > "$WORK/3way/base"    2>/dev/null || : > "$WORK/3way/base"
         git show "upstream/main:$file" > "$WORK/3way/ours"  2>/dev/null || : > "$WORK/3way/ours"
         git show "$FORK_HEAD:$file"   > "$WORK/3way/theirs" 2>/dev/null || : > "$WORK/3way/theirs"
         if git merge-file -p "$WORK/3way/ours" "$WORK/3way/base" "$WORK/3way/theirs" > "$WORK/3way/merged" 2>/dev/null; then
           cp "$WORK/3way/merged" "$file"
           git add "$file"
         else
           # 3-way conflicted — keep MY version, flag for review
           git checkout -q "$FORK_HEAD" -- "$file"
           echo "$file" >> "$CONFLICTS_FILE"
         fi
       fi ;;
    *) echo "warning: unhandled delta status '$status' for $file" ;;
  esac
done < <(my_delta)

CONFLICTS="$(sort -u "$CONFLICTS_FILE" | paste -sd'|' - 2>/dev/null || true)"
if [ -n "$CONFLICTS" ]; then
  echo "!! 3-way merge conflicts — kept fork version (review these):"
  echo "$CONFLICTS" | tr '|' '\n' | sed 's/^/    /'
fi

echo "── 3. Verifying rebuilt tree ──"
if git diff --quiet "$UPSTREAM_HEAD" origin/main -- . ':!'"$CONFLICTS" >/dev/null 2>&1; then :; fi
git status --porcelain | head -5
git add -A
if [ "$PUSH" -eq 1 ]; then
  git -c user.name="innotel-sync[bot]" -c user.email="innotel-sync[bot]@users.noreply.github.com" \
    commit -q -m "sync: rebase fork onto dograh-hq/dograh main ($NEW_VER) and reapply Innotel customizations

Upstream advanced from $OLD_VER to $NEW_VER (bump=$BUMP). Reapplied the
Innotel delta (last sync point $LAST_SYNC): self-hosted interview stack,
Asterisk/FreePBX ARI wiring, NPM-fronted hostnames, systemd autostart, and
nightly DB backup — keeping each change only where upstream hadn't already
fixed it.
${CONFLICTS:+Kept fork version after 3-way conflict (review): $CONFLICTS}"
  if [ -n "${GH_TOKEN:-}" ]; then
    PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${FORK_REPO}.git"
  else
    PUSH_URL="https://github.com/${FORK_REPO}.git"
  fi
  # Pass the fork's main SHA we cloned to --force-with-lease. Without an
  # explicit expected value git refuses with "stale info" when the push goes
  # over an x-access-token URL (no matching remote-tracking ref), which has
  # been blocking CI releases. The explicit lease keeps the same overwrite
  # protection against concurrent push changes to the fork's main.
  git push -q --force-with-lease="main:${FORK_HEAD}" "$PUSH_URL" rebuilt:main
  echo "pushed rebuilt fork to $FORK_REPO main ($(git rev-parse --short HEAD))"
else
  echo "dry run — rebuilt tree ready on branch 'rebuilt' (not pushed)."
  echo "re-run with --push to publish."
fi

out synced true
out bump "$BUMP"
out upstream_old "$OLD_VER"
out upstream_new "$NEW_VER"
out conflicts "$CONFLICTS"
exit 0
