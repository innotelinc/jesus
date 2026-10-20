# Innotel Bulwark deployment

Bulwark for https://mail.innotel.us, running in the `mail` Incus container on
`i3` next to Stalwart. The compose file in this directory is the source of
truth for `/opt/bulwark/docker-compose.yml`; the real `.env.local` stays on
the host and is never committed.

| | |
|---|---|
| Image | `ghcr.io/innotelinc/webmail:1.16.0-sso` |
| Digest | `sha256:f0769ede7344a17f5204ea9600969b8407fc0364119e9292c162881d5630deb6` |
| Source | `innotelinc/webmail` `06cb08b` — 1.16.0 plus the multi-account SSO fix |
| Image labels | `org.opencontainers.image.version=1.16.0`, `…revision=06cb08b` |
| Rollback image | `ghcr.io/innotelinc/webmail:1.15.0` |
| Published at | `/opt/bulwark/docker-compose.yml`, port `3000` |
| Registry access | private GHCR package; the host must be logged in to pull |

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | The deployed compose file (pinned image, volumes, healthcheck) |
| `Dockerfile.runtime` | Runtime image assembled from a prebuilt standalone output |
| `.env.local.example` | The keys this deployment sets; values come from Vault |

## Image build

`next build` OOM-ed inside the mail container while it was capped at 1 GiB, so
this deployment builds the standalone output on its own and packages it with a
small runtime Dockerfile instead of the repository's multi-stage `Dockerfile`.
The runtime image is based on `node:24-alpine` (Next 16.3.8) and has npm/npx
removed; the healthcheck uses busybox `wget`.

Build the standalone output from the commit you are deploying:

```sh
cd bulwark-src
npm ci
npx next build --webpack
```

Run this with the `mail` container at its current 4 GiB limit. If the build is
OOM-killed, build on a larger host (or stop Stalwart for the duration) — the
result is just `.next/standalone`, `.next/static` and `public`.

Assemble the Docker build context. `Dockerfile.runtime` expects exactly this
layout:

```sh
rm -rf /tmp/bulwark-runtime
mkdir -p /tmp/bulwark-runtime/.next
cp -a .next/standalone /tmp/bulwark-runtime/.next/standalone
cp -a .next/static /tmp/bulwark-runtime/.next/static
cp -a public /tmp/bulwark-runtime/public
```

Build, verify the labels, and push. Use a new tag for every build; do not
overwrite a tag that a host is running:

```sh
docker build -f deploy/innotel/Dockerfile.runtime \
  --build-arg APP_VERSION="$(cat VERSION)" \
  --build-arg GIT_COMMIT="$(git rev-parse --short HEAD)" \
  -t ghcr.io/innotelinc/webmail:<tag> /tmp/bulwark-runtime
docker push ghcr.io/innotelinc/webmail:<tag>
```

The 1.16.0-sso image was built from commit `06cb08b` with
`APP_VERSION=1.16.0`.

## Deploy / upgrade

```sh
docker login ghcr.io              # once per host; package is private
install -m 0644 docker-compose.yml /opt/bulwark/docker-compose.yml
cd /opt/bulwark
docker compose pull
docker compose up -d
```

`docker compose pull` is required: `up -d` alone will keep the image already
tagged locally. Confirm the new container is healthy and actually running the
new digest:

```sh
docker ps --filter name=bulwark
docker image inspect ghcr.io/innotelinc/webmail:<tag> \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
docker logs bulwark 2>&1 | grep 'Bulwark Webmail v'
curl -fsS https://mail.innotel.us/api/health
```

Expected: `healthy`, revision `06cb08b`, `Bulwark Webmail v1.16.0`, and
`{"status":"healthy",...}`.

## Verify the add-account SSO fix

The login page in add-account mode (`/login?mode=add-account`) must send both
prompt values. Authentik ignores `select_account` and honours `login`, so the
combination forces its login flow instead of silently reusing the current IdP
session:

```sh
curl -sS -X POST https://mail.innotel.us/api/auth/sso/start \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://mail.innotel.us' \
  --data '{"redirect_uri":"https://mail.innotel.us/auth/sso/callback","add_account":true}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["authorize_url"])'
```

The URL must contain `prompt=select_account+login`; a normal sign-in request
must not contain `prompt` at all. In a browser, `/login?mode=add-account` shows
"Add Account" and the SSO button lands on Authentik's identification stage with
the prompt intact.

## Rollback

`1.15.0` is the last pre-fix image and is kept in the registry for this purpose.
Change the `image:` line to `ghcr.io/innotelinc/webmail:1.15.0`, then:

```sh
cd /opt/bulwark
docker compose pull
docker compose up -d
```

The compose file that was live before the 1.16.0 deploy is also kept on the
host as `/opt/bulwark/docker-compose.yml.bak-20261019`.

## Volumes and data

| Volume | Mount | Contents |
|---|---|---|
| `bulwark-settings` | `/app/data/settings` | Encrypted per-user settings |
| `bulwark-config` | `/app/data/admin` | Admin config, password hash, plugins, themes, branding |
| `bulwark-state` | `/app/data/admin-state` | Admin runtime state, audit log, setup token |
| `bulwark-telemetry` | `/app/data/telemetry` | Instance id, consent state, login HMACs |

The volumes are not in the image. A host rebuild needs both the volumes and
`/opt/bulwark/.env.local`; keep the env values in Vault and back up the volumes
before replacing the host.
