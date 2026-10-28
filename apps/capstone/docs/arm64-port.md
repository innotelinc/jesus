# ARM64 port plan

What it takes to run this stack on arm64 Linux — and what it still will not do
afterwards. Measured status comes from [`deploy/arm64-audit.py`](../deploy/arm64-audit.py);
re-run it before trusting this page.

> **Target assumption.** An **arm64 Linux host with 12–16 GiB RAM** (SBC,
> ARM server, or arm64 VM). A phone is not a valid target even after a perfect
> port: see [arm64.md](arm64.md#verdict-for-a-moto-g-play-2023--maui-3-gb--32-gb).

## Where it actually stands

| Bucket | Count | Work |
|---|---|---|
| Publish `linux/arm64` already | 17/25 | None — pull as-is |
| Local builds, **no arch pin, multi-arch bases** | 5 | Rebuild for arm64; likely no Dockerfile change |
| Published amd64-only (MinIO mirror) | 1 | Repoint `MINIO_IMAGE` at upstream MinIO (which is arm64) and re-verify the S3 contract |
| Published amd64-only (**FreePBX**) | 2 tags | The real project — see below |

Pull size on arm64: **3.6 GiB** compressed; expect roughly **9 GiB** unpacked
before volumes.

### The five local builds are probably already portable

This is the good news, and it is specific to this repo:

- `dashboard/Dockerfile`, `dashboard-backend/Dockerfile`, `tts-shim/Dockerfile`,
  `n8n.Dockerfile`, `workflow-studio.Dockerfile` contain **no `--platform=`,
  no `amd64`/`x86_64` reference, and no arch-specific download URL**.
- Their bases are multi-arch: `python:3.12-slim`, `n8nio/n8n:latest`, and
  build-args `NODE_IMAGE`/`NGINX_IMAGE`/`PYTHON_IMAGE` (all publish arm64).
- Their dependency sets are portable: `dashboard-backend` is pure Python
  (fastapi, uvicorn, docker, httpx, dotenv); `tts-shim` adds `numpy` and `soxr`,
  both of which ship `manylinux2014_aarch64` wheels; `workflow-studio` is
  stdlib-only by design.

The one thing to watch is the **Piper binary** the TTS shim installs
separately — take the `linux_aarch64` release asset, not `x86_64`. A build is
the only way to confirm; nothing here was built (no Docker on the audit
machine).

```sh
# One-time: a builder that can emit arm64 (no emulation needed for these)
docker buildx create --name capstone-arm --use
docker buildx inspect --bootstrap

# Per image (repeat with each Dockerfile / tag):
docker buildx build --platform linux/arm64 \
  -t capstone-dashboard-api:local -f dashboard-backend/Dockerfile . --load
docker buildx build --platform linux/arm64 \
  -t capstone-dashboard:local     -f dashboard/Dockerfile .            --load
docker buildx build --platform linux/arm64 \
  -t capstone-tts-shim:local      -f tts-shim/Dockerfile .             --load
docker buildx build --platform linux/arm64 \
  -t capstone-n8n-otel:local      -f n8n.Dockerfile .                  --load
docker buildx build --platform linux/arm64 \
  -t capstone-workflow-studio:local -f workflow-studio.Dockerfile .    --load
```

Use `--push` instead of `--load` for a multi-arch image in a registry; `--load`
is single-platform only.

## MinIO

The repo pins `ghcr.io/innotelinc/capstone/minio` (single-arch). Upstream
`minio/minio` publishes arm64, but the repo's release notes are explicit that
MinIO is still the platform storage owner and must not be swapped casually —
the S3 endpoint, bucket policy, signed/public URL behaviour and restore path
have to be re-verified. Port it by setting:

```sh
MINIO_IMAGE=quay.io/minio/minio:RELEASE.<same-tag>-arm64   # or the official multi-arch tag
```

and then re-running the recording/playback and backup paths, not just
`docker compose up`.

## FreePBX — the real blocker

`ghcr.io/innotelinc/pbx-portal:latest-fullstack` (1.4 GiB) and
`:latest` are **amd64-only**, and there is no upstream arm64 FreePBX from
Sangoma. Three honest options, in order of effort:

1. **External PBX.** Keep Ast​erisk on an amd64 box (or a hosted FreePBX) and
   point the arm64 host at it via ARI. The dashboard, agents, STT/TTS, n8n and
   observability all move to ARM; telephony stays where it works. This is the
   shortest path to a working arm64 deployment.
2. **Build Asterisk + FreePBX from source for arm64.** Asterisk 20/21 compiles
   on arm64 without much drama; FreePBX 17 is a large PHP application whose
   install script assumes x86 packages in places. Budget days, not hours, and
   own the image thereafter.
3. **Drop the PBX from the ARM host entirely.** Inbound calls need
   Asterisk somewhere; without it the stack is SMS + workflows + dashboards
   only, which is a different product.

## Compose changes you will need

Only two, and both are values, not structure:

```yaml
# docker-compose.override.yml (arm64 host)
services:
  minio:
    image: ${MINIO_IMAGE}       # an arm64 tag
  freepbx:
    image: ${FREEPBX_IMAGE}     # only if you built one; otherwise use option 1
```

No `platform:` pins are needed for the 17 published multi-arch images — compose
selects the host platform automatically. Add `platform: linux/arm64` only if you
run `buildx --push` images whose manifests include more than one arch.

## What still will not fit

After the port, the measured floor is unchanged: **~5.84 GiB resident** for
Capstone alone, on a host that this repo's own notes describe as needing
8 vCPU / 13.1 GiB. An arm64 SBC with 8 GiB will *run*, tight; 4 GiB will not.
A 3 GB phone will not, and no image rebuild changes that.

## Verification once built

```sh
./deploy/preflight-host.sh            # arch/ram/disk/docker on the arm64 host
./scripts/setup.sh                    # builds nothing it cannot pull
./scripts/smoke-e2e.sh                # PBX, ARI, dialplan, softphone WSS, TURN
python3 deploy/arm64-audit.py --json   # every row should read "arm64: yes"
```

If `smoke-e2e.sh` reaches the dialplan checks, the port is real; if it stops at
the PBX, you are on option 1 or 2 above and not finished yet.
