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
- creates the shared Docker network and PBX volumes
- starts Dograh, FreePBX/Asterisk, n8n, Grist, OmniRoute, Kokoro, Speaches, SigNoz, and dependencies
- creates the Grist interview document
- mints and persists an OmniRoute API key
- downloads the configured Whisper model into the persistent Speaches cache
- configures Dograh ARI routing and refreshes n8n
- runs the smoke checks

For automatic startup after host reboots, install `systemd/capstone.service` as described below.

## Architecture

| Layer | Component | Role |
|---|---|---|
| Telephony | Asterisk / FreePBX 17 (via `pbx-portal`) + ARI | PBX, call routing, media |
| Voice Agent | `vai-platform` (Pipecat) | Real-time voice pipeline |
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
├── docker-compose.asterisk.yml       # FreePBX/Asterisk side + dograh ARI wiring
├── pbx/                              # ARI configs + entrypoint wrapper + PBX runbook
├── dograh/                           # interview workflow JSON + SDK import script
├── scripts/setup.sh                  # one-command bootstrap (secrets, boot, wire)
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

After boot, verify with `./scripts/smoke-test.sh`, then place calls:

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

FreePBX exposes Webmin on host port `10000` and RTP ports `10101–10120/udp` for the configured media range. Asterisk HTTP/ARI is exposed on `8088`, with the Dograh ARI user and inbound dialplan injected during PBX startup.

```bash
docker compose -f docker-compose.yml -f docker-compose.asterisk.yml up -d
```

## Verification

```bash
./scripts/smoke-test.sh
./scripts/smoke-e2e.sh --no-boot
```

The checks cover container health, Kokoro TTS, Speaches Whisper transcription, OmniRoute completions, n8n, Grist, SigNoz, OTel ingest, ARI, the Dograh dialplan, and the media WebSocket wiring.

## Packaging v1

The v1 release can be distributed in these forms:

1. **Source `.tar.gz`** — clean source snapshot without `.env`, Git metadata, runtime data, or generated artifacts.
2. **Source `.zip`** — the same clean source snapshot for Windows users.
3. **Docker deployment bundle** — Compose files, scripts, configuration, PBX assets, Dockerfiles, and documentation.
4. **GitHub Release** — tagged `v1` with the source archives and deployment bundle attached.
5. **Docker image package** — exported local images for offline or air-gapped installation; images are platform-specific and substantially larger than the source bundle.

Never include `.env`, API keys, database volumes, model caches, or call recordings in a release archive.

## Status

✅ v1 deployment release — compose, TTS/STT wiring, Dograh telephony, automated grading, Whisper model bootstrap, and observability are in place.
