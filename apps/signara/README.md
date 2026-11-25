# signara compose: the volume preflight gate

`docker-compose.preflight.yml` is signara's Coolify render with one addition: a
`volume-preflight` service that runs `volume_preflight.sh` against the host's volume
directory and fails the deploy when a live (dash-form) Coolify volume is a fraction of its
sibling. Fourteen services depend on it with
`condition: service_completed_successfully`, so a bad re-render stops the stack instead of
starting it on empty data. `docker-compose.as-deployed.yml` is the render before the change,
kept for diffing.

The check itself lives in `../capstone/scripts/volume_preflight.sh`; it is installed on the
host at `/usr/local/bin/volume-preflight.sh` (that path is bind-mounted read-only into the
service). Today it reports `0 volume pair(s) checked` on `i3-local`, because signara uses the
single-form volume names — the gate is there for the deploy that would introduce a twin.

## Applying it

Coolify's API will not take a compose edit for an application (`PATCH` with
`docker_compose_raw` answers `422 {"docker_compose_raw": ["This field is not allowed."]}`;
only `docker_compose_domains` is writable). Paste it in the UI instead:

1. Coolify → the `signara` application → **Configuration → Docker Compose**.
2. Replace the contents with `docker-compose.preflight.yml`.
3. **Save**, then **Deploy**. The `volume-preflight` container logs
   `volume-preflight: N volume pair(s) checked` and every other service waits for it.

Rollback: paste `docker-compose.as-deployed.yml` back and redeploy; a backup taken at the
time of the change is also in `/root/pbx-vol-backup/signara-compose-before-preflight-*.yml`
on the operator host.

## State when this was written

signara is `degraded:unhealthy` on its own: `api-…` exited 1 two days ago, `frontend-…` sits
in `Created`, and `postgres`/`backup`/`prometheus` are up. The preflight does not fix that —
deploying it also pulls a fresh `api`, which is worth watching rather than assuming.
