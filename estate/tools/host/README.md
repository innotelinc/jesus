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
| `estate-state` | i1, i4 | `estate-state.timer`, weekly | records *why* an instance is stopped, in the instance (`user.estate.*`), and reports stops nobody explained |
| `estate-health` | i1, i4 | by hand | one screen: host memory/swap/pressure, then every instance's pin, working set and swap |
| `estate-sample` | i1, i4 | `estate-sample.timer`, 1 min | one row per instance per minute for a day, in `/var/lib/estate-samples/<host>.tsv` |
| `estate-timer-audit` | i1, i4 | `estate-timer-audit.timer`, daily | lists timers that are retired, targetless, silent, failing-every-run or idle |
| `incus-lifecycle-watch.service` | i1 | `multi-user.target` | streams incus lifecycle events with their requestor to `/var/log/incus-lifecycle.jsonl` |

Plus `etc/incus-rebalance.json`, the allocator's policy, and the unit files.
`retired/` holds what the estate has stopped running — see its README, and
`retired/timers`, which the installer enforces.

## Re-applying after a rebuild

```sh
cd estate/tools/host
./install.sh --check      # syntax, the plan, and drift from the last install
./install.sh --verify     # drift only; exit 1 if a managed file is not what it should be
./install.sh              # install, record a manifest, set the timers, run one pass of each
```

`install.sh` takes the hostname and applies: every `sbin/` script to
`/usr/local/sbin` (any file named `cpk-limits-guard.sh` would go to
`/usr/local/bin`, whose unit execs it from there), every `systemd/` unit to
`/etc/systemd/system`, every `*.d/*.conf` as a drop-in for its unit, then the same
for `hosts/<hostname>/` **on top**. The policy is installed only on the host that
declares `incus-rebalance.timer`, and then only when `/etc/incus-rebalance.json` is
absent — a rebuilt host needs one, a live host's re-keyed policy must not be
replaced — and a difference is reported instead of overwritten. A host that does
not run the allocator gets no policy at all, so a stale one cannot be mistaken for
a live configuration.

`hosts/<host>/timers` decides which timers that host runs, and `install.sh` acts in
both directions: it enables exactly those, and **disables** any timer it installs
that the host no longer declares. i1 runs `estate-sample`, `estate-state`,
`estate-timer-audit` and `swap-ceiling-check`; i4 runs those plus `incus-rebalance`
and `estate-edge`.

A host with no `timers` file is treated as *unknown*, not as *declares nothing*: it
gets a warning, no timers are enabled, and **nothing repo-managed is disabled
either**. The distinction matters because the disable direction is destructive — a
rebuilt host, or one whose hostname does not match a `hosts/<host>/` directory yet,
would otherwise have every timer this script had just installed switched off,
including the allocator on i4. Only `retired/timers`, an estate-wide decision, is
enforced regardless of what a host declares.

## Every install leaves a manifest

`/var/lib/estate-host-tools/manifest.tsv` records `md5`, path and time for every file
installed. Versioning a tool stops it being *lost*; it says nothing about a host
where somebody edited the installed copy during an incident — which is exactly how
i1 came to run two tools that differed from i4's for weeks, found only by comparing
md5s by hand. `--verify` compares three things and names which is wrong:

| line | meaning |
|---|---|
| `EDITED` | the file changed on this host since it was installed |
| `PENDING` | the repo has moved; `./install.sh` would update it |
| `MISSING` | recorded, but no longer on disk |
| `ORPHAN` | installed once, no longer in the repo |
| `NEW` | in the repo, never installed here |

Checked on 2026-11-17 by appending a comment to an installed `estate-health` on i4:
`--verify` reported `EDITED` and exited 1, and re-running `install.sh` restored it
and verified clean.

## Hosts have diverged, deliberately recorded

`incus-guard` is identical on i1 and i4. Two others are not, and **i1 is ahead**:

