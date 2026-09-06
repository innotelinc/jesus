# Zeus actions for dograh — tool pack (Phase 2)

Registers **Zeus portal actions as dograh `http_api` custom tools** so an
agent can send SMS and read/handle voicemail on the account's Zeus
(VoiceOps) side. No dograh engine changes: these are plain REST tools
executed by dograh's generic `execute_http_tool` path against the machine
contract in the Zeus repo's [`docs/portal-api.md`](../../zeus-pbx-platform/docs/portal-api.md).

The pack lives in [`zeus-tool-pack.json`](zeus-tool-pack.json) — four
definitions conforming to `dograh/upstream/api/schemas/tool.py`
(`HttpApiToolDefinition`):

| Tool | Zeus endpoint | Purpose |
| --- | --- | --- |
| `zeus_send_sms` | `POST /api/messages/send` | Send an SMS from the account's DID |
| `zeus_check_voicemail` | `GET /api/voicemail` | List voicemails (transcripts + AI summaries) |
| `zeus_voicemail_summary` | `POST /api/voicemail/summary` | Generate/refresh the AI summary of one voicemail |
| `zeus_voicemail_listened` | `POST /api/voicemail/listened` | Mark a voicemail handled |

## Prerequisites

1. **A Zeus account + session token.** Zeus authenticates every request with
   the account session (`pbx_session` cookie value — `docs/portal-api.md` §1).
   Create a **dograh credential** holding that value as a header and put its
   UUID in each tool's `config.credential_uuid` (replace
   `CREDENTIAL_UUID_ZEUS` in the JSON). A stored credential keeps the token
   out of tool configs and is masked in dograh test previews.
2. **DID ids.** `zeus_send_sms` takes the source DID id (`from_did_id`) —
   fetch the account's ids from `GET /api/phone/numbers` (or
   `scripts/zeus_client.py` once configured).
3. **Session lifetime.** Zeus sessions last 7 days. Rotate the credential
   when a call's tool responses come back `401`.

## Register

Via the dograh **Workflow Studio → Tools** UI (create each tool from the
pack entries), or the dograh REST tool API (`CreateToolRequest`). After
registration attach the tools to the workflow/agent that should have them.

## Notes & limits

- **Fax is not in the pack.** Zeus's `POST /api/fax/send` requires
  `multipart/form-data` (PDF file or cover body), which the generic
  `http_api` executor does not build. Use
  [`scripts/zeus_client.py`](../scripts/zeus_client.py) (`fax` /
  `fax-download`) for faxing until dograh gains file-upload tool support.
- **Transfer remains dograh-native.** Live transfer is still the
  `transfer_call` tool with the Zeus `POST /api/agent/transfer-resolve`
  resolver (see `docs/zeus-integration.md`, gap G3) — not an http_api tool.
- **End-to-end check:** after registering, use dograh's tool test endpoint
  (or a live call) with a real voicemail id; confirm 200 responses and that
  `zeus_voicemail_listened` flips the message out of new.
