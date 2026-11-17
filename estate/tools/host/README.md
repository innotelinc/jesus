# Host tools

Scripts that live on the estate hosts under `/usr/local/bin` and
`/etc/systemd/system`, kept here because a rebuilt host loses them and nothing
else recorded what they did.

| file | runs on | what it does |
|---|---|---|
| `cpk-limits-guard.sh` + `.service` + `.timer` | i1 | every 2 min, re-assert `limits.memory` on the CopilotKit container — currently a no-op that says so once, because the instance is gone |

## Re-applying after a rebuild

```sh
cd estate/tools/host
sudo ./install.sh --check      # syntax, and what the script would do
sudo ./install.sh              # install, enable the timer, run one pass
```

`install.sh` is idempotent: it replaces the files, `daemon-reload`s, enables the
timer and runs a single pass. Overrides are environment variables, not edits:
`CPK_WANT` (default `10GiB`), `CPK_REMOTE` (default `i2`), `CPK_INSTANCE`
(default `copilotkit`).

## Why this one is versioned and the others are not

`cpk-limits-guard` earned its place here by failing loudly: it addressed the
`i2move` remote, which exists on i4 rather than on i1, and because the incus CLI
prints that error on *stdout*, the script's `$(… 2>/dev/null || true)` captured
the error text as the current limit and called `config set` anyway — a failure
every two minutes, for as long as the instance has been gone.

The rest of the host tooling is still unversioned and larger than this one
directory: `incus-rebalance`, `incus-migrate-safe`, `incus-guard`,
`swap-ceiling-check`, `estate-checks/`. [`docs/incus-rebalance.md`](../../../docs/incus-rebalance.md)
describes what they do and where they live; versioning them is the obvious next
step, not a thing to assume is done.
