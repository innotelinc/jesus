# Ansible — wire dograh's Asterisk ARI telephony configuration

`dograh-ari.yml` idempotently configures dograh (via its HTTP API) so it
connects to the FreePBX/Asterisk ARI endpoint as a Stasis application — the
same result as filling in **Telephony Configurations** in the dograh UI, but
scripted and reproducible.

Everything is validated against a live dograh-api (this box): the exact
endpoints, payload shapes, and auth flow below were exercised with curl before
being committed.

## What it does

| Step | Endpoint | Idempotent? |
|------|----------|-------------|
| login (signup on first run) | `POST /api/v1/auth/login` / `POST /auth/signup` | yes (409 tolerated) |
| mint `X-API-Key` for later runs | `POST /api/v1/user/api-keys` | creates once, persists to `.env` |
| create-or-update ARI config | `POST`/`PUT /organizations/telephony-configs` | yes (GET first, name-keyed) |
| register inbound extensions → workflows | `POST`/`PUT /organizations/telephony-configs/{id}/phone-numbers` (per route) | yes (address-keyed) |

After a successful run, `docker exec pbx-freepbx asterisk -rx "ari show apps"`
lists `dograh` as a connected Stasis application, and inbound calls to each
registered extension are routed into its workflow.

## Routing table (`dograh_inbound_routes`)

`ansible/group_vars/all.yml` holds the routing table — FreePBX extension →
dograh workflow name (resolved by name, so re-imports that change workflow
ids don't break routing):

| Extension | Workflow |
|---|---|
| `8000` | IT Help Desk Mock Interview |
| `8001` | DevOps Mock Interview |
| `8002` | SQL Mock Interview |

Add a row and re-run the playbook — the phone number is created if absent, or
re-pointed at the workflow if the binding changed. The PBX half (dialplan
`exten =>` + FreePBX inbound route DID) is separate: see `pbx/README.md` →
"Route calls into dograh".

## Prerequisites

- `ansible-core` on the control node (this box: `pip install ansible-core`,
  or the system package). Only built-in modules are used — no collections.
- The capstone stack is up (`docker compose up -d`), so `dograh-api` answers
  on `DOGRAH_API_ENDPOINT` (default `http://127.0.0.1:8000`).

## Run

```bash
# 1. Install ansible-core if needed
python3 -m venv /tmp/ansible-venv && /tmp/ansible-venv/bin/pip install -q ansible-core

# 2. Provide credentials. Either export them (they fall back to env vars)...
export DOGRAH_ADMIN_PASSWORD='<dograh login password>'
export DOGRAH_ARI_PASSWORD="$DOGRAH_ARI_PASSWORD"   # from .env
export DOGRAH_ADMIN_EMAIL=ops@capstone.example

# 3. Run
/tmp/ansible-venv/bin/ansible-playbook -i ansible/inventory ansible/dograh-ari.yml
```

Or pass everything inline (nothing required except the two passwords):

```bash
/tmp/ansible-venv/bin/ansible-playbook -i ansible/inventory ansible/dograh-ari.yml \
  -e dograh_admin_password='<pw>' -e dograh_ari_password='<ari pw>'
```

Re-runs don't need the admin password: once `DOGRAH_API_TOKEN` exists in
`.env`, the playbook skips login and authenticates with the `X-API-Key`
(only `dograh_ari_password` is then required).

## Verify

```bash
./scripts/smoke-e2e.sh --no-boot     # now expects: dograh connected to ARI (PASS)
docker exec pbx-freepbx asterisk -rx "ari show apps"   # → dograh
```

If the interview workflow isn't imported yet, the playbook prints a WARN and
skips only the inbound-extension registration — run
`python3 dograh/import_workflow.py` first (needs `DOGRAH_API_TOKEN`, which the
playbook writes to `.env` on its first run), then re-run the playbook.

## Notes / gotchas (learned live)

- **Auth** — `get_user` accepts either `Authorization: Bearer <JWT>` or
  `X-API-Key: <key>`. The playbook logs in with email/password (signup is
  gated to `AUTH_PROVIDER=local`, which is the default in the compose), mints
  a durable API key on the first run, and persists it to `.env` as
  `DOGRAH_API_TOKEN` — later runs authenticate with `X-API-Key` alone.
- **Signup email** — the validator rejects reserved TLDs (`.local` → 422);
  use `@example.com`/`@example` style addresses.
- **Route keying** — the config is looked up by `name` (`Asterisk ARI
  (dograh)`), each phone number by `address` (`8000`, `8001`), and each
  workflow by `name` (not id), so re-runs are no-ops and re-imports don't
  break bindings.
- **Passwords** — the API masks `app_password` in responses (`****...cee0`),
  so the playbook PUTs the config on every run rather than diffing; that also
  picks up rotated ARI passwords automatically.
- **Dograh reconnects on its own** — the ARI manager polls
  `list_active_telephony_configurations_by_provider("ari")` and connects to
  new/updated configs without a dograh-api restart (observed live: config
  created → `WebSocket connected to http://127.0.0.1:8088` within seconds,
  `ari show apps` → `dograh`).
