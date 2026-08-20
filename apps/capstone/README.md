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
├── docker-compose.dograh.yml         # dograh-api standalone (hybrid boxes)
├── docker-compose.asterisk.yml       # FreePBX/Asterisk side + dograh ARI wiring
├── pbx/                              # ARI configs + entrypoint wrapper + PBX runbook
├── dograh/                           # interview workflow JSON + SDK import script
├── scripts/grist_bootstrap.py        # creates Grist doc + Interviews table
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
1. **dograh ARI telephony config** — `ansible/dograh-ari.yml` wires dograh's
   Asterisk ARI connection (endpoint, app name, password, WS client) plus the
   inbound extension → interview workflow routing, idempotently, via the dograh
   API (see `ansible/README.md`). Same result as the dograh UI
   **Telephony Configurations** page.
2. **dograh agent config** — set the interview agent's LLM / STT / TTS (table below).
3. **n8n** (`http://localhost:5678`) — the Interview Grader workflow is auto-imported and activated by `n8n-import`; verify it's active.
4. **SigNoz** (`http://localhost:3301`) — confirm `dograh-interview-agent` traces.
5. **Grist** (`http://localhost:8484`) — create the `Interviews` table (Track, Student, Phone, RunID, Score, Verdict, Dimensions, Strengths, Improvements, Transcript).

## Dograh agent workflow (`dograh/`)

`interview-workflow.json` is the dograh graph for the mock interview: an
interviewer persona, two Tier 1 scenarios (Wi-Fi triage, escalation
judgment) aligned to the grader's rubric, and a **hang-up webhook node** that
POSTs the run to `http://127.0.0.1:5678/webhook/interview-graded` (n8n) with
`run_id`, `student_name`, `phone`, `transcript_url`, `duration_s`, and
`call_disposition` — the exact keys the n8n grader reads. Import with
`python dograh/import_workflow.py` (SDK). Validated against dograh's
`ReactFlowDTO` schema.

## PBX / Asterisk side (`docker-compose.asterisk.yml`)

Runs FreePBX 17 + Asterisk 22 (the `pbx-portal` fullstack image) with the
dograh ARI wiring injected on boot: ARI user `[dograh]` (`ari.conf`),
Asterisk HTTP on 8088 (`http.conf`), the external-media WebSocket client
pointing at host-mode dograh (`websocket_client.conf`), and a
FreePBX-safe `[dograh-inbound]` dialplan context that routes calls into
`Stasis(dograh)` (`extensions_custom.conf`). dograh (host mode) reaches the
PBX at `http://127.0.0.1:8088`; Asterisk reaches dograh back via
`host.docker.internal:8000`.

```bash
# Full stack (dograh + PBX together)
docker compose -f docker-compose.yml -f docker-compose.asterisk.yml up -d
```

Set `DOGRAH_ARI_PASSWORD` in `.env` (it must match the dograh UI "App
Password"), then in the FreePBX GUI create an Inbound Route → Custom
Destination → `dograh-inbound,8000,1`. Full steps: **`pbx/README.md`**.

## Hybrid boxes (host redis/minio/9Router)

Some deployments (like the innotel box) run redis, minio, and the LLM gateway
as **host systemd services** instead of containers. On those, do NOT start the
main compose's redis/minio/omniroute containers — they collide with the host
ports. Start dograh-api alone against the host services:

```bash
docker compose -f docker-compose.dograh.yml --env-file <deploy-dir>/.env up -d
# if the host redis has its own requirepass, pass it so dograh's REDIS_URL works:
REDIS_PASSWORD=<host-redis-password> docker compose -f docker-compose.dograh.yml up -d
```

The smoke test recognizes this topology: a service with no container that
answers on its expected host port is reported as a passing host process.

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

## Grist bootstrap (`scripts/grist_bootstrap.py`)

The n8n grader writes scores to Grist at
`/api/docs/<GRIST_DOC_ID>/tables/Interviews/records`. The table + doc must
exist first — the compose default is a writable doc, but for a fresh
install create your own:

```bash
python3 scripts/grist_bootstrap.py            # creates doc + Interviews table, prints GRIST_DOC_ID
python3 scripts/grist_bootstrap.py --check    # verify only (no writes)
```

Then put the printed ID in `.env` (`GRIST_DOC_ID=<id>`) and recreate n8n so
it picks it up: `docker compose up -d n8n`. The script is idempotent — it
reuses the doc if `GRIST_DOC_ID` is set, adds any missing columns, and
verifies with the exact payload the n8n grader sends (validated end-to-end
against a live Grist).

## Verification — smoke tests

Two scripts, one per intent:

### 1. `scripts/smoke-e2e.sh` — boot both composes + verify telephony E2E

```bash
./scripts/smoke-e2e.sh            # `docker compose up -d` on BOTH files, then verify
./scripts/smoke-e2e.sh --no-boot  # verify only (stack already up)
```

Brings up `docker-compose.yml` + `docker-compose.asterisk.yml`, waits for all
15 containers to be ready, then verifies the telephony wiring end-to-end:

- **ARI** — user `[dograh]`, HTTP server ENABLED on 8088, host-side
  `GET /ari/asterisk/info` → 200
- **Dialplan** — `[dograh-inbound]` exten 8000 → `Stasis(dograh)`
- **Media WebSocket** — `websocket_client.conf` installed (shows the URI),
  `res_websocket_client` loaded, and — when dograh-api is connected to ARI —
  a live outbound media-WS client during the call
- **Test call end-to-end** — originates `POST /ari/channels?endpoint=
  Local/8000@dograh-inbound&app=dograh`, asserts the channel routed to
  context `dograh-inbound` exten 8000, then hangs it up via ARI REST

Exits non-zero on any failure. If dograh-api isn't connected to ARI (its
telephony configuration is set in the dograh UI, not in `.env`), the media-WS
and full-loop parts report a WARN with the exact UI fields to fill in — the
rest of the wiring is still fully verified.

### 2. `scripts/smoke-test.sh` — verify a running stack (no boot)

```bash
./scripts/smoke-test.sh          # full stack (main + PBX)
./scripts/smoke-test.sh main     # docker-compose.yml services only
./scripts/smoke-test.sh pbx      # docker-compose.asterisk.yml only
```

Checks every container's health, the HTTP endpoints (Kokoro, Speaches, LLM
gateway `/v1/models`, n8n, Grist, SigNoz, OTel ingest), real round-trips
(Kokoro TTS → WAV → Speaches STT transcription, plus the same
`/v1/chat/completions` call n8n's grader makes), ClickHouse + `dograh-pipeline`
trace count, and the PBX side (ARI user `[dograh]`, HTTP on 8088,
`res_websocket_client`, `[dograh-inbound]` dialplan, host-side ARI REST).
Exits non-zero on any failure. Containers are found by compose label, so it
works even if the stack was started from another directory (e.g. the
`interview-stack` folder of the vai-platform repo).

## Status

🚧 In development — deployment phase complete: compose, TTS wiring, grading workflow, and observability are in place.
