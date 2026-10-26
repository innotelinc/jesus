# API reference

Base URL `/api`. All responses are JSON. Errors use one shape:

```json
{ "error": { "code": "bad_request", "message": "…", "details": {} } }
```

| Status | Meaning |
|---|---|
| 400 | validation failure (`reason` in `details` for numbers) |
| 401 | no valid session / key |
| 403 | role or key scope insufficient |
| 404 | not found (or hidden by privacy rules) |
| 409 | state conflict (already verified, wrong status) |
| 429 | rate limited |

## Authentication

Three ways in, all accepted by the same guard:

```http
Cookie: telno_session=<token>          # browser
Authorization: Bearer <token>          # scripts
x-api-key: tl_…                        # partners, scope-limited
```

API keys are limited to registry scopes: reads need `registry:read`, mutations need
`registry:write`.

---

## Public — no authentication

### `GET /public/domains`
The directory hostnames, their branding and canonical host.

```json
{ "canonical": "telno.directory",
  "domains": [{ "slug": "num.directory", "host": "num.directory", "label": "Num Directory",
                "tagline": "…", "accent": "#22d3ee", "scope": "world" }] }
```

### `GET /public/stats`
Registry counters plus the active verification channel.

### `GET /public/countries`
245 countries with ISO code, dial code and English name. Cached for a day.

### `GET /public/search?q=&country=&kind=&limit=&offset=`
`mode` is `number` when the query was digits, `text` when it went through FTS5.

```json
{ "results": [{ "id": "lst_…", "name": "Blue Harbor Coffee", "kind": "business",
                "category": "Cafe", "city": "San Francisco", "country": "US",
                "display": "+1 415 555 0117", "e164": "+14155550117",
                "verified": true, "trust": 78, "masked": false }],
  "total": 1, "mode": "text" }
```

`e164` is `null` and `masked` is `true` for unlisted numbers. Opted-out numbers never appear.

### `GET /public/lookup?number=`
Accepts any human format. Returns the normalized parse even when nothing is found.

```json
{ "found": true,
  "parsed": { "ok": true, "e164": "+442079460958", "country": "GB", "lineType": "fixed",
              "international": "+44 20 7946 0958", "valid": true },
  "entry": { "display": "+44 20 7946 0958", "e164": "+442079460958", "listings": [ … ] } }
```

### `GET /public/number/:e164`
Same entry shape, 404 when absent, private, or opted out.

### `POST /public/submissions`
Rate limited to 5 per hour per IP. Creates a pending listing and sends a code.

```json
{ "number": "+44 20 7946 0958", "name": "Southwark Cycle Works",
  "kind": "business", "category": "Repairs", "city": "London", "country": "GB",
  "website": "example.com", "email": "owner@example.com", "channel": "email",
  "domain": "telno.directory", "notes": "optional" }
```

```json
{ "id": "sub_…", "status": "awaiting_verification", "channel": "email",
  "target": "o•••@example.com", "expiresAt": "2026-10-25T21:40:00.000Z",
  "delivered": true, "message": "We sent a 6-digit code…" }
```

A matching existing listing returns `200` with `{ "status": "duplicate", "duplicate": true }`
instead of creating a second copy. `devCode` is included only when
`DEV_EXPOSE_VERIFICATION_CODES` is enabled (default outside production).

### `POST /public/submissions/:id/verify`
```json
{ "code": "123456" }
```
`200` with `status: verified`; `400` on a wrong code (attempt counter in the message); `409` when
expired, exhausted, or already verified.

### `GET /public/submissions/:id`
Status of a submission. Verification targets are masked.

### `POST /public/optout`
```json
{ "number": "+14155550123", "reason": "optional" }
```
Always `{ "ok": true }`, whether or not the number was listed.

---

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | 10/min per IP, sets cookie, returns token + user |
| POST | `/auth/logout` | — | bumps the token version (all sessions invalid) |
| GET | `/auth/me` | — | current user |
| POST | `/auth/password` | `{ currentPassword, newPassword }` | invalidates old sessions, returns a new token |

---

## Registry (session or `x-api-key`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/numbers?q=&country=&status=&page=&limit=` | list with dedupe metadata |
| POST | `/numbers` | normalize + upsert; `deduplicated: true` when it existed |
| GET | `/numbers/:id` | number, listings, assigned extension, recent calls |
| PATCH | `/numbers/:id` | status, visibility, line type, carrier, region, trust |
| DELETE | `/numbers/:id` | remove the row and its listings (owner/operator) |
| GET | `/numbers/lookup/:value` | dry-run normalization for the UI |
| POST | `/numbers/:id/listings` | attach an entity (idempotent on name) |
| PATCH | `/listings/:id` | edit a listing |
| DELETE | `/listings/:id` | remove a listing |
| POST | `/numbers/:id/verify` | mark verified, +15 trust, publish listings |
| POST | `/numbers/merge` | `{ into, from, reason }` — collapse two rows |

