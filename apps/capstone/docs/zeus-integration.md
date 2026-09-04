# Zeus Integration — Capstone as the agent add-on

Capstone (AgentOps) layers onto Zeus (VoiceOps): one shared FreePBX/Asterisk
voice plane hosts both Zeus customer extensions and Capstone voice-agent
extensions. Zeus keeps owning telephony, numbers, trunks, messaging, fax,
billing and the customer portal; Capstone keeps owning the AI agent pipeline
(dograh). They meet at the dialplan: DIDs hand calls to agents, agents
transfer live calls back to Zeus users, and outcomes write back to Zeus
records.

This document is the shared source of truth for that integration.

---

## 1. Why one shared PBX

- **One CDR / one RTP plane / one route table.** Two PBXes bridged by a SIP
  trunk would duplicate call records, force NAT hairpins and double RTP
  handling, and split every troubleshooting story in two.
- **The repos already converge on purpose.** Zeus's `pbx/` layer mirrors the
  Capstone `pbx/` convention (same fragment layout — `*_custom.conf` files,
  `bootstrap-*.sh`, env-rendered secrets, reconcile timer) so the two
  platforms share one operational shape. The natural end-state is one
  Asterisk with *both* fragment sets applied.
- **The stack role is clean.** Zeus = VoiceOps, Capstone = AgentOps. No
  ownership overlap; Capstone consumes Zeus telephony and adds intelligence.

## 2. Current state (as of this writing)

### Zeus owns

| Area | Detail |
|---|---|
| PBX | FreePBX/Asterisk (bare-metal installer or full-stack Docker image), `pbx/` fragments: AMI user `pbxportal` (deny-by-default permit list), ARI call control, HTTP/WebSocket for the softphone, `[from-zeus-portal]` dialplan |
| Numbers | VoIP.ms DIDs + SMS, per-account plan-limited provisioning, inbound webhook |
| Endpoints | Dynamic customer softphone extensions (`_Z.` pattern) created via AMI originate/ARI |
| Softphone | WebRTC PWA (SIP.js) over WSS (`ws.zeus.<domain>`), STUN/TURN |
| Voicemail | Voicemail-to-email + transcripts, **AI summaries via Ollama** (`/api/voicemail/summary`) |
| Fax | AvantFax / HylaFAX+ digital faxing |
| Billing | Stripe checkout, invoices, plans, reseller/white-label |

### Capstone owns

| Area | Detail |
|---|---|
| Agent pipeline | dograh (Pipecat) as an ARI Stasis app (`dograh_<hex>`); external-media WebSocket to dograh-api |
| Agents | FreePBX Custom Extensions `8000`–`8007`, mirrored into inbound routes every 2 min (`sync_dograh_routes.py`), plus anything created in the dograh UI/Workflow Studio |
| Intelligence | Local STT (Speaches/Whisper), local TTS (Kokoro), LLM via the OmniRoute gateway |
| Call control | Inbound screening, outbound originate for outreach/campaigns, **`transfer_call` tool** — destinations like `PJSIP/<ext>`, `+1…`, pre-transfer message, disposition write-back, call-time resolver |
| Records | Recordings → Minio; grading via n8n webhook; OTel → SigNoz |

## 3. Target architecture (one voice plane)

```
                        ┌────────────────────────────────────────────┐
  Public (SIP/RTP) ───▶ │        SHARED FreePBX / Asterisk           │
  VoIP.ms trunk/DIDs    │                                            │
                        │  [from-trunk] DID routes ──┬─▶ Zeus user   │
                        │                            │   (softphone  │
                        │  [from-zeus-portal]        │    ext _Z.)   │
                        │    customer extensions      │              │
                        │  [dograh-inbound] 8000-8007 ┘              │
                        │    ──▶ Stasis(dograh_*) ───▶ dograh-api    │
                        └────────────────────────────────────────────┘
                                              │ ARI  :8088  (host)
                                              │ WS   :8000  (host-mode dograh-api)
                                              ▼
                        ┌────────────────────────────────────────────┐
                        │ dograh-api (Pipecat voice pipeline)        │
                        │  STT: speaches · TTS: kokoro               │
                        │  LLM: omniroute gateway                    │
                        │  transfer_call ──▶ PJSIP/<zeus-ext>        │
                        │                ──▶ trunk (outbound DID)    │
                        │  recording ──▶ Minio · grading ──▶ n8n     │
                        └────────────────────────────────────────────┘
```

Both fragment sets land on the same Asterisk:

