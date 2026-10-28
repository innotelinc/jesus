#!/usr/bin/env bash
# Cantus — one-shot bootstrap: install the attribution guard hooks.
#
# The reference stack needs no dependencies: Perl 5 core only. This script
# exists so a fresh clone enforces the same commit policy as the rest of the
# portfolio without anyone having to remember a config command.
set -euo pipefail

APP="cantus"
echo "==> ${APP} bootstrap"

if [ -d .githooks ]; then
  git config core.hooksPath .githooks
  # Hooks are only honoured when they are executable — a checkout that lost the
  # bit (a Windows add without --chmod=+x, a zip export) silently enforces
  # nothing, so fix it here rather than trusting the checkout.
  chmod +x .githooks/commit-msg .githooks/pre-commit 2>/dev/null || true
  echo "==> attribution guard hooks installed (.githooks)"
else
  echo "!! .githooks missing — the attribution guard is not installed" >&2
  exit 1
fi

# The full self-test scans a 300 KB input, which costs one process per line on
# MSYS/Cygwin shells and takes minutes; bound it and fall back to a two-way
# check that proves the same thing (it rejects, and it allows the policy's own
# signature) without the cost.
guard_ok=0
case "$(uname -s 2>/dev/null)" in
  MSYS*|MINGW*|CYGWIN*) : ;;   # one process per scanned line: skip the big case
  *) if command -v timeout >/dev/null 2>&1; then
       timeout 45 bash -c 'source .githooks/guard-lib && guard_selftest' >/dev/null 2>&1 && guard_ok=1
     fi ;;
esac
if [ "$guard_ok" -eq 1 ]; then
  echo "==> guard self-test passed"
else
  echo "==> guard self-test skipped (slow on this shell) — running the two-way check"
  if printf 'co-authored-by: Someone Else <else@example.com>\n' \
       | bash -c 'source .githooks/guard-lib && guard_check_stream' >/dev/null 2>&1; then
    echo "!! the guard accepted a foreign trailer" >&2
    exit 1
  fi
  if ! printf 'co-authored-by: Darnel Hunter <dhunter@innotel.us>\n' \
       | bash -c 'source .githooks/guard-lib && guard_check_stream' >/dev/null 2>&1; then
    echo "!! the guard rejected the policy's own signature" >&2
    exit 1
  fi
  echo "==> guard rejects foreign credit and allows its own"
fi

if ! command -v perl >/dev/null 2>&1; then
  echo "!! perl not found — install Perl 5.16 or newer" >&2
  exit 1
fi
echo "==> perl $(perl -e 'print $^V')"

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "==> .env copied from .env.example (only needed to operate a relay/node)"
fi

echo "==> done. Next: make test"
