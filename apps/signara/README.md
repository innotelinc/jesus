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

## Build in GitHub, not on the host

A Coolify deploy of this app builds `api` and `frontend` **from source on `i3`**: the
frontend `npm ci` alone takes six minutes and a full deploy took about 1h20m on 2026-11-25.
Deploys should instead pull images built in CI — GitHub Actions publishing
`ghcr.io/innotelinc/signara-api` and `-web` per commit — so a deploy is a pull plus a restart,
and a bad build fails in the pipeline instead of tying up the host that runs the stack.

## State when this was written

`api` had been `Exited (1)` for two days with `PlaceholderSecretError: Refusing to start: this
deployment would run with default credentials` — `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and
`CRYPTO_MASTER_KEY` unset, and `DATABASE_URL` / `REDIS_URL` resolving to `change-me` because
every env row in Coolify was an empty template row. Filled `POSTGRES_PASSWORD` and
`REDIS_PASSWORD`, created the three secrets, and rotated the `signara` postgres role to the
new password so the existing `pgdata` volume keeps its data. The api now boots and maps every
route, then stops at the **object store**: `getaddrinfo EAI_AGAIN minio`.

That is the storage profile, not a regression: `minio` is profile-gated (`legacy-storage`)
because the live store is meant to be onyx-objectstore, and `SIGNARA_S3_*` is still empty, so
the api falls back to `http://minio:9000` with nothing behind it. The documented endpoint
`http://192.168.1.71:2090` is not listening; `192.168.1.60:2090` and `:2091` answer `401`, so
the store is there and what is missing is a credential for it. Until `SIGNARA_S3_ENDPOINT`,
`SIGNARA_S3_ACCESS_KEY` and `SIGNARA_S3_SECRET_KEY` are set, `api` — and therefore `frontend`,
which waits for it to be healthy — stays down.
