# Capstone — Self-Hosted AI Voice Agent for Technical Mock Interviews

**v1.1.0** · Self-hosted, open-source AI voice interviews over Asterisk/FreePBX, with local speech services, automated grading, observability, Coturn traversal, and offline-capable installation.

Tech Foundry Capstone Project: a completely self-hosted, open-source AI Voice Agent that conducts technical mock interviews over a phone line, grades the call, and delivers raw, constructive feedback.

**Non-negotiables:** 100% open-source · runs locally in Docker · no paid SaaS (no OpenAI, Cartesia, Vapi, Make.com) · OpenTelemetry observability throughout.

## v1.1.0 release

Release `v1.1.0` packages the deployable source, live/install USB image, Docker configuration, and offline installation helpers. Download the verified artifacts from the [GitHub v1.1.0 release](https://github.com/innotelinc/capstone/releases/tag/v1.1.0).

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
- creates the **Asterisk ARI telephony configuration** in Dograh (shows up in the dograh UI under Telephony Configurations) and binds SIP extensions **8000 / 8001 / 8002** to their agents
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
| Orchestrator | dograh (Python/FastAPI) — `network_mode: host` | Matches Asterisk networking; binds ARI media sockets |
| Local TTS | Kokoro-82M via `kokoro-fastapi` | On-prem speech generation (port 8880) |
| Local STT | Speaches (faster-whisper) | On-prem transcription (port 8001) |
| LLM Router | OmniRoute on port 20128 | OpenAI-compatible gateway to local/free models |
| Workflow | n8n (Community Edition) | Session webhooks on call hang-up → grading |
| Dashboard | Grist (default; NocoDB opt-in) | Student names, phone numbers, transcripts, scores |
| Observability | OpenTelemetry → SigNoz (ClickHouse) | Pipeline latency (STT → LLM → TTS) tracking |

## Repo layout

```
├── docker-compose.yml                # ALL services, interview-net bridge (dograh on host)
├── docker-compose.dograh.yml         # dograh-api standalone (hybrid boxes)
├── docker-compose.dograh-build.yml   # OPTIONAL: build dograh-api from the innotelinc/dograh fork
├── docker-compose.asterisk.yml       # FreePBX/Asterisk side + dograh ARI wiring
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

```bash
docker compose -f docker-compose.yml -f docker-compose.asterisk.yml up -d
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

The checks cover container health, Kokoro TTS, Speaches Whisper transcription, OmniRoute completions, n8n, Grist, SigNoz, OTel ingest, ARI, the Dograh dialplan, the media WebSocket wiring, and — when `DOGRAH_API_TOKEN` is in `.env` — the Dograh telephony wiring itself: the three agent workflows imported, the Asterisk ARI configuration present in the dograh UI, and extensions 8000/8001/8002 bound to their agents.

## Live/install USB and offline installation

Release `v1.1.0` includes an x86_64 live/install ISO with legacy BIOS and UEFI support. It provides an explicit **Try Capstone** path and an **Install Capstone** launcher. The installer installs Docker and prerequisites when online, loads bundled Docker images when available, installs the systemd startup unit, and starts the stack. It does not repartition or format disks automatically.

Download the verified ISO and checksum from the [v1.1.0 release](https://github.com/innotelinc/capstone/releases/tag/v1.1.0), then write it to a USB device:

```bash
sha256sum -c capstone-v1-live-amd64.iso.sha256
sudo dd if=capstone-v1-live-amd64.iso of=/dev/sdX bs=16M status=progress conv=fsync
```

Replace `/dev/sdX` with the whole USB device, not a partition. Boot the target computer from the USB. Choose **Try Capstone** for a non-destructive live session, or launch **Install Capstone v1** to install to `/opt/capstone`.

### Build the ISO

On an Ubuntu/Debian Linux build host:

```bash
sudo apt-get install -y live-build xorriso
./scripts/build-live-usb.sh
```

Output:

```text
dist/live-usb/capstone-v1-live-amd64.iso
dist/live-usb/capstone-v1-live-amd64.iso.sha256
```

The builder uses Ubuntu Noble, GRUB EFI, ISO output, and disables optional zsync generation for compatibility with current repositories.

### Source and offline bundles

Build a clean source bundle:

```bash
./scripts/build-source-bundle.sh
```

Download the deployment and Docker image bundle for offline use:

```bash
./scripts/fetch-offline-bundle.sh dist/offline-bundle
```

For a fully offline installation, copy the release deployment archive, Docker image archive, and `SHA256SUMS` to the live system or USB assets directory before running `scripts/install-capstone.sh`. The installer uses local assets first and only needs internet access when Docker packages or missing images are unavailable locally.

## Packaging v1.1.0

The v1.1.0 release includes:

1. **Live/install ISO** — `capstone-v1-live-amd64.iso` plus checksum.
2. **Source bundle** — `capstone-source-bundle.tar.gz` plus checksum.
3. **Deployment source** — Compose files, scripts, PBX assets, Dockerfiles, and documentation.
4. **Offline helpers** — source/deployment fetch and local Docker image loading scripts.
5. **GitHub Release** — immutable release assets at the v1.1.0 release page.

Never include `.env`, API keys, database volumes, model caches, or call recordings in a release archive. The repository’s generated `dist/` and `.live-build/` directories remain ignored and should be regenerated when needed.

## Status

✅ v1.1.0 deployment release — compose, Coturn, isolated RTP/Webmin ports, TTS/STT wiring, Dograh telephony, automated grading, observability, offline installer, and verified live ISO are in place.
