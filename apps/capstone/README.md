# Capstone — Self-Hosted AI Voice Agent for Technical Mock Interviews

Tech Foundry Capstone Project: a completely self-hosted, open-source AI Voice Agent that conducts technical mock interviews over a phone line, grades the call, and delivers raw, constructive feedback.

**Non-negotiables:** 100% open-source · runs locally in Docker · no paid SaaS (no OpenAI, Cartesia, Vapi, Make.com) · OpenTelemetry observability throughout.

## Architecture

| Layer | Component | Role |
|---|---|---|
| Telephony | Asterisk / FreePBX 17 (via `pbx-portal`) + ARI | PBX, call routing, media |
| Voice Agent | `vai-platform` (Pipecat) | Real-time voice pipeline |
| Orchestrator | dograh (Python/FastAPI) — `network_mode: host` | Matches Asterisk networking; binds ARI media sockets |
| Local TTS | Kokoro-82M via `kokoro-fastapi` | On-prem speech generation (port 8880) |
| Local STT | Speaches (faster-whisper) | On-prem transcription (port 8001) |
| LLM Router | 9Router / OmniRoute on port 20128 | OpenAI-compatible gateway to local/free models |
| Workflow | n8n (Community Edition) | Session webhooks on call hang-up → grading |
| Dashboard | Grist (default; NocoDB opt-in) | Student names, phone numbers, transcripts, scores |
| Observability | OpenTelemetry → SigNoz (ClickHouse) | Pipeline latency (STT → LLM → TTS) tracking |

## Repo layout

```
├── docker-compose.yml                # ALL services, interview-net bridge (dograh on host)
├── .env.example                      # every compose variable + secret hints
├── kokoro_tts_service.py             # Pipecat Kokoro TTS → kokoro-fastapi container URL
├── n8n-grader-workflow.json          # verified n8n Interview Grader workflow (auto-imported)
├── n8n-interview-grader.md           # node-by-node spec + IT Help Desk Tier 1 rubric prompt
├── n8n.Dockerfile / n8n-otel/        # n8n + OpenTelemetry auto-instrumentation
├── otel-collector-config.yaml        # SigNoz collector → ClickHouse
├── clickhouse-config.yaml            # SigNoz ClickHouse (single-node cluster)
├── clickhouse-keeper.yaml            # ClickHouse Keeper (coordination)
├── searxng-settings.yml              # SearXNG JSON API for n8n AI assistant
└── signoz-pipeline-latency-dashboard.json  # importable SigNoz dashboard
```

## Quick start

```bash
cp .env.example .env        # set OSS_JWT_SECRET + real secrets (hints in the file)
docker compose up -d
docker compose ps           # wait for healthy
```

> `BACKEND_API_ENDPOINT` in `.env` must be reachable from INSIDE the n8n
> container (it fetches the transcript from it). Use the host LAN IP
> (e.g. `http://192.168.1.63:8000`), NOT `localhost`.

Then:
1. **dograh UI** — configure the ARI endpoint (`http://127.0.0.1:8088`), then set the interview agent's LLM / STT / TTS (table below).
2. **n8n** (`http://localhost:5678`) — the Interview Grader workflow is auto-imported and activated by `n8n-import`; verify it's active.
3. **SigNoz** (`http://localhost:3301`) — confirm `dograh-interview-agent` traces.
4. **Grist** (`http://localhost:8484`) — create the `Interviews` table (Student, Phone, RunID, Score, Verdict, Dimensions, Strengths, Improvements, Transcript).

## Networking model (important)

- `dograh-api` uses `network_mode: host` so it can bind ARI media sockets and reach the PBX on loopback. It reaches every other service via the host's published ports: **127.0.0.1:8001** (STT), **127.0.0.1:8880** (TTS), **127.0.0.1:20128** (LLM gateway), **127.0.0.1:4318** (OTel).
- Everything else is on the `interview-net` bridge and talks by service name.
- Containers that must call back into host-mode dograh (or the LLM gateway) use `host.docker.internal` (enabled via `extra_hosts: host-gateway`).

## Model wiring inside dograh (UI config)

| Setting  | LLM (9Router/OmniRoute)        | STT (speaches)                  | TTS (kokoro-fastapi)          |
|----------|--------------------------------|--------------------------------|-------------------------------|
| provider | speaches                       | speaches                       | speaches (or OpenAI — see `kokoro_tts_service.py`) |
| model    | auto                           | Systran/faster-distil-whisper-small.en | kokoro                 |
| voice    | —                              | —                              | af_heart (or am_michael, ...) |
| language | —                              | en                             | —                             |
| base_url | http://127.0.0.1:20128/v1      | http://127.0.0.1:8001/v1       | http://127.0.0.1:8880/v1      |
| api_key  | (blank — self-hosted)          | (blank — self-hosted)          | (blank — self-hosted)          |

**TTS note:** the `speaches` provider passes provider-specific voices (`af_heart`) through verbatim and requests `pcm`, so Kokoro works with zero code. If you use the OpenAI provider branch instead, `kokoro_tts_service.py` has the drop-in subclass (Pipecat's *built-in* `KokoroTTSService` is in-process ONNX only and cannot point at the container URL).

## Grading on hang-up (n8n)

Full spec + the IT Help Desk Tier 1 rubric system prompt: **`n8n-interview-grader.md`** (verified workflow: `n8n-grader-workflow.json`).

Flow: dograh Webhook node → POST `/webhook/interview-graded` → n8n fetches `transcript_url` → POST to `http://host.docker.internal:20128/v1/chat/completions` (model `auto`, system prompt = Tier 1 rubric) → parse JSON grade → save row to Grist.

## Observability (SigNoz)

Already wired — dograh exports pipeline spans to `SIGNOZ_OTLP_ENDPOINT` (set in compose to `http://127.0.0.1:4318/v1/traces`); Pipecat's `@traced_llm` / `@traced_tts` / `@traced_stt` emit one span per stage with a `metrics.ttfb` attribute. n8n's grading LLM call is traced too (custom image in `n8n.Dockerfile`).

Importable dashboard: **`signoz-pipeline-latency-dashboard.json`** (SigNoz → Dashboards → Import).

## Verification checklist

```bash
docker compose ps                                # all healthy
curl -s http://127.0.0.1:8880/health             # Kokoro TTS
curl -s http://127.0.0.1:20128/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello"}]}'   # LLM gateway
curl -s http://127.0.0.1:3301/api/v1/health      # SigNoz
curl -s http://127.0.0.1:5678/healthz            # n8n
curl -s http://127.0.0.1:8484 -o /dev/null -w '%{http_code}\n'   # Grist
```

## Status

🚧 In development — deployment phase complete: compose, TTS wiring, grading workflow, and observability are in place.
