# Retired

Files the estate has deliberately stopped running. They are kept, not deleted, so
that the next reader can see what was removed and why — and so a retirement can be
undone without reconstructing anything.

`timers` is the machine-readable half: `install.sh` disables every timer named there
on every host, so a retirement recorded here actually takes effect rather than only
being a note. It is checked *after* the declared timers are enabled, so a host that
still lists a retired timer in `hosts/<host>/timers` does not win.

## `cpk-limits-guard` (retired 2026-11-17)

`cpk-limits-guard.sh` re-asserted `limits.memory` on the `copilotkit` container every
two minutes. `copilotkit` exists on no host — not as an incus instance on i1, i2 or
i4, and not among the twelve running or twenty-one total Docker containers in
`workloads`; its data was archived as `copilotkit-final-data-20261114.tgz`. So the
timer ran 720 no-op cycles a day for an instance that is gone.

It is not only waste. The tool once failed every two minutes for a day because
`$(incus config get i2move:c opilotkit limits.memory 2>/dev/null || true)` captured
the CLI's *stdout* error text as the limit and then ran `config set` against a remote
that does not exist; the steady failure was invisible against a background of
steady no-ops. A timer nobody retires stops being a signal and becomes the noise
that hides one.

What was left in place: the installed copies under `/usr/local/bin` and
`/etc/systemd/system` on i1 and i4. Only the timer is stopped and disabled, so the
unit can be re-enabled by hand if `copilotkit` ever returns — but nothing will
quietly start it again.

## `media-orphans` (retired 2026-11-18)

`media-orphans.service` runs `incus exec monarch -- sh -s < /usr/local/sbin/media-orphans.sh`
to list library files no Sonarr/Radarr record claims. `monarch` is no longer an
instance on i1: `incus list local:` on 2026-11-18 shows `monarch-retired`, STOPPED
(created 2026/09/12). The check's subject was retired under it, so the unit now
fails before it can look at anything — 2026-11-15 08:23 `Error: Instance is not
running`. Its last real attempt, 2026-11-16 04:32, got as far as `sonarr: 24 path(s)
claimed` and `radarr: 23 path(s) claimed` and then stopped at `CANNOT RUN: lidarr API
did not answer at http://127.0.0.1:8686/api/v1/artist`, because the *arr stack went
with the instance.

Only the timer is disabled; the unit and script stay where they are. If the media
library is rebuilt under a live instance, point `ExecStart` at it, re-enable the
timer and delete this entry — the check itself was sound, it just has nothing left
to check.

## `regcache-credential` (retired 2026-11-18, un-retired the same day)

Kept here as the record, but **not** in `timers`: this one came back.

`regcache-credential.service` asks Docker Hub for a token for `library/alpine` and
reads `toomanyrequests` out of the registry log, so an expired Hub token cannot hide
behind a cache that keeps serving. It runs `incus exec regcache -- docker …`, which
is what made it fail: the cache is not on i1. `incus list local:` on i1 shows
`regcache` STOPPED (last used 2026/11/16 02:18, storage mount deactivated 09:58 and
10:00, no `user.estate.*` note), while `incus list i2:` shows it RUNNING with the
`registry` container up and serving `192.168.1.79:5000`. The stopped i1 instance is
the leftover; the live one was always a remote away.

That also explains the two symptoms that looked like a dead credential. The runs of
2026-11-15 and 2026-11-16 both logged `hub token request: HTTP 200, pull_limit
200/6h` and exited 1 only because uncached pulls had already hit the anonymous limit
(2, then 1, in 24 h); from 2026-11-17 the run was `CANNOT RUN: no container registry
in regcache`, i.e. the local subject. Pointed at the instance that exists —
`INCUS=i2:regcache /usr/local/sbin/regcache-credential-check.sh` — it exits 0:
`the token authenticates and no uncached pull failed on the anonymous limit in the
last 24h`.

The retarget is versioned, not hand-placed:
`hosts/i1/systemd/regcache-credential.service.d/10-remote.conf` sets
`Environment=INCUS=i2:regcache`, and `install.sh` installs drop-in fragments from
`systemd/<unit>.d/*.conf` and `hosts/<host>/systemd/<unit>.d/*.conf`.

The unit files themselves still live in `innotelinc/innotel-platform-stack`, installed
by its `install-estate-checks.sh`, which does not read this list; the drop-in is what
survives that installer re-running.

The stopped copy that made this look broken is gone: by 2026-11-18 i1 listed only its
seven running instances (`atheniq, genesis, mail, ontrak, onyx, vault, workloads`) and
`incus exec regcache` there answers `Error: Instance not found`. There is nothing left
to rename or retire, so the dead target cannot come back into play by accident — and if
the drop-in is ever lost, the failure is a missing instance rather than a stopped one
that answers with a misleading message.
