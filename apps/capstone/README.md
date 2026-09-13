<div align="center">

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-brightgreen.svg)](LICENSE)

# 🎙️ Capstone — Voice AI Agent Platform

**Self-hosted AI phone agents over Asterisk/FreePBX — local speech, local LLM, no per-minute fees.**

Capstone turns your phone line into an AI-powered receptionist and outreach team that runs
entirely on your own hardware — answers inbound calls, screens callers, runs natural
conversations, dials out to chase leads, runs surveys and polls, and automates telephony
workflows over **FreePBX/Asterisk**, with **local speech** (STT + TTS) and an **LLM**
driving the conversation. User management and SSO are handled by **Cerulean Authentik**. No cloud
APIs, no audio leaving the box.

[![CI](https://github.com/innotelinc/capstone/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/capstone/actions/workflows/ci.yml)
[![Conformity](https://github.com/innotelinc/capstone/actions/workflows/conform.yml/badge.svg)](https://github.com/innotelinc/capstone/actions/workflows/conform.yml)
[![Release](https://github.com/innotelinc/capstone/actions/workflows/release.yml/badge.svg)](https://github.com/innotelinc/capstone/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/innotelinc/capstone?color=6366f1)](https://innotelinc.github.io/capstone/releases)

*One script, and your phone grows a brain.*

</div>

---

## Why Capstone

| Problem | Capstone answer |
| --- | --- |
| Cloud voice APIs leak audio + cost per minute | Local speech (STT+TTS) + local LLM over Asterisk/FreePBX; no audio leaves the box |
| Identity sprawl across phone apps | Cerulean Authentik SSO; disable a user and their phone-agent access dies |
| Telephony vendor lock-in | Skips OpenAI/Vapi/Cartesia/Make — runs on your own FreePBX + local LLM |
| Agent observability is a black box | OpenTelemetry spans every step; traces live in the stack |

> **About Capstone** — a completely self-hosted, open-source Voice AI Agent Platform: it
> handles incoming calls, screens callers, conducts natural conversations, and automates
> telephony workflows over Asterisk/FreePBX. A personal phone assistant that answers like a
> business receptionist and makes outbound calls on your behalf, all with local speech and an
> LLM driving the conversation. **Landing page:** [innotelinc.github.io/capstone](https://innotelinc.github.io/capstone)

**Non-negotiables:** 100% open-source · runs locally in Docker · no paid SaaS (no OpenAI,
Cartesia, Vapi, Make.com) · Cerulean Authentik for authentication and user management ·
OpenTelemetry observability throughout.

---

## ✨ Features

| | | |
|---|---|---|
| 🗣️ **Voice AI agents** | Prebuilt phone agents (receptionist, outreach, job interview, survey, GOTV poll) plus mock-interview agents for IT Help Desk, DevOps, and SQL | 
| 📞 **Asterisk/FreePBX** | Dialplan, inbound routes, custom extensions, and ARI wiring are fully automated — agents register as extensions `8000`–`8007` | 
| 🧠 **Local intelligence** | Kokoro TTS, Speaches Whisper STT, and OmniRoute LLM gateway via Zeus (OpenAI-compatible) — nothing leaves the box | 
| ✍️ **AI workflow authoring** | Describe an agent in the Workflow Studio and an AI generates the workflow JSON; import + register the next free extension in one click | 
| 🔐 **Cerulean SSO** | Shared identity through Cerulean's Authentik at `auth.capstone.innotel.us` — one login for every surface, and the Control Center is gated behind it | 
| 📊 **Control Center** | Live ops dashboard: services, health, ports, alerts, secrets inventory, users, host monitoring, and an in-browser softphone | 
| 🌐 **Canonical subdomains** | `app`/`api`/`auth`/`voice`/`admin`/`pbx` proxy hosts provisioned automatically through Nginx Proxy Manager, with **wildcard Let's Encrypt** by default | 
| 📡 **Observability** | OpenTelemetry → SigNoz: pipeline latency (STT → LLM → TTS) per call, importable dashboards | 
| 💾 **Offline + live USB** | Deployment payload, Docker image bundle, and a BIOS+UEFI live/install ISO — install with no internet | 

## 🚀 Quick start

```bash
git clone https://innotelinc.github.io/capstone.git
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
| Identity | Cerulean Authentik — `auth.cerulean.innotel.us` | SSO, authentication, user management (shared via Cerulean; no local Authentik instance) |
| Local TTS | Kokoro-82M (`kokoro-fastapi`) — `:8880` | On-prem speech generation |
| Local STT | Speaches (faster-whisper) — `:8001` | On-prem transcription |
| LLM Router | OmniRoute — `:20128` | OpenAI-compatible gateway to local/free models |
| Workflow | n8n (Community Edition) | Session webhooks on hang-up → grading |
| Dashboard | Grist (NocoDB opt-in) | Names, numbers, transcripts, scores |
| Observability | OpenTelemetry → SigNoz (ClickHouse) | Pipeline latency tracking |
| Control Center | `dashboard` (React/nginx) + `dashboard-api` (FastAPI) | Live ops UI |

### Addressing: LAN IPs only, never docker addresses

**Docker addresses do not resolve correctly for this project.** Anything that
acts as a *service target* — the address one container/service dials to reach
another — must be this host's LAN IP (`192.168.x.x`). A compose service name, a
bridge subnet, or `host.docker.internal` is not usable:

* `host.docker.internal` only resolves in containers that carry an
  `extra_hosts: host.docker.internal:host-gateway` mapping. The PBX container
  does **not**, so `ast_sockaddr_resolve` fails there and STUN is disabled with
  no error at all.
* A media WebSocket URI that cannot resolve fails **silently**: calls connect
  with no audio and nothing appears in the Asterisk log.
* A docker subnet recorded as `local_net` (this box carried `172.18.0.0/16`
  while its bridge is `172.31.0.0/16`) makes Asterisk classify a range that does
  not exist here as on-net, which mangles Contact and SDP.
* AMI permits were `172.16.0.0/12` + `10.0.0.0/8` to allow a bridge address.
  They are now loopback plus the LAN subnet: the portal dials the LAN IP, so the
  connection arrives as the LAN address, and nothing connects from a docker
  address any more.

**The rule, in one line: a service target is this host's LAN IP — no docker IPs,
no compose service names, no `host.docker.internal`.**

The bind follows the target: a service reached at the LAN IP is published on the
LAN IP (`${PJSIP_MEDIA_ADDRESS}:port:port`), never on `0.0.0.0` — that is what
put AMI in front of public scanners. One exception, because the client decides
it: `dograh-api` runs `network_mode: host` and dials ARI at `127.0.0.1:8088`, so
8088/8089 carry a loopback leg **as well as** the LAN one. Publish the addresses
that are actually dialled; check with `ss -tnp | grep :8088` before narrowing
one.

Set the LAN IP once — `PJSIP_MEDIA_ADDRESS` — and let the entrypoints derive the
rest (`PJSIP_LOCAL_NET`, the AMI permit, the AMI bind, `DOGRAH_WS_URI`). The
same rule is documented in the Zeus repo, which owns the shared PBX.

**Enforced, not just documented.** CI's `config-guard` job fails on a
docker-bridge address used as a *value* in `docker-compose*.yml`, `pbx/`,
`scripts/` or `.env.example`; on the docker alias in any fragment Asterisk loads;
and on a voice-path key whose value is neither empty, nor a `${VAR}` reference,
nor a LAN IP. The keys it holds to that are `ASTERISK_AMI_HOST`,
`DOGRAH_ARI_HOST`, `DOGRAH_WS_URI`, `PJSIP_MEDIA_ADDRESS`,
`PJSIP_STUN_TURN_ADDR` and `NPM_UPSTREAM_HOST`.

The one deliberate exception is `scripts/install-fail2ban.sh`'s bridge ranges:
those are *firewall exemptions*, not service addresses, and dropping them lets
another stack's bridge AMI probe earn a 48h ban.

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


---

## License

Capstone is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE) for the full text.

*Capstone — Voice AI Agent Platform. Self-hosted, open-source, no cloud required.*

## 🏛️ Platform stack

Capstone is the ecosystem's **AgentOps** platform — voice AI agents, call screening, AI receptionists, and telephony automation in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) — the
canonical single-responsibility architecture where Authentik owns identity, Infisical owns
secrets, Cerulean owns trust, ONYX owns storage, Magnate owns revenue, NPM Edge owns the edge, and every other
platform is a business function that consumes them. See
[docs/stack.md](docs/stack.md) for this platform's owns/consumes boundaries and its
Infisical secret setup.
