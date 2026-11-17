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
