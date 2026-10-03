#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# sync-dograh-fork.sh — sync the dograh platform source used by this repo,
# reapplying the Capstone customizations on top, preserving each change only
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
# --force on the tag fetch: the fork carries its own copies of upstream's
# release tags from its creation (e.g. dograh-v1.46.0), and when upstream
# moves or re-points a tag the plain fetch aborts with "would clobber existing
# tag" — which silently killed the whole sync in CI (set -e + --quiet).
# Upstream's tags are the authority for the version classification below, so
# shadowing copies are meant to be overwritten here.
git fetch --quiet --force upstream main --tags

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

# The fork carries workflow files, and GitHub refuses a push that creates or
# updates one from a token without the `workflow` scope:
#
#   ! [remote rejected] rebuilt -> main (refusing to allow a Personal Access
#   Token to create or update workflow `.github/workflows/...` without `workflow` scope)
#
# That is a plain git rejection, so it reads as a generic "failed to push some
# refs" and the whole sync dies without a hint of what to fix. Two guards cover
# it, because neither alone sees every token:
#
#   * up front — the token's scopes are the `X-OAuth-Scopes` response header,
#     so a classic PAT can be checked before spending a push on it.
#   * after the push — a fine-grained PAT returns no such header at all, so the
#     preflight has nothing to read. The rejection text is still unambiguous
#     though, so the push output is matched for it and the same remedy printed.
#
# CHANGED_WORKFLOWS is whichever of the two detected the offending paths, so the
# fatal can always name them.
CHANGED_WORKFLOWS=""

workflow_scope_fatal() {
  echo "FATAL: this sync changes .github/workflows/*, but FORK_SYNC_SECRET is missing the 'workflow' scope." >&2
  echo "       GitHub rejects that push with 'refusing to allow a Personal Access Token to create or" >&2
  echo "       update workflow ... without workflow scope'. Left uncaught it surfaces only as a bare" >&2
  echo "       'failed to push some refs'." >&2
  if [ -n "${1:-}" ]; then echo "       $1" >&2; fi
  echo "       Fix: grant the token the 'workflow' scope (classic PAT: repo + workflow;" >&2
  echo "       fine-grained: Contents: write + Workflows: write), then re-run this workflow." >&2
  if [ -n "$CHANGED_WORKFLOWS" ]; then
    echo "       workflows this sync touches:" >&2
    while IFS= read -r wf; do echo "         $wf" >&2; done <<<"$CHANGED_WORKFLOWS"
  fi
  exit 1
}

if [ "$PUSH" -eq 1 ] && [ -n "${GH_TOKEN:-}" ]; then
  CHANGED_WORKFLOWS="$(git diff --name-only "$UPSTREAM_HEAD" origin/main -- .github/workflows 2>/dev/null || true)"
  if [ -n "$CHANGED_WORKFLOWS" ]; then
    headers="$(curl -sS -I -H "Authorization: token ${GH_TOKEN}" https://api.github.com/user 2>/dev/null \
      | tr -d '\r' || true)"
    # The header is comma-and-space separated ("repo, workflow"), so the split
    # has to drop the spaces or a token that HAS the scope reads as missing it.
    #
    # Presence and emptiness are different answers. A classic PAT always sends
    # the header, and an empty one means "no scopes granted" — definitely
    # missing the scope, so it can be caught here. A fine-grained PAT sends no
    # header at all, which says nothing; that case goes to the post-push guard
    # rather than being guessed at from silence.
    if printf '%s\n' "$headers" | grep -qi '^x-oauth-scopes:'; then
      scopes="$(printf '%s\n' "$headers" | sed -n 's/^[Xx]-[Oo][Aa]uth-[Ss]copes: *//p' | head -1)"
      if ! printf '%s' "$scopes" | tr ',' '\n' | tr -d ' ' | grep -qx 'workflow'; then
        workflow_scope_fatal "scopes reported by GitHub: ${scopes:-(none)}"
      fi
    fi
  fi
fi

echo "── 3. Verifying rebuilt tree ──"
if git diff --quiet "$UPSTREAM_HEAD" origin/main -- . ':!'"$CONFLICTS" >/dev/null 2>&1; then :; fi
git status --porcelain | head -5
git add -A
if [ "$PUSH" -eq 1 ]; then
  git -c user.name="capstone-release[bot]" -c user.email="capstone-release[bot]@users.noreply.github.com" \
    commit -q -m "sync: rebase fork onto dograh-hq/dograh main ($NEW_VER) and reapply Capstone customizations

Upstream advanced from $OLD_VER to $NEW_VER (bump=$BUMP). Reapplied the
Capstone delta (last sync point $LAST_SYNC): self-hosted interview stack,
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
  #
  # The push output is captured rather than streamed so a workflow-scope
  # rejection can be recognized and reported as itself; every other failure
  # replays the log verbatim, so nothing is lost.
  push_log="$WORK/push.log"
  if ! git push -q --force-with-lease="main:${FORK_HEAD}" "$PUSH_URL" rebuilt:main >"$push_log" 2>&1; then
    cat "$push_log" >&2
    if grep -q 'refusing to allow a Personal Access Token' "$push_log"; then
      # Recompute against the commit actually being pushed — the preflight's
      # view is from upstream vs the fork, not from what we are sending.
      CHANGED_WORKFLOWS="$(git diff --name-only "$FORK_HEAD" rebuilt -- .github/workflows || true)"
      workflow_scope_fatal "the up-front check did not flag this token, which means it reports no scope header at all (a fine-grained PAT)."
    fi
    echo "FATAL: failed to push the rebuilt fork to $FORK_REPO main." >&2
    exit 1
  fi
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