- `swap-ceiling-check` — i1 reads the ceiling from the cgroup (`memory.max`,
  `memory.swap.max`). i4 still reads `incus config get`, which under
  `limits.memory.enforce: soft` programs no cap at all, so the older copy can
  report "122 % of ceiling" every ten minutes about a limit that is literally
  `max`.
- `incus-migrate-safe` — i1 routes the preflight through the same transport as the
  rsync (`ESTATE_SSH_PASS` / sshpass), so a destination that only has password auth
  survives the preflight, and it claims the lease after detaching so the process
  that does the work is the one holding it.

They live under `hosts/i1/` rather than being promoted to the shared `sbin/`,
because changing what runs on i4 is a deployment decision, not a side effect of
versioning. `hosts/i1/pins` now records that decision as data: each line names a
tool and the md5 of `sbin/<tool>` when the override was last reviewed, and
`--verify` reports `STALE` when the shared copy moves — the moment to read both
and decide. Promoting them means copying the file into `sbin/`, updating the pin,
and re-running `install.sh` on i4.

i1 also carries `swap-ceiling-check.service.d/10-notify.conf`
(`OnFailure=estate-notify@%n`), which the shared unit deliberately omits: the
check exits 1 on a standing condition, so a notification on every run is
wallpaper.

## Tests

```sh
./test/run.sh        # Linux; no incus daemon, no container, no network needed
```

`estate-timer-audit` flags a *silent* timer only when the unit lives under
`/etc/systemd/system` — that is, when the estate installed it. A vendor timer that
has not fired yet is waiting for its condition (`apport-autoreport`, `mdcheck_*`,
`ua-timer`), and reporting it as abandoned is how an audit becomes noise. Failing
vendor timers are still flagged: those are broken, not idle.

`test/fake-incus` is a CLI double backed by a directory of `state=` files. The
cases cover the two tools that can actually lose something — `incus-guard`'s lease
semantics (second claim refused with 75, expired lease reclaimable, `run` releases)
and `incus-migrate-safe`'s refusals (no arguments, an instance that does not exist,
a RUNNING instance) — plus `estate-state`'s record/report/clear cycle, the
sampler's ring buffer, and a `--check` of this checkout. 32 assertions;
ShellCheck alone never looked at any of this, and i1's copies diverged while it was
the only gate.

## Versioned elsewhere, not here

The estate's other host tooling is **not** missing: it is versioned in
[`innotelinc/innotel-platform-stack`](https://github.com/innotelinc/innotel-platform-stack)
under `scripts/` and `systemd/`, deployed to `/opt/innotel/` and `/etc/systemd/system`
on the hosts, with `scripts/install-estate-checks.sh` as the entry point. That
covers `edge-liveness`, `agent-reaper`, `estate-checks` (a 60-file, ~22k-line check
suite), `vault-disk-health`, `vault-replica-sync`, `vault-ro-mount`,
`regcache-credential-check` and their units. Copying them here would give the estate
two sources of truth for the same files, which is worse than the gap it would close.
`incus-lifecycle-watch.service` had no home at all and is versioned here.

Not audited: the rest of `/usr/local/{sbin,bin}` on i1 and i4 (`memguard.py`,
`dns-secondary-sync.sh`, `gateway-usage-sync`, `coursemate-*`, `stalwart-oidc-*`,
`media-*`, `monarch-*`, `boot-report.sh`, `incus-*-firewall`, `estate-notify.sh`).
Some are certainly in platform-stack's `scripts/`; nothing here claims whether each
one is or is not.

## Exercised on i1 and i4, 2026-11-17

`install.sh` completed on both hosts; `--verify` came back clean on both (20 files
recorded on i1, 19 on i4); each host enabled exactly its declared timers and left
the others installed-but-disabled; i4's live policy kept its md5 and mtime and i1
was left without one; `cpk-limits-guard.timer` was retired on i1 (with its 720
no-op runs a day) and left disabled on i4. `estate-state` then recorded why
`ontrak` and `genesis` are stopped, and `estate-sample` had written 48 rows for i1
within ten minutes of the timer starting.
