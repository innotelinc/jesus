# Dograh agent workflow — IT Help Desk mock interview

`interview-workflow.json` is the dograh workflow graph for the capstone mock
interview: a voice interviewer who runs the candidate through two realistic
Tier 1 tickets, then fires a **hang-up webhook to n8n** so the call gets
graded and logged (see `n8n-interview-grader.md` + `n8n-grader-workflow.json`).

## Import

```bash
# 1. From the dograh / vai-platform clone (has the SDK + deps):
pip install -r examples/python/requirements.txt

# 2. Point the SDK at your dograh and authenticate:
cat > dograh/.env <<'EOF'
DOGRAH_API_ENDPOINT=http://localhost:8000
DOGRAH_API_TOKEN=<your token>
EOF

# 3. Create the workflow (from the capstone repo root):
python dograh/import_workflow.py
```

Then in the dograh UI: open the new workflow, assign it as the **Inbound
workflow** for phone number `8000` (the FreePBX extension from `pbx/`), or
call it outbound via the trigger below. Publish when ready.

> The UI canvas is the alternative to re-importing — the JSON documents the
> exact node config if you prefer to rebuild by hand.

## Graph

```
[trigger: mock-interview]──(outbound API, optional)
[globalNode: Interviewer Persona]   ← prepended to every node's prompt

[startCall: Intro & Scenario 1 Kickoff]
        │  edge: scenario_one_started
        ▼
[agentNode: Scenario 1 — Wi-Fi Triage & Troubleshooting]
        │  edge: scenario_two_started
        ▼
[agentNode: Scenario 2 — Escalation Judgment]
        │  edge: interview_complete
        ▼
[endCall: Close & Hang Up]

[webhook: Notify n8n Grader]        ← fires AFTER the call ends (no edges)
```

The two scenarios are deliberately aligned with the n8n grader's rubric
dimensions — greeting/professionalism, active listening, triage,
troubleshooting methodology, escalation judgment, and closure — so the grade
has real evidence to cite. The second ticket is built to test **escalation
judgment** (no-admin-rights + "Access denied" = Tier 2 handoff).

## Hang-up webhook (→ n8n)

The `webhook` node is dograh's post-call integration: it fires after the
workflow run completes, retries on failure, and renders its payload with
dograh's template variables.

| Field | Value |
|---|---|
| Endpoint URL | `http://127.0.0.1:5678/webhook/interview-graded` |
| Method | `POST` |

**Why 127.0.0.1:5678** — dograh-api runs in HOST mode (the capstone
`docker-compose.yml`), so it shares the host's network namespace and reaches
n8n's published port on loopback. If you ever run dograh on the bridge
instead, change the URL to `http://n8n:5678/webhook/interview-graded`.

Payload keys match what the n8n grader reads (`body.run_id`,
`body.student_name`, `body.phone`, `body.transcript_url`):

```json
{
  "run_id": "{{workflow_run_id}}",
  "student_name": "{{initial_context.student_name}}",
  "phone": "{{initial_context.phone}}",
  "transcript_url": "{{transcript_url}}",
  "duration_s": "{{cost_info.call_duration_seconds}}",
  "call_disposition": "{{gathered_context.call_disposition}}"
}
```

> `transcript_url` is a signed public download link generated automatically
> whenever a webhook node exists. n8n fetches it from inside its own
> container, so `BACKEND_API_ENDPOINT` in the capstone `.env` must be the
> host's LAN IP (or a public URL) — **not** `localhost`.

### Template variables available in webhook payloads

| Variable | Meaning |
|---|---|
| `{{workflow_run_id}}` | Run ID (the n8n `run_id`) |
| `{{initial_context.<key>}}` | Context passed at call time, e.g. `student_name`, `phone` |
| `{{gathered_context.<key>}}` | Variables extracted during the call (e.g. `call_disposition`) |
| `{{cost_info.call_duration_seconds}}` | Call duration |
| `{{transcript_url}}` | Signed transcript download link |
| `{{recording_url}}`, `{{user_recording_url}}`, `{{bot_recording_url}}` | Recording links |
| `{{annotations.<key>}}` | QA-analysis results, if a QA node runs |
| `{{call_time}}`, `{{current_time}}`, `{{current_weekday}}` | Timestamps |

## Outbound calls (optional trigger)

The `trigger` node exposes an API to start outbound mock interviews:

```bash
curl -X POST http://localhost:8000/api/v1/public/agent/mock-interview \
  -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' \
  -d '{
        "phone_number": "+15551234567",
        "initial_context": { "student_name": "Jamal", "phone": "+15551234567" }
      }'
```

`initial_context` flows into the prompts (`{{initial_context.student_name}}`)
and into the hang-up webhook payload.

## Customizing

- **Prompts** — edit the `prompt` of each node in the JSON, then re-run
  `import_workflow.py` (creates a new workflow) or apply the same text in the
  UI canvas. Keep `add_global_prompt: true` so the persona prepends itself.
- **More tickets** — add an `agentNode` (id `node-scenario-3`, position x
  +300) and an edge from `node-scenario-2` → it with
  `"label": "scenario_three_started"` and a matching condition.
- **Auth on the webhook** — if you ever protect the n8n webhook, do NOT put
  the key in `custom_headers` (dograh drops secret-looking headers); attach a
  credential via `credential_uuid` instead.
