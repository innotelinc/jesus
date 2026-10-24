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