- **Zeus fragments** — `manager_custom.conf` (AMI), `ari_custom.conf`,
  `http_custom.conf` (WSS), `[from-zeus-portal]` / `[from-internal-custom]`.
- **Capstone fragments** — `ari.conf` (`[dograh]` ARI user, converged
  into the live `ari.conf`), `http.conf`, `websocket_client.conf`,
  `[dograh-inbound]` (→ `Stasis(dograh_*)`), agent Custom Extensions
  `8000+`.

## 4. Integration surface

| Zeus provides | Capstone consumes | Meeting point |
|---|---|---|
| DIDs + inbound routes | Agent inbound (`8000`–`8007` / dograh phone numbers) | FreePBX inbound route → `[dograh-inbound]` → `Stasis` |
| Customer extensions / softphone users | Transfer destinations | `transfer_call` to `PJSIP/<zeus-ext>` (or external via trunk) |
| Trunk + caller-ID inventory | Outbound originate (outreach, campaigns) | dograh dials the shared trunk with a Zeus-owned caller ID |
| Voicemail + transcripts | Local intelligence | Zeus AI summaries re-pointed from Ollama → OmniRoute OpenAI-compatible endpoint (one local LLM gateway) |
| Authentik SSO | dograh-ui / dashboard | Same IdP — the Zeus account owning a number is the same identity configuring its agent |
| Call history / CDR | Agent outcomes (disposition, notes, recording ref, n8n grade) | dograh completion events ingested into Zeus `call_history` |

## 5. Call flows

### 5.1 Inbound business call with AI receptionist
1. DID (owned by a Zeus account) is routed to agent extension `8003`.
2. dograh answers in Stasis: STT → LLM → TTS conversation, screening,
   calendar/info lookups.
3. Agent decides the caller needs a human → `transfer_call` with a
   pre-transfer message to the mapped `PJSIP/<zeus-ext>` (resolver picks the
   extension from Zeus contacts/account data) or an external number via the
   trunk.
4. On hang-up dograh records disposition + recording (Minio) and POSTs the
   result so Zeus shows one timeline entry for the whole handling.

### 5.2 Inbound call straight to a user (no agent)
Unchanged Zeus flow: DID → `[from-trunk]` → user extension → softphone,
CDR into `call_history`.

### 5.3 Outbound agent campaign (outreach / surveys / polls)
1. Triggered from dograh (or Zeus portal "AI outreach" for a number).
2. dograh originates via the shared trunk with a Zeus-owned caller ID.
3. Results (transcript, disposition, recording, n8n grade) write back to
   Zeus records; unanswered calls can return to Zeus voicemail flow.

### 5.4 Voicemail → AI
A number can either ring voicemail as today (transcript + summary, with the
summary LLM call routed to OmniRoute) or be answered by an agent instead of
the mailbox — a per-number routing decision owned by the agent config.

## 6. Data & identity contracts

- **Identity:** Authentik is the only IdP. Zeus `user_id` and the dograh
  agent owner are the same Authentik subject.
- **Routing ownership:** dograh stays the source of truth for agent phone
  numbers and routes (its `sync_dograh_routes.py` writes FreePBX). The Zeus
  portal gets a **read-only "AI assistant" panel per number** showing which
  agent answers and recent outcomes — no second writer to the route tables.
- **Outcome write-back:** a small contract — dograh emits per-call outcome
  events (call id, number, agent, disposition, transcript ref, recording
  ref, grade); Zeus ingests them into `call_history`-adjacent rows and
  serves recording playback (Minio presigned URLs behind the portal).
- **Media:** recordings live in Minio (ONYX StorageOps in the stack); Zeus
  gains an S3 read path, never stores the audio itself.
- **Secrets:** shared credentials (FREEPBX AMI/ARI/GraphQL, dograh ARI
  password + WS URI, trunk creds) come from Infisical once — never from two
  `.env` files.
- **Billing:** Magnate monetizes agents as an add-on SKU on a Zeus
  number/plan (entitlement gates whether a DID may route to an agent).

## 7. Migration steps (phased)

1. **Stand up the shared PBX** from the Zeus deployment and apply *both*
   fragment sets through the per-context converge tool that now owns
   `extensions_custom.conf` — implemented in the Zeus repo as
   `pbx/asterisk_converge.py` (see G1), already wired into
   `bootstrap-zeus-pbx.sh` with unit tests in CI. On the shared box run it
   once per product: the zeus half via the bootstrap, the capstone half by
   pointing `--source` at capstone's `pbx/asterisk/extensions_custom.conf`
   with `--owner capstone --append from-internal-custom`.
