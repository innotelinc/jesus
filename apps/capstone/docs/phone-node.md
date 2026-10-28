# The phone as a Capstone node

Capstone's tagline says the phone is the agent's *subject*, not its host. This
page is about the reverse: what a Motorola (or any Android) phone can actually
do for this deployment, what it cannot do, and how to wire up the part that is
genuinely supported.

## The short answer

**The phone cannot run Capstone.** It can be a first-class *node* of it.

| You want the phone to… | Works? | Detail |
|---|---|---|
| Run the full Capstone stack (`scripts/setup.sh`) | **No** | 58 services, ~5.8 GiB resident on the reference host, amd64-only images. See [why not](#why-the-full-stack-cannot-run-on-a-phone). |
| Be the SMS gateway (`SMS_PROVIDER=opensms`), both directions | **Yes** | Supported path: SIM SMS out, replies back in. [Path A](#path-a--phone-as-the-sms-gateway-recommended). |
| Be a softphone / Control Center client | **Yes** | Browser WebRTC, no install. [Path B](#path-b--phone-as-the-softphone-and-control-center-client). |
| Be a general Linux box for other work | **Partly** | Termux: userland only, no Docker, no systemd, no ports <1024. [Path C](#path-c--phone-as-a-general-linux-box-termux). |
| Run real Linux instead of Android | **Maybe** | postmarketOS, model-specific and experimental. [Path D](#path-d--postmarketos-a-real-linux-userspace). |
| Run the stack itself on ARM | **No** | Not a build problem only: 3 GB phones cannot hold 5.84 GiB of services. Measured per-image: [arm64.md](arm64.md). |

## Why the full stack cannot run on a phone

These are properties of this repository, not of phones in general.

- **58 services in one compose file.** `docker-compose.yml` defines 58 services
  (Asterisk/FreePBX + MariaDB, Postgres/pgvector, Redis, MinIO, n8n + sandbox
  runners, Grist, Grafana, Prometheus, the OTel collector, Kokoro TTS, Speaches
  STT, OmniRoute, coturn, oauth2-proxy, SearXNG, Dograh, dashboard, …).
- **~5.8 GiB of RAM before it is useful.** [`docs/host-move.md`](host-move.md)
  records the measured footprint — "`capstone` alone is 5.84 GiB of the 8.9" —
  on an 8-vCPU / 13.1 GiB host. A mid-range Moto has 4–8 GB total, shared with
  Android itself.
- **x86_64 assumption.** The offline bundle and the live/install ISO are
  `capstone-v2-live-amd64.iso`; several images are local builds with no arm64
  manifest. Even a perfect arm64 Linux phone would need a port, not a `up -d`.
- **It needs the Docker daemon.** Containers need namespaces, cgroups and an
  overlay filesystem from the kernel. Android does not expose those to apps;
  unrooted no, and rooted Android still is not a container host. `proot-distro`
  gives you a rootfs, **not** `dockerd` — it is a userspace `chroot`, so image
  handling works and container isolation does not.
- **Telephony wants the host.** Asterisk binds host networking with SIP/RTP
  (`5060/udp`, `8089/tcp`, coturn `3478`), which is the one thing a phone is
  worst at sharing.

So: keep the stack on a real host, and give the phone the job it is uniquely
good at — having a SIM card.

## Path A — phone as the SMS gateway (recommended)

Capstone already supports this: `SMS_PROVIDER=opensms` sends through a phone on
the LAN instead of a carrier API (`dashboard-backend/app/sms_transport.py`).
The phone runs a small HTTP server; Capstone calls `POST /sms/`.

You have two ways to serve that contract.

### A1. The Termux bridge in this repo (recommended)

[`phone-node/opensms_termux_bridge.py`](../phone-node/opensms_termux_bridge.py)
is a stdlib-only implementation of the OpenSMS contract over Termux:API. No
sideloaded APK, no root, and it answers `GET /health`, so the Control Center's
Settings card reports the gateway honestly instead of "not an SMS gateway".
It is **two-way**: outbound through the modem (with a SIP fallback), inbound by
polling the inbox and forwarding replies to Capstone.

**On the phone.** Install Termux, **Termux:API** and **Termux:Boot** from the
*same* source (F-Droid, or the GitHub releases — signatures must match, so do
not mix). Then:

```sh
pkg install -y git
git clone https://github.com/innotelinc/capstone.git
bash capstone/phone-node/install-termux.sh

# with replies wired to the host (the inbound half):
FORWARD_URL=http://192.168.1.52:8080/sms-inbound \
CAPSTONE_SMS_INBOUND_TOKEN=<the same 32-byte hex from .env> \
  bash capstone/phone-node/install-termux.sh
```

The first run adds `python` + `termux-api`, generates a bearer key in
`~/.opensms-bridge/key`, writes the boot script
`~/.termux/boot/90-opensms-bridge`, and runs a permission preflight. Re-running
with `FORWARD_URL` + token adds inbound polling to that same boot script and
stores the token in `~/.opensms-bridge/inbound-token` (mode 600, never argv).

Then, in Android:

1. **Settings → Apps → Termux:API → Permissions → SMS → Allow.** Sideloaded
   apps are blocked from this by default: if the toggle is greyed out, use
   *Allow restricted settings* from the app's ⋮ menu first.
2. **Settings → Apps → Termux → Battery → Unrestricted**, and turn off
   Motorola's battery optimisation for both Termux and Termux:Boot. Without
   this Android will freeze the server when the screen is off.
3. Give the phone a **static IP** (or a DHCP reservation on your router) — the
   `.env` value is an IP, and a lease change silently breaks SMS.

Start it now, and confirm it survives a reboot:

```sh
python ~/capstone/phone-node/opensms_termux_bridge.py \
    --key-file ~/.opensms-bridge/key --port 9292 \
    --log-file ~/.opensms-bridge/bridge.log &
```

**On the Capstone host.** Point the stack at the phone:

```sh
# .env
SMS_PROVIDER=opensms
OPENSMS_URL=http://192.168.1.77:9292      # the phone's fixed LAN IP
OPENSMS_API_KEY=<contents of ~/.opensms-bridge/key on the phone>
OPENSMS_TIMEOUT_MS=15000

# inbound (replies); generate with: openssl rand -hex 32
CAPSTONE_SMS_INBOUND_TOKEN=<32-byte hex; the same value goes to the phone>
```

Recreate the API after changing `.env` (the var is read at startup):
`docker compose up -d --force-recreate dashboard-api`.

Note the addresses: if Capstone runs in Docker, `127.0.0.1` is the *container*,
so `OPENSMS_URL` must be the phone's LAN IP even when the host is the same
machine. Then verify end to end:

```sh
curl -s http://192.168.1.77:9292/health          # expect {"ready": true, ...}
python3 scripts/opensms_client.py --check        # resolved provider/endpoint
python3 scripts/opensms_client.py --to +15551234567 --body "capstone phone node"
curl -s http://192.168.1.77:9292/sms/ -X POST \
  -H "Authorization: Bearer $OPENSMS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"number":"+15551234567","text":"direct"}'
```

The Control Center's **Settings → SMS transport** card can also set the provider
at runtime. Precedence is: `SMS_PROVIDER` in the container environment → the
card's saved state (`/state/sms-transport`) → `SMS_PROVIDER` in `.env` → Zeus.
So an explicit env var wins over the card; leave it unset if you want the card
to be authoritative.

`stat: true` means the phone handed the message to the carrier. It is **not** a
delivery receipt, and OpenSMS answers HTTP 200 even when it fails — always read
`stat`.

### Replies — the inbound half

Outbound was never the hard half; a platform that only sends is a pager. Replies
come back by polling the phone's inbox and forwarding each new message to
Capstone, so the path works without Zeus and without a carrier webhook.

How it behaves, because the details are what make it safe to leave running:

- **Baseline first.** The first poll records the existing inbox as already seen
  and forwards nothing — pointing this at a phone holding a year of messages
  should not fire a year of webhooks. `--forward-backlog` overrides.
- **Exactly once.** Each message gets an id derived from number + date + body;
  the receiver deduplicates on it, so a retry after a failed forward cannot
  double-post a reply.
- **Retry on failure.** A failed POST leaves the message unseen, so the next
  poll tries again; it is not dropped.
- **Only replies.** `type: sent` rows are ignored, so the phone never echoes
  Capstone's own outbound traffic back at it.

On the host the receiver is `POST /sms-inbound` in the dashboard API, guarded by
`CAPSTONE_SMS_INBOUND_TOKEN` (constant-time compare, and an **unset** token
answers 503 — closed, never open). `GET /sms-inbound?limit=50` returns recent
replies for the Control Center and agent tools; the token is never included.

```sh
curl -s -X POST http://192.168.1.52:8080/sms-inbound \
  -H "X-Capstone-SMS-Token: $CAPSTONE_SMS_INBOUND_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"test-1","from":"+15551234567","body":"hello","received_at":"2026-10-20 10:00"}'
# -> {"ok": true, "stored": true, "duplicate": false, "id": "test-1"}
```

If the dashboard is behind NPM/TLS, use the public `https://api.<domain>/sms-inbound`
for `FORWARD_URL`; the token rides in a header, not the URL.

### Answering from the Control Center

**Tools → SMS Inbox** lists those replies as conversations and replies from the
browser. The answer goes out through `POST /sms-outbound` on the dashboard API
(a session, not the phone's token), which calls the phone's own `/sms/` route —
always the phone, never `SMS_PROVIDER`, because the recipient must see the SIM
that wrote to them answer. Sent replies are appended to the same log with
`direction: "out"`, so `GET /sms-inbound` returns one thread; a `/state` that
cannot be written reports `recorded: false` rather than failing a delivered
message.

The sidebar entry carries an **unread badge** for replies nobody has opened. The
log has no read column — the phone appends to it — so "read" lives in the
browser: opening a thread records its message ids in `localStorage`
(`capstone.sms.read`), and the badge counts inbound rows whose id is not there.
Outbound rows never count, the marker survives a reload, and it is per browser
profile rather than per account. The badge polls `/sms-inbound` every 30s (and
not at all in a background tab), so it retracts as soon as a thread is opened;
an unreachable API means no badge rather than a broken shell.

### Backup path — PJSIP MESSAGE

If the modem refuses (no SIM, no credit, permission revoked), the node can send
the same SMS as a **SIP MESSAGE through Asterisk pjsip** instead. It is a
fallback, so it does not rely on a registration having gone well: it sends a
MESSAGE, answers the 401/407 Digest challenge, and retries once on timeout.
Configure it on the phone (or in the boot script):

```sh
PJSIP_SMS_HOST=192.168.1.52      # Asterisk
PJSIP_SMS_USER=8000              # an extension/endpoint with SMS permission
PJSIP_SMS_PASSWORD=<secret>
PJSIP_SMS_PORT=5060              # optional
PJSIP_SMS_DOMAIN=192.168.1.52   # optional: builds sip:<number>@<domain>
PJSIP_SMS_TO=sip:{number}@host   # optional: full URI template
SMS_FALLBACK=chain               # chain (default) | phone | pjsip | none
```

`POST /sms/` then reports which path carried the message —
`{"stat": true, "transport": "pjsip"}` — and `/health` lists both transports.
The MESSAGE client is MD5-Digest only (what Asterisk emits); it does not do TLS
or registration, deliberately.

### A2. The OpenSMS APK instead

The original [OpenSMS](https://github.com/daslearning-org/OpenSMS) app is the
interoperable alternative: Android 9+ (minSdk 28), port `9292`, `POST /sms/`
with a bearer key, `{"stat": true}`, key generated on first *Start Server*.
Same `.env` block as above.

Trade-off: it is an early-stage sideload, and its documented API has no
`/health`, so Capstone's Settings card will report *not an SMS gateway* on a
gateway that sends fine. Sends are unaffected. Treat the bridge in A1 as the
better-integrated choice and this as the fallback.

### Security for either option

The gateway speaks **plain HTTP** with one bearer key for outbound, and a second
shared secret for inbound forwarding. Keep it on the LAN: do not port-forward
`9292`, do not put the phone on a guest network that exposes it upstream. If
Capstone must reach the phone across the internet, put both on WireGuard/
Tailscale and use the tunnel IP. Both secrets are compared in constant time and
neither is ever logged.

## Path B — phone as the softphone and Control Center client

No install needed, and it is the phone's best voice role:

- **Softphone:** the Control Center ships an in-browser WebRTC phone that
  registers to Asterisk over WSS on `8089` (extension `101` by default) and
  pulls STUN/TURN from `/api/turnconfig`. Open the Softphone page on the phone
  over HTTPS — browsers only allow microphone capture from a secure context, so
  use the `voice.<domain>` hostname (or `localhost`), not a bare LAN IP.
- **Control Center:** health, ports, alerts, and live pipeline latency in
  Grafana all work fine in a mobile browser.

Requirements: `8089/tcp` WSS and `3478` TCP/UDP (coturn) reachable from the
phone; see [networking.md](networking.md). On a flat LAN this just works.

## Path C — phone as a general Linux box (Termux)

If the goal is "the phone is a Linux server" beyond SMS, Termux is the honest
version of that. It is a real Linux userland (same kernel as Android), with
limits worth knowing before you plan around it:

**Works:** `python`, `node`, `git`, `ssh`/`sshd` (port `8022`), `nginx` or a
plain HTTP server on a high port, SQLite, cron-like `termux-services`,
`proot-distro` for a Debian/Ubuntu rootfs when you need distro packages.

**Does not work:**

- **Docker / anything needing `dockerd`.** No kernel namespaces or cgroups for
  containers, even under `proot-distro`. Rootless Docker needs subordinate UID
  maps (`newuidmap`) that Android does not provide.
- **systemd.** Nothing here is a systemd host; use Termux scripts/services.
- **Ports below 1024** as an unprivileged app. Bind `8080`/`9292`/`8022` and
  proxy if you need `80`/`443`.
- **Kernel modules, iptables, bridges.** No root.

**Keeping it up is the hard part.** `termux-wake-lock` (requested by the
installer's boot script) keeps the CPU up through ordinary sleep, but Android's
Doze ignores wake locks, and vendor power management can still kill Termux. Set
battery use to **Unrestricted** for Termux + Termux:Boot and expect to test
after a real reboot with the screen off. A phone is not a server with an SLA.

Two practical notes: keep it on a charger (and be aware a battery held at 100%
degrades — a charge limiter is kinder), and remember that **mobile data is
usually behind CGNAT**, so inbound access needs a tunnel (WireGuard/Tailscale/
Cloudflare Tunnel) even when the phone "has internet". On Wi-Fi, guest networks
often enable AP isolation, which blocks host→phone traffic and is the most
common cause of "connection refused" here.

## Path D — postmarketOS (a real Linux userspace)

If you want Android gone rather than coexisting, postmarketOS is the only
serious option, and it is **model-specific**. Check your codename in Termux:

```sh
getprop ro.product.device        # e.g. river, ocean, ali, cedric, potter
```

| Motorola model | Codename | Kernel path |
|---|---|---|
| Moto G5 | `cedric` | mainline |
| Moto G5 Plus | `potter` | mainline (variant quirks) |
| Moto G6 | `ali` | mainline, testing |
| Moto G7 | `river` | mainline, testing |
| Moto G7 Power | `ocean` | mainline, testing |
| Moto G7 Play | `channel` | port listed |
| Moto G7 Plus | `lake` | port listed |
| Moto G4 Play | `harpia` | mainline (port archived) |
| Moto G (2015) | `osprey` | mainline |
| Moto G30 | `caprip` | mainline |
| Moto E (2014/2015) | `condor` / `surnia` | port listed |

Reality checks, in order of how likely they are to stop you:

1. **The bootloader must be unlockable.** Motorola grants unlock keys per
   model via its bootloader-unlock portal; some carrier models are excluded, and
   unlocking wipes the device and voids the warranty.
2. **Cellular is often broken.** Documented states include calls/SMS/data broken
   on the Moto G6, partial calls on the G7, and broken mobile data on the G7
   Power. A phone whose modem does not work cannot be Path A either.
3. **It still cannot run Capstone.** arm64 and 4–8 GB does not change the
   reasons in [why not](#why-the-full-stack-cannot-run-on-a-phone); you would
   need an arm64 port of the images *and* more RAM.

If the goal is a server rather than a phone, a used x86 mini-PC with 16 GB costs
less than a Motorola that can be unlocked, and runs this stack as shipped.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `curl` to `:9292` → *connection refused* | Server not running, wrong IP, or router AP isolation / guest Wi-Fi. Start it, fix the IP, use the main SSID. |
| `--check` says ready, `/health` says 503 | `termux-api` installed but the Termux:API **app** is missing, or SMS permission was not granted. Re-run `--check` for the reason. |
| `401 Invalid or expired API key` | Key mismatch. `cat ~/.opensms-bridge/key` on the phone and paste into `.env`; restart the server after changing it. |
| `stat: false` + *permission denied* | Grant SMS to Termux:API (mind *Allow restricted settings*). |
| Works, then dies after ~10 minutes | Battery optimisation / Doze. Set Termux to Unrestricted, keep the wake lock, and check `~/.opensms-bridge/bridge.log`. |
| Control Center shows *not an SMS gateway* | You are on the OpenSMS APK, which has no `/health`. Sends still work, or switch to A1. |
| Sends work from the host but not from containers | `OPENSMS_URL` is a loopback or Docker-network address; use the phone's LAN IP. |

## Tests

The bridge's contract is covered without a phone — a stub `termux-sms-send`
stands in for the modem, and the last test drives the repo's own
`scripts/opensms_client.py` against it:

```sh
python3 phone-node/test_bridge.py         # outbound contract, chain, inbound polling
python3 phone-node/test_sip_message.py    # digest auth against a fake Asterisk
python3 phone-node/test_e2e_inbound.py    # poller -> live dashboard API (needs uvicorn)
```