```bash
curl -X POST http://localhost:8080/api/numbers \
  -H "x-api-key: tl_…" -H 'content-type: application/json' \
  -d '{"number":"+1 (415) 555-0177","name":"Harbor Coffee","kind":"business","city":"San Francisco"}'
```

The second identical call answers:

```json
{ "number": { "id": "num_…", "e164": "+14155550177", "display": "+1 415 555 0177" },
  "created": false, "deduplicated": true }
```

---

## Telephony (session or key for reads; operator/owner for writes)

| Method | Path | Purpose |
|---|---|---|
| GET | `/extensions` | endpoints with DID and state |
| POST | `/extensions` | create; returns the SIP secret once |
| PATCH | `/extensions/:id` | rename, voicemail, DND, forward, assign DID, rotate secret |
| DELETE | `/extensions/:id` | remove |
| POST | `/extensions/:id/rotate-secret` | new SIP password |
| GET/POST/PATCH/DELETE | `/trunks[/:id]` | carrier registrations (secrets never returned) |
| GET/POST/PATCH/DELETE | `/ivr[/:id]` | menus: `options: [{digit, target, label}]` |
| GET | `/calls?limit=&direction=&q=` | call history, formatted |
| GET | `/calls/stats` | 24h totals, dispositions, 7-day series |

---

## Workspace (session or key for reads; operator/owner for writes)

Every write is audited, every number reference is the canonical `numbers` row, and
nothing is claimed as delivered that a provider has not confirmed.

