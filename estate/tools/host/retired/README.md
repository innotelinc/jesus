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

## `regcache-credential` (retired 2026-11-18)

`regcache-credential.service` asks Docker Hub for a token for `library/alpine` and
reads `toomanyrequests` out of the registry log, so an expired Hub token cannot hide
behind a cache that keeps serving. It runs `incus exec regcache -- docker …`, and
`regcache` is STOPPED: last used 2026/11/16 02:18, its storage mount deactivated at
2026-11-16 09:58 and 10:00, and it carries no `user.estate.*` note, so nothing
recorded why. On 2026-11-18 `192.168.1.79` — the address the cache was published on —
answers a different MAC (`10:66:6a:59:3e:45`) than `regcache`'s own
(`10:66:6a:b7:4c:a2`), so a restart would come back on some other address than the
one consumers were pointed at.

The alarm is not a dead credential: the last two runs that could reach the registry,
2026-11-15 and 2026-11-16, both reported `hub token request: HTTP 200, pull_limit
200/6h`, and exited 1 only because uncached pulls had already hit the anonymous
limit (2, then 1, in 24 h). From 2026-11-17 the run is `CANNOT RUN: no container
registry in regcache` — the subject, not the token.

Re-enable this timer only after `regcache` is running again and its address is
settled, or the check will fail for the same reason it fails now. Until then the
`OnFailure=estate-notify@%n` path would page daily about a state a person already
knows; the state itself belongs in `estate-state note regcache` when someone decides
what the cache is for.

Note for both: the unit files for these two live in `innotelinc/innotel-platform-stack`
and are installed by its `install-estate-checks.sh`, which does not read this list.
If that installer re-enables them, the same two decisions have to be repeated
there.
