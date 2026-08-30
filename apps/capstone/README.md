# Capstone — Self-Hosted AI Voice Agent for Technical Mock Interviews

**v2.2** · Self-hosted, open-source AI voice interviews over Asterisk/FreePBX, with local speech services, automated grading, observability, Coturn traversal, and offline-capable installation.

Tech Foundry Capstone Project: a completely self-hosted, open-source AI Voice Agent that conducts technical mock interviews over a phone line, grades the call, and delivers raw, constructive feedback.

**Non-negotiables:** 100% open-source · runs locally in Docker · no paid SaaS (no OpenAI, Cartesia, Vapi, Make.com) · OpenTelemetry observability throughout.

## v2.3 release

Release `v2.3` hardens the **PBX boot** against base64 secrets breaking the freepbx container's entrypoint, which crash-looped the stack on fresh installs.

Highlights of v2.3:

- **Freepbx crash-loop fixed**: the stock Innotel `entrypoint.sh` writes `FREEPBX_AMI_SECRET` (base64, so it can contain `/`) into `manager_custom.conf` with an unguarded `s/ / /`-delimited `sed`. When the secret contains `/`, the sed fails with `unknown option to 's'` and, under `set -e`, kills the entrypoint right after `service mariadb start` — so MariaDB was the only service that ever started and the container restarted in a loop. `pbx/entrypoint-dograh.sh` now patches the stock script's sed to a `|` delimiter on every boot (idempotently), the same fix already used for `DOGRAH_ARI_PASSWORD`.
- **Hardened remaining value-injecting seds**: the same `s///` delimiter hazard in the stock entrypoint's `AFDB_PASS` and `ADMIN_EMAIL` lines was also switched to `|`, so any base64/hex/email value (none of which contain `|`) is safe.
- **Verified end-to-end**: the freepbx service boots healthy with zero restarts, Asterisk 22 + the ARI user + `[dograh-inbound]` dialplan come up, and the full smoke test reports all checks passing.

## v2.2 release

Release `v2.2` fixes the **installed-system bootstrap** so the live/install ISO actually leaves a working, running platform instead of a wiped `/opt/capstone`.

Highlights of v2.2:

- **Installer root-path fix**: on the installed disk the installer runs flat at `/opt/capstone/install-capstone.sh`, but `ROOT` was computed with a repo-only `dirname $0/..` that resolved to `/opt`. That made the in-chroot install treat `ASSET_DIR != TARGET` and run `rsync -a --delete /opt/ /opt/capstone/`, recursively creating a stray `/opt/capstone/capstone` and deleting the real payload (no compose files, no scripts, no systemd unit — so nothing ever started). `ROOT` is now derived by probing for the payload markers (`docker-compose.yml`, `capstone-v2-deployment.tar.gz`, `scripts/install-capstone.sh`) in the script's own dir or its parent, so all three layouts (repo in-place, deployed flat, live-ISO session) resolve correctly and the destructive rsync is skipped.

Release `v2.1` hardens **first-boot reliability** on the live/install ISO and on fresh systems, and folds the PBX/Asterisk stack into a single compose file so the whole platform starts with one command.

Highlights of v2.1:

- **Single compose file**: `docker-compose.asterisk.yml` was merged into `docker-compose.yml` — the FreePBX/Asterisk side (and the optional PBX portal) is now a service in the main file, so `docker compose up -d` brings up the entire stack at once.
- **Live/install first boot fixed**: the installed system now boots straight into the stack with DHCP on every ethernet port, a real login user (`capstone` / `capstone`, overridable via `CAPSTONE_USER`/`CAPSTONE_PASSWORD`), and the Capstone systemd service enabled from inside the installer chroot (`systemctl --root`).
- **FreePBX container boot cleaned up**: PHP `memory_limit` raised to 512M; `odbc.ini` pointed at the MariaDB driver + socket so CDR/CEL connect; the `#include iax_fax_custom.conf` moved to `iax_custom_post.conf` and the `rtp_custom.conf` include deduplicated (editing the symlinked core-module templates in place so the fix survives `fwconsole reload`); `rtp_custom.conf` canonicalized to `[general] stunaddr = stun.l.google.com:19302 / icesupport = yes / rtpstart=10101 / rtpend=10120`.
- **Quieter Asterisk boot**: `chan_local.so` preload (absent from the image), HEP, and the SQLite CDR/CEL custom backends are `noload`'d so a clean boot logs no loader errors; the `minimum_size` stasis option and the stray `cel_sqlite3_custom.conf` values line are corrected.

