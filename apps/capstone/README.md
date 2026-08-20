# Capstone — Self-Hosted AI Voice Agent for Technical Mock Interviews

Tech Foundry Capstone Project: a completely self-hosted, open-source AI Voice Agent that conducts technical mock interviews over a phone line, grades the call, and delivers raw, constructive feedback.

## Architecture at a glance

| Layer | Component | Role |
|---|---|---|
| Telephony | Asterisk / FreePBX 17 / AvantFAX 3.4.1 / IAXmodem 1.3.5 | PBX, call routing, fax |
| Voice Agent | `vai-platform` (Pipecat) | Real-time voice pipeline |
| Orchestrator | dograh (Python/FastAPI, Pipecat) | Media processing on `network_mode: "host"` to match Asterisk |
| Local TTS | Kokoro-82M via `kokoro-fastapi` | On-prem speech generation |
| LLM Router | 9Router (port 20128) | OpenAI-compatible gateway to local/free open models |
| Workflow | n8n (Community Edition) | Session webhooks on call hang-up |
| Dashboard | Grist / NocoDB | Student names, phone numbers, transcripts, scores |
| Observability | OpenTelemetry → SigNoz (ClickHouse) | Pipeline latency tracking |

## Non-negotiables

- 100% open-source, self-hosted
- Runs locally inside Docker containers
- No third-party paid SaaS (OpenAI, Cartesia, Vapi, Make.com, etc.)
- OpenTelemetry observability throughout

## Repo layout

```
├── docker-compose.yml      # all services on interview-net bridge (dograh on host)
├── dograh/                 # Pipecat pipeline (Kokoro TTS, OTel)
├── n8n/                    # hang-up grading workflow templates
└── docs/                   # deployment runbook
```

## Status

🚧 In development — deployment phase.
