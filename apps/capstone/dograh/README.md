# Dograh agent workflows — mock interview tracks + phone-assistant agents

Importable dograh workflow graphs for the Capstone platform. The mock
interview tracks run a candidate through two realistic scenarios, then fire a
**hang-up webhook to n8n** so the call gets graded and logged (see
`n8n-interview-grader.md` + `n8n-grader-workflow.json`). The phone-assistant
agents are Project Capstone's additions: an inbound **Business Receptionist**
and an outbound **Outreach** agent.

| File | Role | Type | Trigger path | Ext |
|---|---|---|---|---|
| `interview-workflow.json` | IT Help Desk (Tier 1) | mock interview | `mock-interview` | 8000 |
| `devops-workflow.json` | DevOps | mock interview | `devops-interview` | 8001 |
| `sql-workflow.json` | SQL (junior data analyst) | mock interview | `sql-interview` | 8002 |
| `receptionist-workflow.json` | Business Receptionist | inbound phone assistant | `reception-answer` | 8003 |
| `outbound-outreach-workflow.json` | Outbound Outreach (telemarketer) | outbound phone assistant | `outbound-outreach` | 8004 |
| `job-interview-workflow.json` | Job Interview (hiring) | hiring assistant | `job-interview` | 8005 |
| `survey-workflow.json` | Phone Survey | survey assistant | `phone-survey` | 8006 |
| `gotv-polling-workflow.json` | Get Out The Vote Poll | polling assistant | `gotv-poll` | 8007 |

Create your own phone agent by describing what you want — in the **browser**
via the Workflow Studio (`http://<host>:8090`, the `workflow-studio` compose
service) or from the terminal with `scripts/generate_dograh_workflow.py`.
Both write an importable workflow from a free-form description (via the local
OmniRoute LLM) or a guided template; the Studio also imports the result into
dograh and registers the next free extension in one click. The mock
interviews are customizable per call via `initial_context`
(interviewer name, company, role, difficulty, focus topics).

All workflows share the same node/edge schema (globalNode → startCall →
agentNodes → endCall; the interviews also add a post-call webhook node).
The interview payloads carry a `"track"` value (`devops`, `sql`); the IT
track predates the convention, so the grader treats a missing `track` as `it`.

## Import

**Automatic (default).** `./scripts/setup.sh` imports all three agents and
wires the extensions for you via `scripts/dograh_wire.py` (plain REST, no
SDK): workflows are imported when missing, the **Asterisk ARI** telephony
configuration is created-or-updated so it shows up under **Telephony
Configurations** in the dograh UI, and extensions `8000`/`8001`/`8002` are
registered as phone numbers bound to their agent. Re-runs are no-ops; to
re-point an extension after editing a workflow JSON, delete the workflow in
the UI (or rename the old one) and re-run
`python3 scripts/dograh_wire.py`.

**Manual (SDK).** Equivalent to what the script does, using the
[dograh SDK](https://github.com/dograh-hq/dograh) (the source is cloned by
setup into `dograh/upstream` — gitignored; upstream's PyPI `dograh-sdk`
works too):

```bash
# 1. From the dograh clone (has the SDK + deps):
pip install -r dograh/upstream/examples/python/requirements.txt

# 2. Point the SDK at your dograh and authenticate:
cat > dograh/.env <<'EOF'
DOGRAH_API_ENDPOINT=http://localhost:8000
DOGRAH_API_TOKEN=<your token>
EOF

# 3. Create a workflow (from the capstone repo root):
python dograh/import_workflow.py                    # IT Help Desk track
python dograh/import_workflow.py devops-workflow.json  # DevOps track
python dograh/import_workflow.py sql-workflow.json     # SQL track
```

Then in the dograh UI: open the new workflow, assign it as the **Inbound
workflow** for a phone number (the FreePBX extension from `pbx/`), or call
it outbound via the trigger below. Publish when ready. (The API imports were
validated live: DevOps = workflow id 2, SQL = workflow id 3, both status
`active`.)

Routing is managed by `scripts/dograh_wire.py` (called by setup.sh) or the
Ansible manifest (`ansible/dograh-ari.yml`, `dograh_inbound_routes`):
`8000` → IT Help Desk, `8001` → DevOps, `8002` → SQL, `8003` → Business
Receptionist, `8004` → Outbound Outreach, `8005` → Job Interview,
`8006` → Phone Survey, `8007` → Get Out The Vote Poll. Add rows there and
re-run — no UI steps needed.

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

The DevOps track (`devops-workflow.json`) uses the same graph shape with
incident-focused scenarios: **production incident triage** (502s after a
nightly deploy — tests triage + rollback judgment) and **CI/CD flakiness
on a shared runner** (tests diagnosis methodology vs. blaming app code). Its
webhook payload adds `"track": "devops"` so the grader can pick a rubric.

