# ARM64 and small devices: the measured answer

"Recompile it for ARM" is a reasonable instinct and a large project. This page
replaces the guesswork with numbers from the registries and from the repo's own
measured footprint. Re-run them any time:

```sh
python3 deploy/arm64-audit.py --ram 3 --disk 32
```

## Verdict for a Moto G Play (2023) — `maui`, 3 GB / 32 GB

**The full stack cannot run there, and recompiling does not change that.**

| Requirement | Needed | G Play 2023 | Result |
|---|---|---|---|
| RAM | 5.84 GiB measured for Capstone alone | 3 GB total, Android included | **No** — short by ~2× before Android |
| Disk | ~9 GiB unpacked images + volumes | 32 GB | Yes |
| CPU | 2 vCPU floor, 4 recommended | 8 × Cortex-A53 (Helio G37) | Yes (slow) |
| Arch | linux/amd64 today | arm64 | **Portable, but see below** |

RAM is the wall. A port that succeeds perfectly still leaves ~5.8 GiB of
services to fit into 3 GB. There is no profile in this repo that small: the
Control Center alone needs the Docker socket, so even a trimmed
"dashboard-only" deployment does not work on Android.

## What an ARM64 port actually requires

Audit result at the time of writing: **17 of 25 images publish `linux/arm64`**.
Pullable arm64 layers total **3.6 GiB**; the eight that have no arm64 variant
account for another 1.6 GiB.

| Image | Status | Work |
|---|---|---|
| `ghcr.io/innotelinc/pbx-portal:latest-fullstack` (1.4 GiB) | amd64 only | **The blocker.** FreePBX/Asterisk for arm64 must be built from source — Sangoma does not ship an arm64 FreePBX. |
| `ghcr.io/innotelinc/pbx-portal:latest` | amd64 only | Same tree as above. |
| `ghcr.io/innotelinc/capstone/minio` | single-arch | Point `MINIO_IMAGE` at upstream MinIO, which does publish arm64 — but re-verify the S3 contract the repo depends on. |
| `capstone-dashboard:local` | local build | Rebuild with `buildx --platform linux/arm64`. |
| `capstone-dashboard-api:local` | local build | Same; watch native deps in `dashboard-backend/requirements.txt`. |
| `capstone-n8n-otel:local` | local build | Same. |
| `capstone-tts-shim:local` | local build | Same (pure Python, easiest of the five). |
| `capstone-workflow-studio:local` | local build | Same. |

Good news: **Kokoro TTS (1.3 GiB), Speaches STT, Postgres/pgvector, Redis,
Grafana, Prometheus, Grist, n8n and the OTel collector all publish arm64
already** — the heavy inference images are not the problem.

Then come the parts a port does not solve:

1. **No Docker on Android.** Even with `proot-distro` there is no `dockerd`:
   no namespaces, no cgroups, no overlayfs. Every service would have to run
   natively under Termux, which means rewriting the compose wiring, health
   checks and the dashboard's Docker-socket dependency.
2. **Host networking for Asterisk.** SIP/RTP on `5060/udp` and coturn `3478`
   assume a real host network. Android app sandboxing and unprivileged port
   binding get in the way even after a port.
3. **Thermals.** Thirty containers on an A53 cluster will throttle long before
   a call finishes.
4. **No Linux to run it on.** The G Play 2023 has no verified postmarketOS,
   Ubuntu Touch or mainline port, and its bootloader unlock eligibility is
   model/carrier-specific. See [phone-node.md](phone-node.md#path-d--postmarketos-a-real-linux-userspace).

So the practical ARM path is a small **arm64 SBC or ARM server** (8 GB+), not a
phone: 17 images then work as published, and only the five local builds plus
MinIO need arm64 images. An SBC with 8 GB is still below the 12 GiB
recommendation, so expect the stack to run tight.

## What the phone *can* do on ARM

Its own arm64 — no recompiling, nothing ported:

* the **SMS node** ([`phone-node/`](../phone-node/)): Termux ships arm64 Python
  and Termux:API ships arm64, and SMS goes out over the modem, not through an
  image;
* the **softphone and Control Center** as a browser client.

That split is the honest version of "run it on my phone": the phone does the
thing only a phone can do, and the x86 host does the thing only a server can do.