A device row carries its own credential. Provisioning returns the `dv_…` token
once (only its hash is stored); the device posts it to `/devices/heartbeat` every
`DEVICE_CHECKIN_SEC` (default 300). A live device that stays quiet for longer than
`DEVICE_STALE_AFTER_SEC` (default 900) is reported as `silent`, and the estate
counts it as needing attention. Neither status nor last-seen can be set by hand
for a live device — only a real check-in moves them.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/voice/agents` | personas: voice, language, greeting, script, optional DID |
| PATCH/DELETE | `/voice/agents/:id` | edit the script or voice, `draft → active → paused`, `recordInbound`/`recordOutbound`; delete |
| GET/POST | `/workflows` | triggered automations; steps validated against the known set |
| PATCH/DELETE | `/workflows/:id` | activate, pause, rename, replace steps |
| POST | `/workflows/:id/run` | record a run; a draft or unknown step returns `ok: false` |
| GET | `/voicemails` | recordings with transcript and `audioUrl`; `?unread=1` |
| PATCH/DELETE | `/voicemails/:id` | mark heard/unheard, urgent; delete |
| GET/PUT | `/voicemails/:id/audio` | stream (Range-aware) or upload the recording as a raw body |
| GET/POST | `/faxes` | inbound and outbound faxes; `body` is a plain-text page; `?direction=` |
| PATCH | `/faxes/:id` | `queued → sending → sent|failed` (`received` for inbound) |
| GET/PUT/DELETE | `/faxes/:id/attachment` | download, upload (PDF/PNG/JPEG/TIFF) or clear the document |
| GET | `/messages?channel=` | SMS/MMS/WhatsApp/web threads |
| POST/PATCH | `/messages[/:id]` | queue outbound (stays `queued` without a provider); requeue a failure |
| GET/POST/PATCH | `/billing/invoices[/:id]` | amounts in integer minor units; totals per currency, never summed across; an invoice carries `payUrl` while it is open and Stripe is configured, plus `lastProvider` and `lastSendError` for its last email attempt |
| POST | `/billing/invoices/:id/resend` | send the invoice (HTML + text) to its billing email; records `lastSentAt` and the provider that carried it, or `lastSendError` when the attempt failed |
| PATCH | `/billing/invoices/:id` | any field, plus `remindersPaused: true\|false` to stop or resume automatic reminders |
| GET | `/billing/invoices/:id/reminders` | the reminder ledger: each rung, its status (`sent`, `failed`, `skipped`, `sending`), recipient, time, `provider` and `error` |
| POST | `/billing/invoices/:id/reminder` | send one now, past the sweep gap; `action` is `sent`, `failed` or `skipped` with a `reason` (`paused`, `paid`, …) |
| POST | `/billing/reminders/run` | run the sweep immediately; returns `checked`, `sent`, `failed`, `markedOverdue`, per-invoice `items` and the `escalation` pass (`suspended`, `reinstated`) |
| POST | `/billing/payments/test` | prove the Stripe credentials against Stripe: `ok`, `mode`, `summary` and `checks[]` (`enabled`, `key`, `api`, `checkout`, `webhook-secret`, `webhook-endpoint`, `public-url`), each `pass`, `warn` or `fail` with the fix in `detail` |
| GET | `/billing/accounts?state=` | dunning state per billing email: `state` (`current`, `final-notice`, `suspended`), `finalNoticeAt`, `suspendOn`, `suspendedAt`, balance, extensions off and logins blocked |
| GET | `/billing/accounts/:id` | one account and the invoices billed to its email |
| POST | `/billing/accounts/:id/reinstate` | restore service: re-enables the extensions billing switched off and unblocks logins; `{force:true}` overrides a remaining balance |
| — | `402 payment_required` | a suspended customer's correct sign-in, and every authenticated call with its session |
| GET | `/public/pay/invoice/:id?t=` | signed link from a notice: creates a Stripe Checkout Session and 303s to it; a forged token is 403, an unconfigured Stripe is an HTML page, not a crash |
| GET | `/public/pay/account/:id?t=` | the same for a billing account, with one line per unpaid invoice and one charge for the whole balance |
| GET | `/public/pay/return?status=paid\|cancelled` | the page Stripe sends the customer back to; no console, no scripts |
| POST | `/public/stripe/webhook` | Stripe's callback, signature-verified: marks the named invoices paid (receipt in `paymentRef`), reinstates a suspended account, and is idempotent on replay |
| GET/POST/PATCH/DELETE | `/estate/sites[/:id]` | sites with counts derived from their devices, status and last contact |
| GET/POST | `/estate/devices` | real inventory rows: handset, gateway, ata, conference, door; `?site=&kind=&status=` |
| PATCH/DELETE | `/estate/devices/:id` | re-site, re-extension, change status or firmware, remove; MACs are unique |
| POST | `/estate/devices/:id/token` | issue a new check-in token; the previous one stops working |
| GET | `/estate/devices/:id/provisioning` | `?format=yealink|grandstream`: config with SIP account, encryption and a fresh token |
| GET/PUT | `/calls/:id/audio` | stream or attach the recording for a call leg |
| POST | `/devices/heartbeat` | **device token only** (`x-device-token`): stamp `last_seen_at`, report status, ip, firmware |
| DELETE | `/devices/heartbeat` | the device retires its own token and goes offline |
| GET | `/health/summary` | runtime, switch, delivery channels and current probe per target |
| GET | `/health/checks` | append-only probe history |
| POST | `/health/checks/run` | probe database, API, switch, delivery, directory hosts now |
| GET/POST/PATCH/DELETE | `/operations/tasks[/:id]` | `open → in_progress → done`, plus `blocked` |

---

## Softphone

SIP and media never pass through this API: the browser registers over secure WebSocket to
chan_pjsip and negotiates DTLS-SRTP directly with the switch. These endpoints hand out the session,
the ICE servers and the operator presence channel.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/softphone/status` | session | WSS URL, TLS fingerprint, ICE, video flag, operators online |
| POST | `/softphone/session` | session | mint a single-use ticket + SIP credentials + ICE servers |
| GET | `/softphone/ws?ticket=` | session + ticket | presence and call intents over WebSocket |

`POST /softphone/session` takes `{ "extension": "101" }` and returns:

```json
{
  "ticket": "sf_…",
  "expiresIn": 120,
  "wssUrl": "wss://pbx.example.com:8089/ws",
  "sip": {
    "uri": "sip:webrtc-101@pbx.example.com",
    "authUser": "webrtc-101",
    "extensionUser": "101",
    "password": "…"
  },
  "iceServers": [{ "urls": "stun:stun.l.google.com:19302" }],
  "media": { "audio": true, "video": true, "encryption": "dtls-srtp" },
  "recording": { "inbound": true, "outbound": false, "agent": "Reception", "source": "voice-agent" }
}
```

`sip.uri` and `sip.authUser` are the **WebRTC endpoint** identity, `webrtc-<ext>`, not the bare
extension: chan_pjsip resolves a registration by the user part of the request, so registering as
`101` would match the desk-phone endpoint and the call would lose DTLS-SRTP. `extensionUser` is the
extension as operators know it (dialing, voicemail, presence).