The SQL track (`sql-workflow.json`) tests query diagnosis: **faulty-query
triage** (a one-to-many JOIN fan-out doubling revenue — tests schema
questions + JOIN/GROUP BY understanding) and **slow-query diagnosis** (a
50M-row table with no index on the filter columns — tests indexing,
EXPLAIN, and DBA escalation judgment). Payload carries `"track": "sql"`.

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
# IT Help Desk track  curl -X POST http://localhost:8000/api/v1/public/agent/mock-interview \
  -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' \
  -d '{
        "phone_number": "+15551234567",
        "initial_context": { "student_name": "Jamal", "phone": "+15551234567" }
      }'

# DevOps track (different trigger_path)  curl -X POST http://localhost:8000/api/v1/public/agent/devops-interview \
  -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' \
  -d '{
        "phone_number": "+15551234567",
        "initial_context": { "student_name": "Jamal", "phone": "+15551234567" }
      }'

# SQL track (different trigger_path)  curl -X POST http://localhost:8000/api/v1/public/agent/sql-interview \
  -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' \
  -d '{
        "phone_number": "+15551234567",
        "initial_context": { "student_name": "Jamal", "phone": "+15551234567" }
      }'
```

`initial_context` flows into the prompts (e.g. `{{initial_context.student_name}}`)
and into the hang-up webhook payload.

### Phone-assistant agents (additions)

Two extra workflows extend the platform beyond interviews — both import and
wire through the exact same path (they appear in `scripts/dograh_wire.py`
`TRACKS` and the Ansible `dograh_inbound_routes`):

- **Business Receptionist** (`receptionist-workflow.json`, ext `8003`) —
answers inbound calls like a front-desk receptionist: greets the caller,
handles people/departments/general-info requests, takes a message, and hangs
up courteously. Persona and call specifics (company, receptionist name,
caller name) come from `initial_context`.

- **Outbound Outreach** (`outbound-outreach-workflow.json`, ext `8004`) —
makes outbound calls like a telemarketer/outreach agent: introduces the call,
presents an offer (from `initial_context.offering` or the campaign goal),
handles interest/objections, gathers a callback or next step, and closes
politely. Initiate an outbound call with:

```bash
curl -X POST http://localhost:8000/api/v1/public/agent/outbound-outreach \
  -H 'X-API-Key: <key>' -H 'Content-Type: application/json' \
  -d '{
        "phone_number": "+15551234567",
        "initial_context": {
          "contact_name": "Jamal", "company": "Acme Roofing",
          "agent_name": "Avery", "offering": "our fall-maintenance package"
        }
      }'
```

Both follow the same graph shape as the interviews and require nothing extra
at boot — the entrypoint injects extensions `8003`/`8004` into the dialplan
(`pbx/asterisk/extensions_custom.conf`).

The hiring (`job-interview`), survey (`phone-survey`) and get-out-the-vote
(`gotv-poll`) workflows round out the set on extensions `8005`/`8006`/`8007`.

## AI-generated workflows (describe what you want)

`scripts/generate_dograh_workflow.py` builds an importable workflow JSON from
your description — either free-form (expanded by the self-hosted OmniRoute
LLM gateway) or a guided template (no LLM):

```bash
# Free-form — AI expands it (OmniRoute must be up):
python3 scripts/generate_dograh_workflow.py --name demo-call \
  --use-case outbound --desc "a friendly outreach call that books a demo"

# Guided template — no LLM:
python3 scripts/generate_dograh_workflow.py --name helpdesk \
  --guided --role "an IT support assistant" --goal "resolve the caller's issue" \
  --prompt "ask for the account, diagnose the problem, offer a fix"

# Fully interactive menu:
python3 scripts/generate_dograh_workflow.py
```

The generated file (`dograh/<name>-workflow.json`) uses the same schema and
imports exactly like the shipped workflows. To give it its own extension,
add it to `scripts/dograh_wire.py` `TRACKS` + the dialplan; for a one-off,
import it with `python3 dograh/import_workflow.py dograh/<name>-workflow.json`.
Env: `OMNIROUTE_URL` / `OMNIROUTE_API_KEY` / `OMNIROUTE_MODEL` (default `auto`).

## Customizing the mock interviews

The IT/DevOps/SQL mock interviews are templates driven by `initial_context`,
so each call can override the interviewer name, company, role, difficulty and
focus without editing a workflow:

- `interviewer_name` — the interviewer's name (default `Alex`)
- `company` — the company context (default: neutral)
- `role` — the target role (IT Help Desk / DevOps / SQL by track)
- `student_difficulty` — e.g. `entry`, `standard`, `senior` (default `standard`)
- `focus_topics` — the topics to test (defaults to the track's standard set)

Pass them in `initial_context` when you trigger the call:

```bash
curl -X POST http://localhost:8000/api/v1/public/agent/mock-interview \
  -H 'X-API-Key: <key>' -H 'Content-Type: application/json' \
  -d '{"phone_number": "+15551234567",
       "initial_context": {
         "student_name": "Jamal",
         "interviewer_name": "Priya", "company": "Acme Corp",
         "role": "IT Help Desk", "student_difficulty": "senior",
         "focus_topics": "Wi-Fi, account lockouts, escalations"
       }}'
```

For a fully custom interview, use the AI generator instead — it builds a
dedicated workflow with exactly the role and questions you want.

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
