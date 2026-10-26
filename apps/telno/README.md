<div align="center">

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-brightgreen.svg)](LICENSE)

# ☎️ Telno — Telephony Platform & Worldwide Phonebook

**The phone system and the phonebook in a single container — extensions, trunks, IVR, voicemail, fax, SMS, AI voice agents, an encrypted WebRTC softphone, automatic billing and a device estate. One image, one database, no per-seat fees.**

Telno is a self-hosted telephony platform and a worldwide number registry that answer together: the
same image that answers a call also answers *who is this number?* — on six public directory hostnames,
with one login and one source of truth.

[![CI](https://github.com/innotelinc/telno/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/telno/actions/workflows/ci.yml)
[![Pages](https://github.com/innotelinc/telno/actions/workflows/pages.yml/badge.svg)](https://github.com/innotelinc/telno/actions/workflows/pages.yml)
[![theme: Unity](https://img.shields.io/badge/theme-Unity-6366f1)](https://github.com/innotelinc/innotel-platform-stack/tree/main/standards/unity)
[![Runtime](https://img.shields.io/badge/runtime-Node%2024%20·%20Fastify%205-1f6feb)](package.json)
[![Database](https://img.shields.io/badge/database-SQLite%20·%20node:sqlite-0b7285)](src/db/schema.sql)

**Landing page:** [innotelinc.github.io/telno](https://innotelinc.github.io/telno) ·
**Platform stack:** [innotelinc/innotel-platform-stack](https://github.com/innotelinc/innotel-platform-stack)

</div>

---

One telephony platform, one API, one number registry, six public directory hostnames — in a single
container.

```
   ┌─────────────────────────── docker container ───────────────────────────┐
   │                                                                        │
   │  Asterisk 20 ──AMI──►  Fastify control API  ◄──HTTP──  React UI (static)│
   │      │                        │                        + /d/<host>      │
   │      │                      SQLite                                      │
   │      └──── SIP / RTP          │                                         │
   │                               └──►  registry + directory               │
   └────────────────────────────────────────────────────────────────────────┘
        one image · two processes · one database · ~200 MB RSS
```

## What it replaces

A live audit of the running stack (see [docs/AUDIT.md](docs/AUDIT.md)) found four applications, four
logins, three design systems and no shared API: Zeus (Next.js), Capstone (Next.js), FreePBX (PHP) and
AvantFAX (PHP). This rebuild collapses them into one control plane with a single identity, a single
number table and one design system.

| Requirement | Where it lives |
|---|---|
| Modern interface | `web/` — dark shell, tokens derived from the audited app, container queries, real focus states |
| Robust UI | every screen has loading / empty / error states; forms validate server-side; keyboard + screen-reader paths |
| New features | worldwide registry, verification queue, DID routing, live channel view, config preview, audit trail |
| Plug and play | `docker compose up`, secrets self-generate, demo data optional, verification channel set by one env var |
| All in one | Asterisk + API + UI in one image, one database, one supervisor |
| Docker container | [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml) |
| Dedupe | E.164 is the primary key; listings dedupe on normalized name; submissions detect duplicates before review |
| Slimmer platform + API | Node 24 + SQLite (`node:sqlite`, no native modules) + static UI — no SSR runtime, no ORM, no Redis |
| Worldwide phonebook | `telno.directory`, `num.directory`, `number.directory`, `directory.telno.services`, `directory.pbx.services`, `directory.pbx.technology` |

## Quick start

```bash
docker compose up -d --build
docker compose logs -f telno
```

First boot prints the generated owner password once:

```
================================================================
  First run — owner account created
  Email:    admin@telno.local
  Password: <generated>
================================================================
```

Open <http://localhost:8080> and sign in. The public directory is at
<http://localhost:8080/d/telno.directory>.

Optional demo data (27 listings across 19 countries, 5 extensions, 180 calls, a moderation queue):

```bash
docker compose exec telno node src/seed.js
```

### Without Docker

```bash
npm install
npm run build
npm run seed          # optional demo data
SESSION_SECRET=local-dev TELEPHONY_SIMULATE=true npm start
```

`TELEPHONY_SIMULATE=true` runs the platform without a switch — useful for UI work. Everything else
behaves identically.

## Verify it

```bash
npm run smoke       # 237 end-to-end checks against a running instance
```

The suite covers number normalization across 245 countries, dedupe, submission → OTP → approval,
opt-out and reversal, API-key scopes, config generation and session invalidation. It cleans its own
fixtures, so it can be run repeatedly.

## Directory hostnames

All six hosts serve the same registry and the same code; each has its own label, tagline and accent,
edited in **Settings → Directory hostnames**. Point DNS at the container and add the hosts to your
reverse proxy. The app matches the request host only for presentation — data is shared by design.

Branding also works per-request through the path (`/d/directory.pbx.services`), which is handy before
DNS is ready.

## Verification of listings

A listing is only published after two independent steps:

1. **Proof of control** — the submitter receives a 6-digit code on the number itself (SMS) or on an
   address they control (email). Codes are hashed, expire in 10 minutes, and allow 5 attempts.
2. **Operator review** — a verified submission sits in the moderation queue until an operator
   approves it.

Delivery is pluggable. Without configuration, codes are logged to the container output (and returned
in the API response outside production so the flow stays testable). Set one variable to go live:

```yaml
environment:
  NOTIFY_CHANNEL: twilio      # or resend for email
  # TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM
  # RESEND_API_KEY
```

## API

Full reference: [docs/API.md](docs/API.md). Public lookups need no key; everything else uses a session
cookie, bearer token, or `x-api-key`.

```bash
# Public: resolve and look up any number
curl "http://localhost:8080/api/public/lookup?number=+44%2020%207946%200958"

# Search the worldwide directory
curl "http://localhost:8080/api/public/search?q=coffee&country=US"

# Authenticated registry access with an API key (create one in Settings)
curl -H "x-api-key: tl_…" "http://localhost:8080/api/numbers?limit=5"
```

## Console

Nineteen screens behind one login, grouped the way the work is done:

| Group | Screens |
|---|---|
| Telephony | Dashboard, Softphone, Call history, Extensions, Trunks, Call routing, Voicemail, Fax, Messages |
| Voice & automation | Voice agents, Workflows |
| Registry | Numbers, Moderation |
| Business | Billing, Estate |
| Operations | Health, Operations, Connected systems, Settings |

Every screen reads and writes the API in [docs/API.md](docs/API.md) — no screen keeps its own copy of
the data — and refreshes its counters after each write so the tiles and the list never disagree.

## Softphone and encrypted calling

**Softphone** is a real browser phone: audio and video, screen sharing, DTMF into IVRs, and a live
read-out of whether the call is encrypted. It registers as a second endpoint on the same extension,
so calling 101 rings the desk handset and the browser at the same time.

The two endpoints are `<ext>` for the handset and `webrtc-<ext>` for the browser, and each
authenticates as its own name — chan_pjsip identifies a registration by the user part of the
request, so a browser that registered as plain `101` would land on the handset endpoint and lose
DTLS-SRTP. The softphone session endpoint returns the right identity; nothing in the UI has to know.

```
browser ── SIP over WSS ──▶ chan_pjsip :8089        signaling, TLS only
browser ◀─ DTLS-SRTP ─────▶ Asterisk   RTP 10000–10100 (published by compose)
browser ── presence ──────▶ /api/softphone/ws      who is on the line, call intents
```

Nothing in the path is optional. The generated `webrtc-<ext>` endpoint is `media_encryption=dtls`,
`ice_support=yes`, `rtcp_mux=yes`, `use_avpf=yes`, and only offers `opus`, `ulaw`, `alaw` plus `vp8`
and `h264` when video is enabled — a plaintext RTP attempt cannot negotiate at all. The platform
never touches media: it mints a single-use ticket, hands the browser its own extension credentials
and time-limited TURN credentials, and keeps the presence channel. See [docs/API.md](docs/API.md).

| Need | Setting |
|---|---|
| Public address of the switch socket | `SOFTPHONE_WSS_URL` (default `wss://<host>:8089/ws`) |
| Certificate | generated under `ASTERISK_CONFIG_DIR/keys` on first apply, or `SOFTPHONE_TLS_CERT` / `SOFTPHONE_TLS_KEY` |
| Publish the port | `8089` in compose, plus `10000–10100/udp` for media |
| Hard NAT | `TURN_URLS` + `TURN_SECRET` (coturn `use-auth-secret`); STUN alone is otherwise fine |
| Docker NAT | `ASTERISK_EXTERNAL_ADDRESS` (defaults to the `PUBLIC_URL` host) — otherwise ICE advertises the container IP and media never arrives |
| Video | `SOFTPHONE_VIDEO=false` removes the video codecs and the stream limit |

### The phone in its own window

A page's registration dies with the page: navigate the console and the softphone unmounts, so a call
in progress goes with it. The softphone therefore has its own window
(`/softphone?window=1`) — its own document and its own user agent, with no sidebar or topbar, sized to
sit beside the console. The phone icon in the topbar opens it from any screen; **Open in a window** on
the softphone page does the same.

Reopening focuses the running window instead of making a second one. That is not cosmetic: a window is
opened by name, and passing a URL to an existing window reloads it — which would drop the call. The two
sides agree over a `BroadcastChannel`, so the console only calls `window.open` when nothing answers.
Closing the window releases the extension; leaving it open keeps the line registered while you read a
call log, edit a voice agent or publish to the directory.

**Encryption is per leg, and that is the honest limit.** Your leg is DTLS-SRTP the moment you use
the softphone; the far leg is encrypted only if the carrier or the other end encrypts it. Over a SIP
trunk ask for TLS signaling plus SRTP media from the provider — if they cannot offer it, the call is
protected inside your network and plaintext on their network. That is a property of the PSTN, not of
this container, and the UI reports what your leg actually negotiated rather than claiming the call is
end-to-end secure.

### Proving it end to end

A fresh container has no extensions, so the switch starts with no endpoints at all. The order that
works is: bring it up, add an extension, apply the config, then register in the browser.

```bash
docker compose up -d --build
docker compose exec telno sh -c 'ls /etc/asterisk/keys'   # telno.crt / telno.key exist

# 1. create the extension the browser will register as (secret comes back once)
curl -s -X POST http://localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@telno.local","password":"<first-boot password from docker compose logs>"}' -c /tmp/c.txt
curl -s -X POST http://localhost:8080/api/extensions -b /tmp/c.txt -H 'content-type: application/json' \
  -d '{"extension":"101","displayName":"Front Desk","voicemail":true}'

# 2. generate the endpoint and reload the switch
curl -s -X POST http://localhost:8080/api/system/apply -b /tmp/c.txt -H 'content-type: application/json' -d '{}'

# 3. the WSS listener is live
openssl s_client -connect localhost:8089 -brief </dev/null 2>&1 | head -5
```

Then open **Softphone**, pick 101, and press **Connect softphone**. The registration badge must read
*Registered* and the signaling tile must show `wss://<host>:8089/ws`.

A self-signed certificate is the one thing a browser will not work around: Chrome refuses a WSS
connection to an untrusted certificate and offers no "continue anyway". Either trust the generated
certificate on the client (`certutil -user -addstore Root /etc/asterisk/keys/telno.crt` on Windows, or
the equivalent for your platform for that one certificate only), or supply a real one with
`SOFTPHONE_TLS_CERT` / `SOFTPHONE_TLS_KEY`. The platform reports the listener's SHA-256 fingerprint in
`GET /api/softphone/status` so you can check what you are trusting.

For a call, media has to reach the switch: publish `10000–10100/udp` (compose does), and set
`ASTERISK_EXTERNAL_ADDRESS` to the host address the browser can see — otherwise ICE advertises the
container's internal IP and audio never connects.

### A From header a browser will accept

A browser is stricter than a desk phone: its SIP stack parses every header before the call exists, so
it rejects a message it cannot read. Two things in the generated endpoint follow from that.

- **`from_domain`** — the switch puts `SIP_DOMAIN` (default: the `PUBLIC_URL` host) in the From/To
  URI. Docker names containers with a hex id, and a digit-leading host parses as a malformed IPv4
  address; the browser then refuses the whole INVITE and the call rings silently. Set `SIP_DOMAIN`
  to your real domain (`SIP_DOMAIN=telno.services`) in production.
- **The switch is built from source.** The packaged switch cannot take a browser INVITE: its RTP
  engine is compiled with a small packet ceiling and its negotiate stage drops the SDP that WebRTC
  offers, so a DTLS-only endpoint gets `488` while a plain handset works fine. The image builds
  Asterisk with its bundled pjproject on Debian for this reason — see the comments in the
  [Dockerfile](Dockerfile). Alpine is not a substitute: musl's headers break the switch's own
  allocator macros during the build.

### What a passing call looks like

Verified against a running container: the browser registered over `wss://localhost:8089/ws`, the
softphone dialed `101`, and the call came up with media in both directions.

```
[101] MEDIA DTLS-SRTP — Browser leg encrypted
[102] MEDIA DTLS-SRTP — Browser leg encrypted

 30f6c5d6 webrtc-101-0000000 00:00:47 opus  326  0  0%  322  0  0%
 30f6c5d6 webrtc-102-0000000 00:00:47 opus  322  0  0%  323  0  0%
```

The badge is not a guess: it follows the WebRTC transport's `dtlsState` to `connected` before it
claims encryption, so a call that never completes the handshake reads *No DTLS on this leg*. On the
switch side the same endpoints are `media_encryption=dtls` with no plaintext path at all — media can
only flow once the handshake finishes, which is why packets are counted on both channels.

That is the leg the platform controls. The far leg of a PSTN call is encrypted only if the carrier
offers TLS and SRTP — the badge reports what was negotiated rather than promising more.

### Recording policy reaches the switch

Voice agents own a per-direction recording policy (`recordInbound`, `recordOutbound`). Because only
the dialplan can start a recording, the generator writes it into `extensions.conf`: an inbound DID
whose number has an active agent with `recordInbound` gets `Set(__TELNO_AGENT=…)` and `MixMonitor`
before the call is routed, and outbound calls set `__TELNO_RECORD_OUT` from the caller's extension
before dialing through the trunk. Turning the switch off in the console removes those lines on the
next **Apply config** — the UI and the switch cannot disagree. `MixMonitor` events are then matched
to the call row, so the recording is playable from call history.

## Connected systems

FreePBX, AvantFAX, Zeus and the two Capstone consoles keep their own admin surfaces, so instead of
two front doors there is one: **Connected systems** registers each of them with its landing path and
its full module catalog, and probes them server-side every minute.

```
dashboard.pbx.it.com/interviews   ops console: interviews, agents, softphone, SMS, ports, secrets, config (26 modules)
pbx.it.com/workflow              Capstone voice platform
workflow.pbx.it.com              the same workflow product behind the Authentik gateway
pbx.pbx.it.com/admin/config.php  FreePBX administration
pbx.pbx.it.com/fax/inbox.php     AvantFAX inbox
app.pbx.services/dashboard/operations  Zeus
```

The landing page carries the same list as a status band, and every module is one search away on the
systems screen. A console that answers with a sign-in redirect is reported as **SSO sign-in** — that
is health, not failure — while only transport errors and `5xx` count as down. Nothing is proxied or
cached: the platform is the front door and the index, and the consoles stay the system of record for
their own data. Register or re-point a system from the screen, or with the API:

```bash
curl -X POST http://localhost:8080/api/systems -b cookie.txt -H 'content-type: application/json' \
  -d '{"name":"Lab PBX","url":"https://lab.example.com/admin"}'
```

## Email and the credential vault

Outbound mail goes through **Resend or Mailjet** — the operator picks, and the keys live in an encrypted
vault inside the container rather than in the image, the compose file or a chat message. **Settings →
Email delivery** takes either provider's credentials, a sender address and the choice of which one
sends, then **Send test** proves the container can actually reach it.

Both providers can hold a key at once, so switching is a dropdown rather than a paste: the choice is
stored as `EMAIL_PROVIDER` in the same vault and takes effect on the next message, with no restart. An
explicit choice beats a key being present — a stored Resend key does not win while Mailjet is selected
— and a provider chosen without credentials fails loudly (`mailjet_not_configured`) instead of
falling back to the log, because a customer waiting on a final notice must not be failed silently.
Mailjet authenticates with a key *and* a secret; one without the other is treated as not configured.

```
key  ──AES-256-GCM──▶ /data/telno.db (secrets table)
API  ──never returns the value──▶ hint only: ••••a1b2
mail ──▶ invoice resends, directory verification codes, reports, test message
```

The same provider serves every message, so resending an invoice from Billing, a listing owner
verifying their entry, and the test button cannot disagree about whether mail works. Values are
encrypted under a key derived from `SESSION_SECRET`, which means a copy of the database does not
disclose a provider key — and that rotating `SESSION_SECRET` requires re-entering the values.
`RESEND_API_KEY`, `MAILJET_API_KEY`/`MAILJET_API_SECRET` and `EMAIL_PROVIDER` in the environment still
work for a compose-driven deployment, but vault entries take precedence and need no restart.

```bash
# Store or rotate the key without touching the container
curl -X PUT http://localhost:8080/api/system/vault/RESEND_API_KEY -b cookie.txt \
  -H 'content-type: application/json' -d '{"value":"re_…"}'
curl -X POST http://localhost:8080/api/system/email/test -b cookie.txt -H 'content-type: application/json' -d '{}'
```

## Operations

| | |
|---|---|
| Data | `/data` volume — SQLite database plus generated session/API/AMI secrets |
| Switch config | `/etc/asterisk` volume — regenerated from the database on every boot and on **Apply config** |
| Health | `GET /healthz` and `GET /api/healthz`; compose health check included |
| Backup | `docker compose exec telno sh -c 'sqlite3 /data/telno.db ".backup /data/backup.db"'` (or copy the volume while stopped) |
| Memory | Node capped at 192 MB; whole container fits comfortably in 512 MB |
| Ports | 8080 and 8089 published; 5038 (AMI), 5060/UDP and 10000–10100/UDP only when this box terminates calls |

For a real switch behind NAT, use `network_mode: host` (commented in the compose file) so SDP and RTP
are not rewritten.

### Recordings, fax content and billing

Call and voicemail audio lives on the data volume under `/data/recordings` — the database stores only
the file name. Voicemail audio can be attached from the console, and calls recorded by the switch are
playable from the call log. A fax is either a typed plain-text page or an uploaded PDF/image.

Voice agents record per direction (`recordInbound`, `recordOutbound`); both off means never. Invoices
can be corrected after they are issued, resent to the billing email, or marked paid by hand — each of
those is an audited action, not a silent edit.

A resent invoice is an HTML email: the invoice number, the amount in the invoice's own currency, the
billing period and the due date (or *paid on* for a settled one), with the same content as a text part
for clients that refuse markup. Both parts come from one template in
[mail.js](src/lib/mail.js) reading one row, so the subject, the HTML and the text cannot disagree.
The subject says *paid* rather than *due* once an invoice is settled — chasing a paid bill is the
fastest way to look like a broken system.

Money and dates are US throughout: dollars first, **MM/DD/YYYY**, 12-hour times.

### Reminders chase a past-due invoice by itself

A sweep runs at boot and every `REMINDER_SWEEP_MINUTES` (30 by default). It marks open invoices whose
due date has passed as `overdue`, then sends a reminder for each rung of `REMINDER_DAYS`
(`1,3,7,14,30` days past due) to the invoice's billing email. Each reminder is the same card as the
invoice — amount, due date and how many days late it is in the subject, the HTML and the text part.

The rungs live in a ledger (`invoice_reminders`), not in a counter. A row is written *before* the
provider is called and the (invoice, rung) pair is unique, so a restart, a second sweep or two
operators clicking **Run reminders now** cannot produce the same reminder twice. An invoice that is
already 40 days late gets the rung it has reached and records the rungs it missed as `skipped` rather
than firing a burst of five emails. A failed send stays open for a retry but waits out
`REMINDER_GAP_HOURS` first.

What stops a reminder: the invoice becoming paid or void, `remindersPaused` on that invoice, or no
billing email. **Send reminder now** in the invoice dialog ignores the gap for one deliberate nudge;
**Run reminders now** on the Billing screen does a full pass without waiting for the timer. Every
attempt, including failures and skipped rungs, is visible in the invoice dialog and audited.

Each row also names the provider that carried it — `provider` on the ledger, `lastProvider` and
`lastSendError` on the invoice — so "it says sent" can be traced to Resend, Mailjet or the container
log per message. A failed attempt records who was asked and why it failed while keeping the last
successful send time, which is what makes a provider outage visible without reading the service log.

### Escalation: a final notice, then suspension, then automatic restoration

An invoice that passes `FINAL_NOTICE_DAYS` (30 by default) stops being a reminder problem. One final
notice replaces the last rung — never an extra email on top of it — and it names the exact day
service stops: the notice date plus `SUSPEND_GRACE_DAYS` (14 by default). The ledger records it as
`kind: final`, so a second sweep cannot warn the same customer twice and the rungs it replaced are
recorded as `skipped`.

That date is stored on the billing account and acted on, not recomputed. When it arrives and money is
still owed, the sweep suspends the account:

- every extension whose `email` matches the billing identity is switched **off** and flagged
  `suspended_by_billing`; the Asterisk config is rewritten and reloaded, so the lines stop registering;
- customer logins on that email are blocked with **HTTP 402 `payment_required`**, and their sessions end
  immediately. The **owner role is never suspended** — locking the last administrator out of the
  platform is not a billing remedy;
- the customer gets a suspension email saying what stopped, what is owed and that payment restores it;
- further reminders stop: a reminder would point at a phone that no longer rings.

The identity is the invoice's billing email, lower-cased — one customer, one state, however many
invoices they owe. Currencies are never added together: the largest balance is the headline and each
currency stays separate.

Payment is the only thing anyone has to do. On the next sweep a suspended account whose balance has
gone to zero is reinstated automatically: the extensions the platform switched off come back on,
flagged logins are unblocked, the config is reloaded and no fee or phone call is involved. An
operator can also reinstate by hand from the Billing screen, which asks for confirmation when money
is still owed. `ESCALATION_ENABLED=false` keeps the reminder ladder running but never switches a
customer off.

### Paying from the notice

The final notice and the suspension email carry a **Pay now** button. It points at this platform, not
at Stripe directly: `/api/public/pay/invoice/<id>?t=<token>` creates a fresh Checkout Session and
redirects, so an old email still works after the session it would have used has expired. The token is
an HMAC over the invoice id — derived, never stored, and it grants exactly one thing: paying that bill.

The suspension email points at the account instead, which puts **every** unpaid invoice on one page.
A customer with three late invoices should not have to make three card payments to get their phones
back. Currencies are never mixed in a charge; the largest balance is what the page shows.

When Stripe confirms the payment it calls `POST /api/public/stripe/webhook`. The body is verified
against the endpoint secret in constant time with the timestamp checked, the invoice is marked paid
with the payment reference kept as a receipt, and a suspended account is reinstated immediately
rather than at the next sweep. Marking paid is idempotent: a replayed event is a no-op.

To switch it on:

1. Stripe → Developers → API keys → copy the secret key, and paste it into **Settings → Vault** as
   `STRIPE_SECRET_KEY` (or set it in `.env`). A vault key wins over the environment, so it can be
   rotated without a rebuild.
2. Stripe → Developers → Webhooks → add `https://<your-host>/api/public/stripe/webhook` for
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`, then store its signing
   secret as `STRIPE_WEBHOOK_SECRET` the same way.
3. Make sure `PUBLIC_URL` is the address customers actually reach: the links in the email are built
   from it.

Until a key is present the notices simply have no button — a dead button that opens a "payments are
not configured" page is worse than none, because it looks like the invoice was lost. `PAYMENTS_ENABLED=false`
turns the whole path off. Card details are entered on Stripe's page and never touch this platform, so
there is nothing here to be PCI-scoped for.

**Test Stripe connection** on the Billing screen (Escalation card) asks Stripe rather than trusting a
stored string: the key is proven with a balance call, write access with a $0.50 session that is expired
immediately, the webhook secret by signing a throwaway body and putting it through the same verifier
the live endpoint uses, and the registered endpoint by matching the URL and the two payment events
from Stripe's own list. Each row says `pass`, `check` or `fail` with the specific fix — an endpoint
left pointing at last week's host, a revoked key, or a `PUBLIC_URL` of `localhost` that Stripe can
never call are the failures a green badge would otherwise hide.

### Devices check themselves in

Every handset, gateway, ATA or door phone gets a `dv_…` token when it is added on the Estate screen
(shown once). Point the device — or a provisioning cron — at the heartbeat and its status and
last-seen stay current without an operator touching the row:

```bash
curl -X POST http://localhost:8080/api/devices/heartbeat \
  -H "x-device-token: dv_…" -H "content-type: application/json" \
  -d '{"status":"online","ip":"10.10.1.21","firmware":"96.86.0.15"}'
```

The reply says when to come back (`checkInSec`) and when the platform would treat it as silent
(`staleAfterSec`). A live device that stops checking in shows as **silent** and counts toward the
attention tile; rotate its token to cut off a lost or replaced handset.

## Repository

```
src/                 Fastify API
  db/                schema + node:sqlite access layer
  lib/               E.164, registry dedupe, security, channels, audit
  telephony/         AMI client, config generation, CDR ingest
  routes/            auth, registry, directory, telephony, system, workspace, systems
web/                 React UI (Vite, static build) + design system
web/landing/         GitHub Pages landing site (vendored Unity theme)
docker/              entrypoint, supervisor, base Asterisk config
scripts/             CDP page profiler, end-to-end smoke test
docs/                audit, architecture, API reference
.github/workflows/   CI (smoke suite) and the Pages publish
```

## Production readiness

What is already true of this code: passwords are stored with scrypt, sessions are HMAC-signed and
revocable per account (`token_version`), cookies are `httpOnly` + `sameSite=lax` and `secure` in
production, the API applies CSP, frame denial and a permissions policy, provider and payment keys live
in an encrypted vault that never returns a value, Stripe webhooks are signature-verified, migrations
run in place on boot, the container ships a `HEALTHCHECK`, and a reminder cannot be sent twice because
the (invoice, rung) pair is unique in the ledger.

What still has to be done before this serves paying customers, in the order it matters:

| # | Item | Why it matters |
|---|---|---|
| 1 | **A backup and restore path for the data volume** | It holds the database, call recordings, voicemail audio and fax documents. Nothing here backs it up for you. |
| 2 | **A non-root container** | The image has no `USER` directive; Asterisk and the API currently run as root under the supervisor. |
| 3 | **Real TLS** | The console expects HTTPS in front (`secure` cookies are on in production) and the softphone's WSS listener serves a self-generated certificate unless `SOFTPHONE_TLS_CERT` and `SOFTPHONE_TLS_KEY` point at a real one. Browsers refuse an encrypted socket to a host with no certificate. |
| 4 | **A deployment checklist that asserts its own inputs** | `assertConfig` enforces `SESSION_SECRET` and nothing else; a production boot should also refuse a default admin password and an `http://` public URL. |
| 5 | **Monitoring that outlives the process** | Health probes are read inside the console. A crash that takes the container down should page someone outside it. |

## Notes and limits

- The demo seed uses ranges reserved for fiction (US `555-01xx`, UK `020 7946 0xxx`); it is not real
  subscriber data.
- The image has been built and run locally: `docker compose up -d --build` reaches a healthy
  container with the switch connected, and the served console bundle is checked against the source it
  was built from. It is not yet exercised on a hardened host — see [Production readiness](#production-readiness).
- Voicemail prompts and IVR audio are files on the switch (`custom/telno-<extension>`); recording
  management is out of scope for this version.
- One container, one tenant. Multi-tenant isolation would need a tenancy key on the registry tables.
