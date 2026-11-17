# incus-rebalance: the thing that sizes every container

`/usr/local/sbin/incus-rebalance` on **i4** rewrites `limits.memory` on running
incus containers across the estate every few minutes. It is the reason a cap
measured this morning can be gone this afternoon, and until now nothing in this
repository described it. The source is ~470 lines of Python 3 with a docstring
that states the intent better than any summary:

> Why this exists: the caps were set by hand from a snapshot in time. A container
> that was busy that day kept a generous cap forever, while one that grew later
> kept dying at a ceiling nobody revisited. The caps are the one thing that has
> to follow reality on its own.

It runs from `incus-rebalance.timer` → `incus-rebalance.service`, whose
`ExecStart` is `/usr/local/sbin/incus-rebalance --apply`. **Dry run is the
default**; only `--apply` writes.

## 1. One pass

Per host in the policy, and per **running** container in every project on that
host:

1. `incus query <host>:/1.0/resources` for the host's real RAM, then
   `budget = total × budget_pct` (i1 and i2 90%, i4 93%).
2. `incus exec` into the container to read `memory.current` and `memory.peak`
   from its cgroup — the guest's own numbers, not the host's accounting.
3. Read the current `limits.memory`.
4. Propose a demand (§2), then clamp it to the host budget (§3).
5. Decide one action per container (§4) and write only the ones that change.

## 2. The demand formula

```
demand = round_up_to_128MiB( clamp( max(peak × 1.2 + 64, current × 1.35 + 64),
                                    floor, ceiling ) )
```

`floor` is `max(256 MiB, current × 1.35 + 64)` — a container is never proposed
less than a third above what it is using right now — and is raised further by a
policy `min`. `ceiling` is `max_mib` (8192) unless a policy `max` lowers it.
Both factors and the step come from the policy file.

The two readings serve different jobs: `peak` catches a container that was busy
between passes, `current` keeps an idle one from being pinned low just because
this sample was quiet.

## 3. Fitting the budget

`budget_pct` of the host's RAM is the allowance for all movable caps together,
plus any pinned caps that are not `budget_exempt`.

If the proposals do not fit, **only raises are trimmed**, and never below the
cap a container already holds. A container asking for more is never the one that
gets less, and an idle container's reduction is what creates the room. Anything
still over budget is logged and left in place:

```
note: proposals still total 8128 MiB against a 7618 MiB budget; the rest is overcommit, left as is
```

That line is the honest signal that a host is oversubscribed by policy rather
than by accident.

## 4. When it writes

| action | meaning | writes |
|---|---|---|
| `set` | container is uncapped; give it the demand | yes |
| `raise` | demand is more than a full step above the cap | yes |
| `keep` | demand is at or above the cap, but not a step above | no |
| `hold (deadband)` | demand is lower, but still ≥ `lower_factor` × cap | no |
| `hold 2/3` | demand is low enough, but has been for fewer than `stability_runs` passes | no |
| `lower` | demand is low, and has stayed low for `stability_runs` passes | yes |

The asymmetry is deliberate. A raise needs a *full step* above the cap, so
rounding noise cannot ratchet a cap upward every pass; a lower needs several
consecutive quiet passes, so one idle minute cannot shrink a production
container. With the policy on i4 (`lower_factor` 0.75, `stability_runs` 3), a
cap only comes down after the demand has sat below three-quarters of it for
three passes in a row.

## 5. The policy file

`/etc/incus-rebalance.json`, merged over the built-in defaults, which are:

```json
{
  "budget_pct": 90,
  "raise_factor": 1.35,
  "peak_factor": 1.2,
  "lower_factor": 1.0,
  "stability_runs": 1,
  "step_mib": 128,
  "min_mib": 256,
  "max_mib": 8192,
  "hosts": {
    "i1": {"remote": "i1move"},
    "i2": {"remote": "i2move"},
    "i4": {"remote": ""}
  },
  "containers": {},
  "project_defaults": {}
}
```

`hosts[*].remote` is the incus remote the pass uses from i4: `i1move` and
`i2move` are TLS remotes that exist **on i4**, and `i4` uses the local socket
(empty string). A remote that does not exist makes that whole host report
`unavailable` and be skipped, with the pass exiting non-zero.

