#!/bin/bash
# cpk-limits-guard - re-assert the CopilotKit container's memory limit.
#
# Rewritten 2026-11-17. The previous version had two faults:
#   * it addressed `i2move:`, a remote that exists on i4, not on this host, so
#     every pass died with `Error: The remote "i2move" doesn't exist`;
#   * it read the limit with `$(incus config get ... 2>/dev/null || true)`, and
#     the incus CLI prints that error on stdout, so `cur` became the error text
#     - non-empty and unequal to `want` - and the script called `config set`
#     anyway. That is why the unit failed instead of skipping.
#
# The instance is absent from the estate as of 2026-11-17: it exists on no incus
# host and not among the Docker containers in `workloads` on i1, and its data
# was archived as copilotkit-final-data-20261114.tgz. The correct behaviour is
# therefore to say so once and succeed. When the container is restored on
# CPK_REMOTE it is picked up again on the next pass.
#
# This host copy is versioned in the repository at estate/tools/host/; run that
# directory's install.sh to re-apply it after a rebuild.
set -u

want="${CPK_WANT:-10GiB}"
remote="${CPK_REMOTE:-i2}"          # a remote that exists on this host
instance="${CPK_INSTANCE:-copilotkit}"
stamp="/var/lib/cpk-limits-guard.last"

say() { logger -t cpk-limits-guard "$*"; echo "cpk-limits-guard: $*"; }

# Ask the host what it has, rather than trusting a name to resolve.
if ! listed=$(incus list "${remote}:" -c n -f csv 2>/dev/null); then
  say "cannot list ${remote}: - remote missing on this host? (incus remote list)"
  exit 1
fi

if ! printf '%s\n' "$listed" | grep -qx "$instance"; then
  msg="no instance ${instance} on ${remote}; nothing to guard"
  if [ "$(cat "$stamp" 2>/dev/null)" != "$msg" ]; then
    say "$msg"
    printf '%s' "$msg" > "$stamp"
  fi
  exit 0
fi
rm -f "$stamp"

cur=$(incus config get "${remote}:${instance}" limits.memory 2>/dev/null)
if [ -z "$cur" ]; then
  incus config set "${remote}:${instance}" limits.memory="$want" \
    && say "${instance}: uncapped -> ${want}" \
    || { say "failed to set ${want} on ${instance}"; exit 1; }
  exit 0
fi

if [ "$cur" != "$want" ]; then
  incus config set "${remote}:${instance}" limits.memory="$want" \
    && say "${instance}: limits.memory ${cur} -> ${want}" \
    || { say "failed to set ${want} on ${instance} (was ${cur})"; exit 1; }
fi
exit 0
