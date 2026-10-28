# Publishing the container image

This repository is a fork of `diegosouzapw/OmniRoute`, and it publishes under its own
namespaces — the upstream ones reject this fork's credentials, so a workflow that still
names them can only fail at the login or push step.

| Workflow | Registry | Image | Runs on |
| --- | --- | --- | --- |
| `.github/workflows/publish-image.yml` | GHCR | `ghcr.io/innotelinc/omniroute` | manual dispatch |
| `.github/workflows/docker-publish.yml` | Docker Hub | `innotel/omniroute` | push to `main` / `release/v*` / `v*` tags, published releases, manual dispatch |

Both also push to `ghcr.io/innotelinc/omniroute`; `docker-publish.yml` builds
`linux/amd64` and `linux/arm64` and merges them into one manifest.

## Credentials

`docker-publish.yml` logs in with two repository secrets:

- `DOCKERHUB_USERNAME` — `innotel`
- `DOCKERHUB_TOKEN` — a Docker Hub personal access token with read/write scope

The same pair publishes `innotel/orion`. The canonical copy of both values lives in the
Cerulean vault (`cerulean/data/orion`), so rotating them there and re-setting the repo
secrets is a single, reviewable step. GHCR needs no secret: it logs in with
`github.actor` and the workflow's own `GITHUB_TOKEN` (`packages: write`).

## Why login comes first

In both `docker-publish.yml` jobs the two login steps run *before* `Set up Docker
Buildx`. The `docker-container` driver copies the client's docker config into the
builder at create time, so a builder created first keeps resolving base images
anonymously — the login that runs a second later reports success, but
`load metadata for docker.io/library/node:26-trixie-slim` still comes back
`429 Too Many Requests` from the runner's shared IP. Authenticating first makes the
build pull as `innotel`, which is the account quota rather than the anonymous one.

`innotel/orion` publishes the same way with the same secrets.

## Pull budget

The account gets **200 authenticated pulls per rolling hour**, shared by every
repository that publishes with it. A cold multi-stage build (four targets × two
architectures) spends a slice of that, so overlapping publishes — or a few rapid
re-runs — can drain the hour and make the next build fail at its very first step:

```
#3 ERROR: unexpected status from HEAD request to
https://registry-1.docker.io/v2/library/node/manifests/26-trixie-slim: 429 Too Many Requests
```

That message is the quota, not the credentials; the response headers say so
(`ratelimit-limit: 200;w=3600`, `ratelimit-remaining: 0;w=3600`) while anonymous
requests from the same runner still succeed. Two guards sit in front of it: a
`concurrency` group so one publish per ref runs at a time, and a
`Wait for Docker Hub pull quota` step that retries the probe every minute for 20
minutes before giving up with an explicit message.

## Publishing on demand

`workflow_dispatch` takes a `version` input and checks out `refs/tags/v<version>`, so the
tag must already exist:

```bash
gh workflow run docker-publish.yml --ref main -f version=3.8.50
```

A version tag that already exists on Docker Hub is skipped (`docker manifest inspect`);
the floating `main` / `next` channels are always rebuilt.

## How a bad state looks

- **Login fails** — `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` missing or stale.
- **`npm ci` reports `Missing: … from lock file`** — the ref being built has a lockfile
  that disagrees with its `package.json`. That is a property of that tag, not of the
  workflow; build a ref whose lock is current.
- **`denied: requested access to the resource is denied`** — the workflow is still
  pointing at a namespace the credentials cannot write to.
- **`429 Too Many Requests` in `Build and push … by digest`** — Docker Hub refused
  base-image resolution. Two causes, both covered above: the account's hourly pull
  budget is spent (headers show `ratelimit-remaining: 0`), or — if this happens even
  though `Login to Docker Hub` reports success — the builder was created before the
  login, so it pulls anonymously; check that the login steps still precede
  `Set up Docker Buildx` in both jobs.
- **`429 Too Many Requests` from `registry-1.docker.io` in `Create Docker Hub manifest`** —
  Docker Hub throttled the burst of manifest HEADs. The images are already pushed at this
  point; the merge now retries with backoff (20s, 40s, 80s) instead of failing the run.