2. **Point dograh at the shared PBX**: ARI host/credentials, external-media
   WS URI, and the reconcile timer now target the shared Asterisk instead of
   Capstone's bundled `freepbx` container.
3. **Register agent extensions** `8000`–`8007` (and any dograh numbers) on
   the shared PBX with the existing `sync_dograh_routes.py`, pointed at the
   shared FreePBX GraphQL endpoint.
4. **Consolidate the AI path**: Zeus `OLLAMA_URL`/model settings re-point at
   the OmniRoute OpenAI-compatible endpoint (or run OmniRoute as the stack's
   shared LLM gateway and retire direct Ollama calls).
5. **Unify the web layer**: dograh-ui, Zeus portal, dashboard behind the
   same Authentik + Nginx Proxy Manager subdomains.
6. **Wire outcome write-back** (contract above) so agent calls show in Zeus
   call history with playback.
7. **Deprecate the bundled Capstone PBX** as the default topology — keep the
   standalone compose only for development/offline installs.
8. **Add the Magnate entitlement** gating agent routing per number/plan.

## 8. Open gaps & decisions

- **G1 — `extensions_custom.conf` ownership (DONE).** Both fragment sets
  write the one FreePBX-included file. Resolution: `pbx/asterisk_converge.py`
  (twinned in the Zeus and Capstone repos) merges per context with an
  explicit ownership policy — contexts a product owns (`[from-zeus-portal]`,
  `[dograh-inbound]`) **replace** wholesale, while `[from-internal-custom]`
  is **append-shared**: each product's lines sit under
  `; >>> begin/end <owner>` markers so a product is idempotent and can only
  rewrite its own segment. Owned segments refresh **in place** (each owner is
  byte-idempotent alone), legacy markerless injections are absorbed instead
  of duplicated, and replaces preserve the comment run above a header so no
  owner's text is eaten. Capstone's `pbx/entrypoint-dograh.sh` now converges
  through the tool (16 unit tests + CI smoke in both repos), live on the
  running PBX.
- **G2 — ARI/include reality (RESOLVED).** The earlier `ari_additional_-
  custom.conf` design assumed `/etc/asterisk/ari.conf` is a module-managed
  symlink that regenerates and `#include`s the custom file. Verified against
  the pbx-portal fullstack image and the live box: `ari.conf` is a **plain
  file** (not a symlink) with **no `#include` lines**, and neither
  `fwconsole reload` nor the `capstone-pbx-sync` timer regenerates it (hash
  unchanged across reload) — so the custom-file install was dead weight and
  a *fresh install shipped with no ARI user at all*. Capstone now converges
  the `[dograh]` section straight into `ari.conf` (the file Asterisk reads)
  with the password rendered into a temp fragment first, so other users' —
  e.g. Zeus's — sections pass through untouched. Confirmed include map on
  the live box: `http.conf` → `http_custom.conf`; `manager.conf` →
  `manager_custom.conf`; `extensions.conf` → `extensions_custom.conf`;
  `pjsip.conf` → `pjsip_custom.conf`; `ari.conf` → (none). Remaining for the
  shared box: Zeus's own ARI user must also be converged into `ari.conf`
  (its `ari_custom.conf` fragment is not included by this FreePBX either) —
  same pattern, `--owner zeus` on the same file, once the Zeus half of the
  shared renderer adopts the file matrix.
- **G3 — Transfer resolution source.** Where does the agent learn "who do
  you need → which Zeus extension"? Candidates: Zeus contacts directory,
  per-number mapping, or per-account lookup API. Needs a decision and a
  resolver contract.
- **G4 — Voicemail vs agent per number.** Routing-toggle ownership and the
  exact fallback chain (agent busy/unavailable → voicemail) are undefined.
- **G5 — Outbound caller ID.** Campaigns need caller IDs from the Zeus
  number inventory, with per-campaign selection and plan/entitlement checks.
- **G6 — SMS/fax for agents.** Later phase: letting agents send/receive SMS
  (VoIP.ms) and fax receipts is a natural extension of the same DID routes.

## 9. Related

- `docs/networking.md` — port inventory and exposure tiers (shared-PBX
  deployment updates the freepbx row: single `:5060`/`:80`/`:8088`/`:5038`).
- `docs/stack.md` — how capstone's services fit the Innotel platform stack.
- Zeus repo `pbx/README.md` — the Zeus side of the shared fragment layout.
