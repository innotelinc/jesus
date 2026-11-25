# signara: the volume preflight gate

The gate lives in **`docker-compose.prod.yml` in the `innotelinc/signara` repository**
(commit `9966f4b`): a `volume-preflight` service runs `volume_preflight.sh` against the
host's volume directory and fourteen services wait for it with
`condition: service_completed_successfully`. A re-render that would start the stack on an
empty twin stops the deploy instead, with every running container left alone.

## Why it is in the repository, not in Coolify

Coolify renders `docker_compose_raw` **from the repository file** on every deploy. A compose
edit made in the UI — or written straight into the `applications` row — is replaced by the
repo's `docker-compose.prod.yml` before the deploy reaches the host. Measured 2026-11-25: a
byte-exact write of the gated compose into `docker_compose_raw` (md5 `5edec2d8…`) was back to
the repo bytes (`3560a089…`) by the time the deployment started, and the compose Coolify
built from had no `volume-preflight` service. The API also refuses the field outright
(`PATCH` with `docker_compose_raw` → `422 {"docker_compose_raw": ["This field is not allowed."]}`).

So the durable place for the gate is the repository, which also means
`docker compose -f docker-compose.prod.yml config` reviews it like any other change.

## The files here

| file | what it is |
| --- | --- |
| `docker-compose.preflight.yml` | the gated **render** — the reference for the intended effective config |
| `docker-compose.as-deployed.yml` | the render before the gate, kept for diffing and rollback |

Neither is applied by hand. To check a repo change, render the repo file and diff it against
`docker-compose.preflight.yml`; the only differences should be path prefixes and the gate.

## The host side

The preflight service bind-mounts `/usr/local/bin/volume-preflight.sh` read-only (source:
`../capstone/scripts/volume_preflight.sh`). It is installed on `i3-local` (`.53`) and today
reports `0 volume pair(s) checked`, because signara uses the single-form volume names — the
gate is there for the deploy that would introduce a twin.

## State when this was written

`api` was `Exited (1)` for two days with `PlaceholderSecretError: Refusing to start: this
deployment would run with default credentials` — `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and
`CRYPTO_MASTER_KEY` unset, and `DATABASE_URL` / `REDIS_URL` still resolving to `change-me`
because every env row in Coolify was an empty template row. Fixed by filling
`POSTGRES_PASSWORD` and `REDIS_PASSWORD`, creating the three secrets, and rotating the
`signara` postgres role to the new password so the existing `pgdata` volume keeps its data.
