# Capstone — Self-Hosted AI Voice Agent for Technical Mock Interviews

**v1** · Self-hosted, open-source AI voice interviews over Asterisk/FreePBX, with local speech services, automated grading, and observability.

Tech Foundry Capstone Project: a completely self-hosted, open-source AI Voice Agent that conducts technical mock interviews over a phone line, grades the call, and delivers raw, constructive feedback.

**Non-negotiables:** 100% open-source · runs locally in Docker · no paid SaaS (no OpenAI, Cartesia, Vapi, Make.com) · OpenTelemetry observability throughout.

## v1 release

Release `v1` packages the deployable source, Docker configuration, and locally available Docker images. The recommended installation is the one-command bootstrap:

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

## Live USB and offline installation

The repository includes a live USB builder for an x86_64 BIOS/UEFI image. The ISO is intentionally small: it downloads the pinned `v1` release and Docker images after boot, so the USB does not need to contain the multi-gigabyte image bundle.

Build the ISO on a Linux build host with Docker images already present:

```bash
./scripts/build-live-usb.sh
```

The ISO is designed for a **Try or Install** workflow:

- **Try Capstone:** boot the live Linux environment, click **Download Capstone v1**, and the release payload is downloaded to `/opt/capstone` before startup.
- **Install Capstone:** click **Install Capstone v1**; it downloads the pinned release, imports the Docker images, and enables the systemd service on the installed Linux system.

The installer intentionally does not repartition or format disks. It requires an existing Linux installation with Docker installed. The image targets x86_64 PCs with BIOS or UEFI; ARM machines, unusual storage controllers, and telephony hardware may require a separate build or host configuration.

The first boot requires internet access and several gigabytes of download space. After downloading, the release and Docker images remain local for subsequent offline starts. Verify the ISO checksum before writing it to removable media.

## Packaging v1

The v1 release can be distributed in these forms:

1. **Source `.tar.gz`** — clean source snapshot without `.env`, Git metadata, runtime data, or generated artifacts.
2. **Source `.zip`** — the same clean source snapshot for Windows users.
3. **Docker deployment bundle** — Compose files, scripts, configuration, PBX assets, Dockerfiles, and documentation.
4. **GitHub Release** — tagged `v1` with the source archives and deployment bundle attached.
5. **Docker image package** — exported local images for offline or air-gapped installation; images are platform-specific and substantially larger than the source bundle.

Never include `.env`, API keys, database volumes, model caches, or call recordings in a release archive. The live USB downloads only the pinned `v1` release URL, not the mutable `main` branch.

## Status

✅ v1 deployment release — compose, TTS/STT wiring, Dograh telephony, automated grading, Whisper model bootstrap, and observability are in place.
