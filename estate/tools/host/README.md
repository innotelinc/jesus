# Host tools

Scripts that live on the estate hosts under `/usr/local/sbin`, `/usr/local/bin`
and `/etc/systemd/system`, kept here because a rebuilt host loses them and
nothing else recorded what they did.

| tool | where | driven by | what it does |
|---|---|---|---|
| `incus-rebalance` | i4 | `incus-rebalance.timer`, 5 min | sizes every running container's `limits.memory` from measured use — [`docs/incus-rebalance.md`](../../../docs/incus-rebalance.md) |
| `incus-migrate-safe` | i1, i4 | by hand | paced, resumable move of a stopped container between hosts over rsync |
| `incus-guard` | i1, i4 | by hand, and by `incus-migrate-safe` | one lease per incus instance, so two agent sessions cannot both act on it |
| `swap-ceiling-check` | i1, i4 | `swap-ceiling-check.timer`, 10 min | flags an instance filling its enforced memory or swap ceiling; silent when comfortable |
| `cpk-limits-guard.sh` | i1 | `cpk-limits-guard.timer`, 2 min | re-asserts `limits.memory` on the CopilotKit container — a no-op today, because the instance is gone |

Plus `etc/incus-rebalance.json`, the allocator's policy, and the unit files.

## Re-applying after a rebuild

```sh
cd estate/tools/host
./install.sh --check      # syntax, and the plan for this host
./install.sh              # install, enable the timers, run one pass of each
```

`install.sh` takes the hostname and applies: every `sbin/` script to
`/usr/local/sbin` (the guard to `/usr/local/bin`, whose unit execs it from
there), every `systemd/` unit to `/etc/systemd/system`, every `*.d/*.conf` as a
drop-in for its unit, then the same for `hosts/<hostname>/` **on top**. The
policy is installed only when `/etc/incus-rebalance.json` is absent — a rebuilt
host needs one, a live host's re-keyed policy must not be replaced — and a
difference is reported instead of overwritten.

`hosts/<host>/timers` decides which timers that host runs, and `install.sh`
enables exactly those: i1 gets `cpk-limits-guard.timer` and
`swap-ceiling-check.timer`, i4 gets `incus-rebalance.timer` and the same check.
Enabling the rebalancer on a host that has no `i1move`/`i2move` remotes would
reproduce the failure this directory exists to prevent, so a host with no
`timers` file gets a warning and no timers at all.

## Hosts have diverged, deliberately recorded

`incus-guard` is identical on i1 and i4. Two others are not, and **i1 is ahead**:

- `swap-ceiling-check` — i1 reads the ceiling from the cgroup (`memory.max`,
  `memory.swap.max`). i4 still reads `incus config get`, which under
  `limits.memory.enforce: soft` programs no cap at all, so the older copy can
  report "122 % of ceiling" every ten minutes about a limit that is literally
  `max`. i1's own header explains the fix; it is not yet on i4.
- `incus-migrate-safe` — i1 routes the preflight through the same transport as
  the rsync (`ESTATE_SSH_PASS` / sshpass), so a destination that only has
  password auth survives the preflight, and it claims the lease after detaching
  so the process that does the work is the one holding it.

They live under `hosts/i1/` rather than being promoted to the shared `sbin/`,
because changing what runs on i4 is a deployment decision, not a side effect of
versioning. Promoting them means copying the file into `sbin/` and re-running
`install.sh` on i4.

i1 also carries `swap-ceiling-check.service.d/10-notify.conf`
(`OnFailure=estate-notify@%n`), which the shared unit deliberately omits: the
check exits 1 on a standing condition, so a notification on every run is
wallpaper. That file was host-only until today and is now in `hosts/i1/systemd/`.

## Still not here

`edge-liveness`, `agent-reaper`, `estate-checks/` and `incus-lifecycle-watch` on
i4, and the `vault-*` and `regcache-credential` timers, are still host-only. The
`estate/tools/host/` layout has room for them; nothing about it is specific to
the five above.