Release `v2.0` synced the **Innotel fork** of Dograh (`innotelinc/dograh`) to the latest `dograh-hq/dograh` main and re-published the platform on the refreshed codebase.

Highlights of v2.0:

- **Dograh fork resynced to upstream**: `innotelinc/dograh` was rebased onto the current `dograh-hq/dograh` main (Tuner simulation, telephony-provider updates, `LANGFUSE_TRACES_PUBLIC`, and everything upstream shipped since the fork's last sync). All Innotel customizations were reapplied on top — the self-hosted interview stack (SigNoz/OTel, Kokoro, Speaches, n8n grading), the Asterisk/FreePBX ARI wiring, NPM-fronted hostnames, systemd autostart, and nightly DB backup — keeping each change only where upstream hadn't already fixed it.
- **Rebuilt GHCR images**: `ghcr.io/innotelinc/dograh-api` and `ghcr.io/innotelinc/dograh-ui` rebuilt from the synced fork source and re-published.
- **Dograh web UI (`dograh-ui`)**: the Next.js frontend runs on host port `3010`; the API on its native port `8000`. The UI talks to the API via `host.docker.internal:8000`; the browser reaches it at `http://<host-LAN-IP>:8000`.
- **Innotel fork images**: compose defaults to `ghcr.io/innotelinc/dograh-api` and `ghcr.io/innotelinc/dograh-ui`. If those can't be pulled, `docker-compose.dograh-build.yml` builds **both** api and ui from the innotelinc/dograh fork source.
- **Hardened env handling**: setup.sh and smoke-test.sh load `.env` explicitly so a stray exported shell variable can no longer pin `PUBLIC_BASE_URL`/`BACKEND_API_ENDPOINT` to a stale value.

Download the verified artifacts from the [GitHub v2.2 release](https://github.com/innotelinc/capstone/releases/tag/v2.2).

The recommended installation from a cloned source tree is:

```bash
git clone https://github.com/innotelinc/capstone.git
cd capstone
./scripts/setup.sh
```

The setup is idempotent and automatically:

- generates and preserves local secrets in `.env`
- clones the Dograh platform source ([innotelinc/dograh](https://github.com/innotelinc/dograh)) into `dograh/upstream` for reference and optional build-from-source
- creates the shared Docker network and PBX volumes
- starts Dograh, FreePBX/Asterisk, n8n, Grist, OmniRoute, Kokoro, Speaches, SigNoz, and dependencies
- creates the Grist interview document
- mints and persists an OmniRoute API key
- downloads the configured Whisper model into the persistent Speaches cache
- imports the three interview **agent workflows** (IT Help Desk, DevOps, SQL — see `dograh/`)
- creates the **Asterisk ARI telephony configuration** in Dograh (shows up in the dograh UI — `http://<host>:3010` — under Telephony Configurations) and binds SIP extensions **8000 / 8001 / 8002** to their agents
- wires the FreePBX half: dialplan + inbound routes DID 8000/8001/8002 → Dograh
- configures Coturn with generated credentials, the detected public IP (or localhost fallback), TURN port `3478`, and relay ports `49152–49251`
- refreshes n8n and runs the smoke checks

For automatic startup after host reboots, install `systemd/capstone.service` as described below.

## Architecture

| Layer | Component | Role |
|---|---|---|
| Telephony | Asterisk / FreePBX 17 (via `pbx-portal`) + ARI | PBX, call routing, media |
| WebRTC traversal | Coturn | TURN relay for clients behind NAT |
| Voice Agent | Dograh (Pipecat) — [innotelinc/dograh](https://github.com/innotelinc/dograh) | Real-time voice pipeline + agent workflows |
| Dograh web UI | `dograh-ui` (Next.js, Innotel fork build) — host `3010` | Agents + Asterisk ARI telephony configuration UI |
| Orchestrator | dograh (Python/FastAPI) — `network_mode: host` | Matches Asterisk networking; binds ARI media sockets |
| Local TTS | Kokoro-82M via `kokoro-fastapi` | On-prem speech generation (port 8880) |
| Local STT | Speaches (faster-whisper) | On-prem transcription (port 8001) |
| LLM Router | OmniRoute on port 20128 | OpenAI-compatible gateway to local/free models |
| Workflow | n8n (Community Edition) | Session webhooks on call hang-up → grading |
| Dashboard | Grist (default; NocoDB opt-in) | Student names, phone numbers, transcripts, scores |
| Observability | OpenTelemetry → SigNoz (ClickHouse) | Pipeline latency (STT → LLM → TTS) tracking |

## Repo layout

```
├── docker-compose.yml                # ALL services (dograh, PBX/FreePBX, TTS/STT, n8n, SigNoz)
├── docker-compose.dograh.yml         # dograh-api standalone (hybrid boxes)
├── docker-compose.dograh-build.yml   # OPTIONAL: build dograh-api + dograh-ui from the innotelinc/dograh fork
├── pbx/                              # ARI configs + entrypoint wrapper + PBX runbook
├── dograh/                           # interview workflow JSON + SDK import script
│   └── upstream/                     # shallow clone of github.com/innotelinc/dograh (gitignored; setup.sh)
├── scripts/setup.sh                  # one-command bootstrap (secrets, boot, wire)
├── scripts/dograh_wire.py            # imports agents, creates ARI config, binds extensions 8000-8002
├── scripts/grist_bootstrap.py        # creates Grist doc + Interviews table
├── scripts/gen_loops.py              # generates candidate answer loops via Kokoro TTS
├── scripts/place_call.py             # places a mock-interview call via ARI
├── scripts/smoke-e2e.sh              # boots both composes + verifies ARI, dialplan, media WS
├── scripts/smoke-test.sh             # verifies a running stack (no boot)
├── scripts/build-live-usb.sh         # builds the BIOS+UEFI live/install ISO
├── scripts/build-offline-bundle.sh   # builds deployment payload + docker image bundle
├── scripts/build-source-bundle.sh    # builds the clean source release bundle
├── scripts/fetch-offline-bundle.sh   # downloads + verifies the offline bundle from GitHub
├── scripts/install-capstone.sh       # live-USB->disk or in-place installer
├── scripts/offline-images.txt        # docker images included in the offline bundle
├── .env.example                      # every compose variable + secret hints
├── n8n-grader-workflow.json          # verified n8n Interview Grader workflow (auto-imported)
├── n8n-interview-grader.md           # node-by-node spec + IT Help Desk Tier 1 rubric prompt
├── n8n.Dockerfile / n8n-otel/        # n8n + OpenTelemetry auto-instrumentation
├── otel-collector-config.yaml        # SigNoz collector → ClickHouse
├── clickhouse-config.yaml            # SigNoz ClickHouse (single-node cluster)
├── clickhouse-keeper.yaml            # ClickHouse Keeper (coordination)
├── searxng-settings.yml              # SearXNG JSON API for n8n AI assistant
├── systemd/capstone.service           # systemd unit: auto-start the stack on boot
└── signoz-pipeline-latency-dashboard.json  # importable SigNoz dashboard
```

## Quick start

```bash
./scripts/setup.sh
```

When setup finishes, the three interview agents are live and wired:

| Extension | Agent |
|---|---|
| `8000` | IT Help Desk (Tier 1) mock interview |
| `8001` | DevOps mock interview |
| `8002` | SQL mock interview |

Dial one of them from a SIP softphone registered to the PBX, call in via the
trunk (DID routes are created automatically), or place a scripted test call
after verifying with `./scripts/smoke-test.sh`:

```bash
python3 scripts/gen_loops.py
python3 scripts/place_call.py 8000 candidate-it
python3 scripts/place_call.py 8001 candidate-devops
python3 scripts/place_call.py 8002 candidate-sql
```

### Automatic startup on boot

```bash
sudo cp systemd/capstone.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now capstone.service
```

Dograh uses host networking and is started by Compose with `restart: unless-stopped`; the bootstrap also explicitly starts it after configuration refresh.

## PBX / Asterisk side

FreePBX exposes Webmin on host TCP port `10000` and Asterisk RTP on UDP ports `10101–10120`; these ranges are deliberately separate to avoid the Webmin/RTP conflict. Coturn listens on TCP/UDP `3478` and relays on UDP `49152–49251`, configured by `TURN_*` variables in `.env`. Setup automatically generates the TURN username/password and uses the server’s public IPv4 for `TURN_EXTERNAL_IP` and `TURN_REALM`, falling back to `127.0.0.1` when public-IP detection is unavailable. Asterisk HTTP/ARI is exposed on `8088`, with the Dograh ARI user and inbound dialplan injected during PBX startup.

The PBX is a service in the main compose file, so one command brings up the
entire stack:

```bash
docker compose up -d
```

## TURN / WebRTC configuration

Setup persists these values in `.env` and preserves explicit non-placeholder values on reruns:

```bash
TURN_USERNAME=<generated username>
TURN_PASSWORD=<generated password>
TURN_REALM=<public IPv4 or 127.0.0.1>
TURN_EXTERNAL_IP=<public IPv4 or 127.0.0.1>
TURN_LISTENING_PORT=3478
TURN_RELAY_PORT_START=49152
TURN_RELAY_PORT_END=49251
```

For clients outside the LAN, forward `3478/tcp`, `3478/udp`, and `49152–49251/udp` from the router to this host. Replace the localhost fallback with the real public IP before using TURN across NAT.

## Verification

```bash
./scripts/smoke-test.sh
./scripts/smoke-e2e.sh --no-boot
```

Checks cover every container's health, the **Dograh API (`:8000`)** and **Dograh UI (`:3010`)**, Kokoro TTS, Speaches Whisper transcription, OmniRoute completions, n8n, Grist, SigNoz, OTel ingest, ARI, the Dograh dialplan, the media WebSocket wiring, and — when `DOGRAH_API_TOKEN` is in `.env` — the Dograh telephony wiring itself: the three agent workflows imported, the Asterisk ARI configuration present in the dograh UI, and extensions 8000/8001/8002 bound to their agents.

## Live/install USB and offline installation

Release `v2.2` includes an x86_64 live/install ISO that boots on both **legacy BIOS** and **UEFI** (Secure Boot must be disabled). It boots into an Xfce desktop (autologin as the live `user` account) with two launchers. Both the **live session** and the finished system come up with **LAN DHCP automatically enabled** on any connected ethernet interface (`en*` / `eth*`, via NetworkManager + netplan), so they can reach the network simply by being plugged in.

- **Download Capstone v2** — fetch the release deployment payload and the offline Docker image bundle into `~/capstone-offline-bundle`.
- **Install Capstone v2** — install Capstone. From the live session this installs to a **target disk** (partition, format, copy the system, install GRUB, then set up Docker + the Capstone service). On an already-installed Linux system it installs into that system (`/opt/capstone`).

Installing from the live session destroys all data on the selected target disk; the installer asks for typed confirmation (`YES`) before doing anything. Booting the live session alone never touches any disk.

The image bakes in Docker (`docker.io`) so the installed system has a container runtime even with no internet; the offline bundle supplies the images. The deployment payload is also baked into the ISO, so an offline install only needs the Docker image bundle from the USB medium.

Download the verified ISO and checksum from the [v2.2 release](https://github.com/innotelinc/capstone/releases/tag/v2.2), then write it to a USB device:

```bash
sha256sum -c capstone-v2-live-amd64.iso.sha256
sudo dd if=capstone-v2-live-amd64.iso of=/dev/sdX bs=16M status=progress conv=fsync
```

Replace `/dev/sdX` with the whole USB device, not a partition. Boot the target computer from the USB, wait for the desktop, and launch **Install Capstone v2**. For a fully offline install, also copy the offline bundle (`capstone-v2-deployment.tar.gz`, `docker-images-v2-part*.tar.gz`, `SHA256SUMS`) to a FAT32 partition of the USB stick — the installer detects and stages it automatically.

After the install, the **installed system** boots straight into the Capstone stack (systemd enables Docker + the Capstone service on first boot) with DHCP networking on every ethernet interface. The login user is **`capstone`** (password **`capstone`** — change it after first login, or pre-set `CAPSTONE_USER` / `CAPSTONE_PASSWORD` when running `install-capstone.sh` manually).

### Reset a forgotten / broken login password

If the `capstone` user's password doesn't work after an install (common when the install was interrupted or the chroot bootstrap didn't complete), reset it from the live USB:

1. Boot the machine from the Capstone live USB again and wait for the desktop.
2. Open a terminal and find the installed root partition:

   ```bash
   lsblk
   ```

3. Mount the installed root (adjust the device if your root is not `/dev/sda2`) and chroot into it:

   ```bash
   sudo mount /dev/sda2 /mnt
   sudo mount --bind /dev    /mnt/dev
   sudo mount --bind /dev/pts /mnt/dev/pts
   sudo mount --bind /proc   /mnt/proc
   sudo mount --bind /sys    /mnt/sys

   sudo chroot /mnt /bin/bash
   ```

4. Inside the chroot, create/reset the login user and drop the live-session autologin (it points at the live `user` account, which doesn't exist on the installed disk and can block a clean greeter):

   ```bash
   useradd -m -s /bin/bash -G sudo,docker capstone 2>/dev/null || true
   echo 'capstone:capstone' | chpasswd
   rm -f /etc/lightdm/lightdm.conf.d/50-capstone-autologin.conf

   exit
   ```

5. Unmount everything, then reboot into the installed system (without the USB):

   ```bash
   sudo umount /mnt/dev/pts 2>/dev/null; sudo umount /mnt/dev 2>/dev/null
   sudo umount /mnt/proc; sudo umount /mnt/sys; sudo umount /mnt
   sudo reboot
   ```

6. Log in as `capstone` / `capstone` and change the password right away with `passwd`.

> **Still rejected?** Re-run the chroot steps above and confirm the user really got written to disk:
> `grep capstone /mnt/etc/passwd /mnt/etc/shadow`. If the lines are missing, the chroot bootstrap didn't reach the user-creation step during the original install.

### Build the ISO

On an Ubuntu 24.04 (Noble) build host:

```bash
sudo apt-get install -y live-build xorriso mtools genisoimage \
  grub-efi-amd64-bin grub-pc-bin isolinux syslinux-common
./scripts/build-offline-bundle.sh --deployment-only   # bakes the payload into the ISO
./scripts/build-live-usb.sh
```

Output:

```text
dist/live-usb/capstone-v2-live-amd64.iso
dist/live-usb/capstone-v2-live-amd64.iso.sha256
```

The builder uses Ubuntu Noble with GRUB 2 (El Torito for CD/BIOS), an added GRUB EFI image for UEFI, and an isohybrid MBR so the same ISO boots from a USB stick in both firmware modes.

### Offline bundle

Build the offline bundle (deployment payload + all platform Docker images, split into parts under 2 GB so they fit GitHub's upload limit):

```bash
./scripts/build-offline-bundle.sh
```

Download the same bundle from the release:

```bash
./scripts/fetch-offline-bundle.sh ~/capstone-offline-bundle
```

This verifies `SHA256SUMS`, unpacks the deployment payload, and reassembles the Docker image archives into `dist/docker-images-v2/`. Point `install-capstone.sh` at the result (`CAPSTONE_ASSET_DIR=~/capstone-offline-bundle`) and it loads images locally instead of pulling from the network. The core images bundled are: Postgres/pgvector, Redis, MinIO, Coturn, Dograh API, FreePBX/PBX Portal, Kokoro TTS, Speaches STT, OmniRoute, and the instrumented n8n image.

## Packaging v2.2

The v2.2 release includes:

1. **Live/install ISO** — `capstone-v2-live-amd64.iso` plus checksum (BIOS + UEFI bootable, desktop live session, disk installer).
2. **Source bundle** — `capstone-source-bundle.tar.gz` plus checksum.
3. **Deployment payload** — `capstone-v2-deployment.tar.gz` (Compose files, scripts, PBX assets, Dockerfiles, systemd unit, documentation) plus checksum.
4. **Docker image bundle** — `docker-images-v2-partNN.tar.gz` archives of the core platform images for offline install, plus checksums in `SHA256SUMS`.
5. **GitHub Release** — immutable release assets at the v2.2 release page.

Build scripts: `scripts/build-source-bundle.sh`, `scripts/build-offline-bundle.sh`, `scripts/build-live-usb.sh`, `scripts/fetch-offline-bundle.sh`.

`.github/workflows/sync-and-release.yml` detects dograh upstream updates, syncs the fork, and cuts a numbered release — daily and on demand. Every release is **full**: the cut includes the deployment payload + source bundle, and two parallel jobs build and upload the docker image bundle and the live ISO (each on its own VM). Set the **`lightweight`** input for a quick test release that skips those two. The `force` input cuts a release even if upstream hasn't moved.

Never include `.env`, API keys, database volumes, model caches, or call recordings in a release archive. The repository’s generated `dist/` and `.live-build/` directories remain ignored and should be regenerated when needed.

## Status

✅ v2.3 release — hardens the PBX boot against base64 secrets (`FREEPBX_AMI_SECRET`, AvantFax `AFDB_PASS`/`ADMIN_EMAIL`) breaking the stock entrypoint's `s///` seds, which crash-looped the freepbx container on fresh installs; on top of v2.2 (installed-system bootstrap fix) and v2.1 (single compose file, fixed live/install first boot, quieter/hardened FreePBX/Asterisk boot).