The ticket is single-use, expires after `SOFTPHONE_TICKET_TTL` seconds and is only accepted from a
same-origin upgrade. When `TURN_URLS` and `TURN_SECRET` are set, `iceServers` also carries a TURN
entry whose username is `<expiry>:<account>:<extension>` and whose credential is an HMAC of it — no
static relay password ever reaches the browser.

### WebSocket protocol

Server → client:

| Type | Meaning |
|---|---|
| `ready` | session accepted, includes the extension and its recording policy |
| `presence` | every operator online with their extension, state and peer |
| `line` | an extension is ringing / answered / ended, from Asterisk `Dial` events |
| `dial` | another operator dialed a number |
| `pong` | heartbeat reply |

Client → server: `state` (`idle`, `ringing`, `dialing`, `incall`, `away` + `peer`), `dial`, `dtmf`,
`bye`, `ping`. Close codes are `4401` (bad or replayed ticket) and `4403` (cross-origin).

## Connected systems

The external consoles this platform fronts (Capstone dashboard, Capstone workflow, FreePBX,
AvantFAX, Zeus). Each row is a host plus a landing path and a module catalog, with a live probe.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/systems?probe=1&refresh=1` | session or key | systems, module catalog and probe state; probes cached 60 s |
| POST | `/systems` | operator | register a system (`name`, `url`, `description`, `group`, `sortOrder`) |
| PATCH | `/systems/:id` | operator | rename, re-point, regroup or disable |
| DELETE | `/systems/:id` | operator | remove from the front door (nothing is deleted at the far end) |

Probes are `GET`, do not follow redirects, time out after 4 s and refuse private or loopback hosts.
A console that answers with a sign-in redirect — `302` to Authentik, `307` to `/login` — is reported
as `auth`, not as down; only a transport failure or a `5xx` counts as `down`. The summary object
always carries `total`, `up`, `auth` and `down`.

## System

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | none | liveness (also at `/healthz`) |
| GET | `/system/status` | session | telephony + registry + counts + channels + `payments` (enabled, configured, mode, `webhookUrl` — no key) |
| POST | `/system/apply` | operator | regenerate configs, reload Asterisk |
| GET | `/system/config-preview?file=` | session | generated `.conf` content |
| GET | `/system/domains` | session | directory hostnames |
| PATCH | `/system/domains/:slug` | owner | label, tagline, accent, scope, enabled |
| GET | `/system/keys` | session | key metadata (never the secret) |
| POST | `/system/keys` | owner | create; returns the secret once |
| DELETE | `/system/keys/:id` | owner | revoke |
| GET | `/system/vault` | owner | stored credential names, hints and dates — never values |
| PUT | `/system/vault/:name` | owner | `{ value }`; encrypted at rest, returns the hint only |
| DELETE | `/system/vault/:name` | owner | forget a credential |
| POST | `/system/email/test` | owner | `{ to? }`; sends through the stored mail key |
| GET | `/system/events?limit=` | session | audit trail |

### Credential vault

The vault holds outbound provider keys, so a key can be added or rotated from the
console without a rebuild. `:name` is upper case (`RESEND_API_KEY`, `EMAIL_FROM`).
The value is AES-256-GCM ciphertext under a key derived from `SESSION_SECRET`;
no endpoint returns it, and the audit trail records the name and the last four
characters only. Rotating `SESSION_SECRET` makes stored values unreadable and they
must be entered again.

```bash
curl -X PUT http://localhost:8080/api/system/vault/RESEND_API_KEY -b cookie.txt \
  -H 'content-type: application/json' -d '{"value":"re_…"}'
# { "secret": { "name": "RESEND_API_KEY", "hint": "••••a1b2", … },
#   "channels": { "email": { "provider": "resend", "configured": true, "source": "vault" } } }

curl -X POST http://localhost:8080/api/system/email/test -b cookie.txt \
  -H 'content-type: application/json' -d '{}'
# { "sent": true, "provider": "resend", "to": "owner@example.com" }
```

A stored `RESEND_API_KEY` wins the email path immediately — invoice resends,
directory verification codes and the test message all use it, while `RESEND_API_KEY`
in the environment still works for a compose-driven deployment.
| GET | `/submissions?status=` | session | moderation queue with counts |
| POST | `/submissions/:id/approve` | operator | publish a verified submission |
| POST | `/submissions/:id/reject` | operator | reject with a note |
| GET | `/optouts` | session | suppression list |
| DELETE | `/optouts/:e164` | operator | reverse an opt-out |
