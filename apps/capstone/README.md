<div align="center">

# 🎙️ Capstone — Voice AI Agent Platform

**Self-hosted AI phone agents over Asterisk/FreePBX — local speech, local LLM, no per-minute fees.**

Capstone turns your phone line into an AI-powered receptionist and outreach team that runs
entirely on your own hardware — answers inbound calls, screens callers, runs natural
conversations, dials out to chase leads, runs surveys and polls, and automates telephony
workflows over **FreePBX/Asterisk**, with **local speech** (STT + TTS) and an **LLM**
driving the conversation. User management and SSO are handled by **Authentik**. No cloud
APIs, no audio leaving the box.

[![CI](https://github.com/innotelinc/capstone/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/capstone/actions/workflows/ci.yml)
[![Release](https://github.com/innotelinc/capstone/actions/workflows/release.yml/badge.svg)](https://github.com/innotelinc/capstone/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/innotelinc/capstone?color=6366f1)](https://github.com/innotelinc/capstone/releases)

*One script, and your phone grows a brain.*

</div>

> **About Capstone** — a completely self-hosted, open-source Voice AI Agent Platform: it
> handles incoming calls, screens callers, conducts natural conversations, and automates
> telephony workflows over Asterisk/FreePBX. A personal phone assistant that answers like a
> business receptionist and makes outbound calls on your behalf, all with local speech and an
> LLM driving the conversation. **Landing page:** [github.com/innotelinc/capstone](https://github.com/innotelinc/capstone)

**Non-negotiables:** 100% open-source · runs locally in Docker · no paid SaaS (no OpenAI,
Cartesia, Vapi, Make.com) · Authentik for authentication and user management ·
OpenTelemetry observability throughout.

---

## ✨ Features

| | | |
|---|---|---|
| 🗣️ **Voice AI agents** | Prebuilt phone agents (receptionist, outreach, job interview, survey, GOTV poll) plus mock-interview agents for IT Help Desk, DevOps, and SQL | 
| 📞 **Asterisk/FreePBX** | Dialplan, inbound routes, custom extensions, and ARI wiring are fully automated — agents register as extensions `8000`–`8007` | 
| 🧠 **Local intelligence** | Kokoro TTS, Speaches Whisper STT, and OmniRoute LLM gateway (OpenAI-compatible) — nothing leaves the box | 
| ✍️ **AI workflow authoring** | Describe an agent in the Workflow Studio and an AI generates the workflow JSON; import + register the next free extension in one click | 
| 🔐 **Authentik SSO** | Self-hosted identity in the compose stack at `auth.<domain>` — one login for every surface | 
| 📊 **Control Center** | Live ops dashboard: services, health, ports, alerts, secrets inventory, users, host monitoring, and an in-browser softphone | 
| 🌐 **Canonical subdomains** | `app`/`api`/`auth`/`voice`/`admin`/`pbx` proxy hosts provisioned automatically through Nginx Proxy Manager, with **wildcard Let's Encrypt** by default | 
| 📡 **Observability** | OpenTelemetry → SigNoz: pipeline latency (STT → LLM → TTS) per call, importable dashboards | 
| 💾 **Offline + live USB** | Deployment payload, Docker image bundle, and a BIOS+UEFI live/install ISO — install with no internet | 

## 🚀 Quick start

```bash
git clone https://github.com/innotelinc/capstone.git
cd capstone
./scripts/setup.sh
```

Setup is idempotent and automatically generates secrets, starts the full stack, imports the
interview agent workflows, wires the Asterisk ARI telephony configuration, binds SIP
extensions `8000`/`8001`/`8002` to their agents, configures Coturn, and runs smoke checks.

When it finishes, the interview agents are live and wired:

| Extension | Agent |
|---|---|
| `8000` | IT Help Desk (Tier 1) mock interview |
| `8001` | DevOps mock interview |
| `8002` | SQL mock interview |
| `8003` | Business Receptionist (answers inbound calls) |
| `8004` | Outbound Outreach (makes outbound calls) |
| `8005` | Job Interview (hiring) |
| `8006` | Phone Survey |
| `8007` | Get Out The Vote Poll |

Dial one from a SIP softphone, call in via the VoIP.ms trunk (DID routes are created
automatically), or place a scripted test call:

```bash
python3 scripts/gen_loops.py
python3 scripts/place_call.py 8000 candidate-it
./scripts/smoke-test.sh            # verify a running stack
```

**Automatic startup on boot:**

```bash
sudo cp systemd/capstone.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now capstone.service
```

## 🧱 Architecture

| Layer | Component | Role |
|---|---|---|
| Telephony | Asterisk / FreePBX 17 + ARI | PBX, call routing, media |
| WebRTC traversal | Coturn | TURN relay for clients behind NAT |
| Voice Agent | Dograh (Pipecat) | Real-time voice pipeline + agent workflows |
| Voice App | `dograh-ui` (Next.js) — `:3010` | Agents + telephony configuration UI |
| Identity | Authentik — `:9000` | SSO, authentication, user management |
| Local TTS | Kokoro-82M (`kokoro-fastapi`) — `:8880` | On-prem speech generation |
| Local STT | Speaches (faster-whisper) — `:8001` | On-prem transcription |
| LLM Router | OmniRoute — `:20128` | OpenAI-compatible gateway to local/free models |
| Workflow | n8n (Community Edition) | Session webhooks on hang-up → grading |
| Dashboard | Grist (NocoDB opt-in) | Names, numbers, transcripts, scores |
| Observability | OpenTelemetry → SigNoz (ClickHouse) | Pipeline latency tracking |
| Control Center | `dashboard` (React/nginx) + `dashboard-api` (FastAPI) | Live ops UI |

## 📚 Documentation

| Document | Covers |
|---|---|
| [docs/operations.md](docs/operations.md) | Control Center, PBX/Asterisk, VoIP.ms trunk, TURN/WebRTC, NPM proxy hosts, troubleshooting, verification, live/install USB + offline bundle |
| [docs/networking.md](docs/networking.md) | Ports, host networking, and firewall guidance |
| [docs/legacy-dependencies.md](docs/legacy-dependencies.md) | Legacy component inventory + modernization plan |
| [CHANGELOG.md](CHANGELOG.md) | Full release history (v2.x → v3.x) |

## 📦 Releases & offline install

Every `v*` tag triggers [.github/workflows/release.yml](.github/workflows/release.yml): the
Capstone-built images (n8n+OTel, Workflow Studio, Control Center dashboard + API) are
published to GHCR and the source bundle + deployment payload are attached to the GitHub
Release. The [sync-and-release workflow](.github/workflows/sync-and-release.yml) detects
dograh upstream updates, reapplies Capstone customizations, and cuts full numbered releases
(deployment payload + source bundle + Docker image bundle + live ISO).

Download the verified ISO and checksums from the **GitHub Releases** page:

```bash
sha256sum -c capstone-v2-live-amd64.iso.sha256
sudo dd if=capstone-v2-live-amd64.iso of=/dev/sdX bs=16M status=progress conv=fsync
```

For a fully offline install, also copy the offline bundle to a FAT32 partition of the USB
stick — the installer detects and stages it automatically. See
[docs/operations.md](docs/operations.md#liveinstall-usb-and-offline-installation) for the
full live-USB, persistent-USB, password-reset, and bundle-building walkthroughs.

## 🗺️ Repo layout

```
docker-compose.yml              # ALL services (dograh, PBX, TTS/STT, n8n, SigNoz, Authentik)
dashboard/                      # Control Center SPA (React + Vite, nginx, :8096)
dashboard-backend/              # Control Center aggregator API (FastAPI, :8095)
pbx/                            # ARI configs + entrypoint wrapper + PBX runbook
dograh/                         # interview workflow JSON + SDK import script
scripts/                        # setup, wiring, smoke, ISO/bundle builders
docs/                           # operations, networking, legacy dependencies
systemd/capstone.service        # auto-start the stack on boot
.env.example                    # every compose variable + secret hints
.github/workflows/              # CI + release pipelines
```

## 🔒 Security

Never include `.env`, API keys, database volumes, model caches, or call recordings in a
release archive. `dist/` and `.live-build/` are gitignored — regenerate them when needed.
All user management flows through Authentik; secrets live only in `.env` on the host.

---

*Capstone — Voice AI Agent Platform. Self-hosted, open-source, no cloud required.*

## 🏛️ Platform stack

Capstone is the ecosystem's **AgentOps** platform — voice AI agents, call screening, AI receptionists, and telephony automation in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) — the
canonical single-responsibility architecture where Authentik owns identity, Infisical owns
secrets, Cerulean owns trust, ONYX owns storage, Magnate owns revenue, and every other
platform is a business function that consumes them. See
[docs/stack.md](docs/stack.md) for this platform's owns/consumes boundaries and its
Infisical secret setup.