Per-container entries are keyed `host:name`, or `host:project:name` when the
project is not `default`, and may contain:

- `min` — a floor the allocator will not go below (a deliberate reservation);
- `max` — a ceiling below `max_mib`;
- `pinned` — hold a fixed cap and stop rebalancing it; `null` means *uncapped*;
- `budget_exempt` — keep a pinned cap out of the host budget arithmetic (lab and
  session sandboxes, sized for what they might do rather than what they idle at).

`project_defaults` covers every container of a project with no more specific
entry. Precedence is `host:project:name` → `host:name` → `host:project`.

## 6. State, lock, logs

- **State**: `/var/lib/incus-rebalance/state.json` keeps `lower_streak`,
  `limit_mib` and `changed_at` per container — the memory that makes
  `stability_runs` mean anything across passes.
- **Lock**: `/var/lib/incus-rebalance/lock` (an `flock`), so a slow pass is
  never overlapped by the next timer tick; the second one logs
  `another pass is running; skipping`.
- **Log**: `/var/log/incus-rebalance.log` and stdout → journald.
- **Exit**: 0 on a clean pass, 1 if any host or container could not be measured
  or written, 2 for unusable policy JSON or an unknown `--host`.

Paths can be redirected with `INCUS_REBALANCE_POLICY`, `INCUS_REBALANCE_STATE`
and `INCUS_REBALANCE_LOG`.

## 7. Running it by hand

```sh
incus-rebalance                 # dry run, every host in the policy
incus-rebalance --host i4       # dry run, one host
incus-rebalance --apply --host i4
journalctl -u incus-rebalance --since -10min
```

A pass on i4, 2026-11-17 00:47 EST, mid-migration:

```
i4: 8192 MiB host, 7618 MiB budget, 4 container(s)
  proxy                    use  4370 MiB  peak  5504  limit    5504  want  5504  keep
  telno                    use   183 MiB  peak   587  limit     768  want   768  keep
  telno-turn               use    82 MiB  peak   537  limit     640  want   640  keep
  vpn                      use   103 MiB  peak   458  limit     768  want   640  hold (deadband)
pass complete: 0 change(s), 3 held, 0 failure(s)
```

## 8. What it does not do

- **It does not touch `limits.memory.swap`.** Swap is set by hand or by other
  automation; `ontrak` carries `limits.memory.swap: 2GiB` while `proxy` has
  `false`, and no pass explains either.
- **It only sizes running instances.** A stopped container keeps whatever cap it
  had when it stopped, and is not counted against the budget.
- **It does not move instances or rename them.** That is
  `/usr/local/sbin/incus-migrate-safe`, a separate tool (§9).
- **It does not know that a container moved.** Policy keys carry the host name,
  which brings us to the finding below.

## 9. Findings, 2026-11-17

**Policy entries go stale when an instance moves, silently.** The file on i4
still says `"i2:proxy": {"min": "4GiB"}` while `proxy` now runs on **i4**, where
that key never matches. The same is true of `i1:monarch`, `i1:atlas`,
`i1:blueprint` and the other `i1:` entries, whose instances have been migrated
to i2. Those entries are inert: the reservation they express is not being
applied anywhere. After any migration, re-key the policy — `i4:proxy`,
`i2:monarch` — or the allocator will size the container as if nobody had ever
asked for a floor.

**The estate was being migrated while this was written.**
`incus-migrate-safe` moves a stopped container's rootfs between hosts over rsync
and rebuilds the instance skeleton with `incus init --empty`; it was written on
2026-11-16 after `incus copy monarch i2:monarch` died at 13.6 of 25 GB with
`websocket: close 1006`. Hosts keep the source copy as a `<name>-retired`
rollback marker, so during a migration the same service exists twice under
different names, and a name is not a stable identifier for anything.

**A guard that depended on the wrong remote failed every two minutes.**
`cpk-limits-guard.timer` on i1 ran a script addressing `i2move:copilotkit`;
`i2move` exists on i4, not on i1, and because the incus CLI prints that error on
*stdout*, the script's `$(… 2>/dev/null || true)` captured the error text as the
current limit and called `config set` anyway. It now lists the remote's instances
first, exits 0 with one logged line when the instance is absent (it is — the
CopilotKit data was archived on 2026-11-14), and exits 1 only when a real write
fails.
