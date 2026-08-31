# PBX / Asterisk side — FreePBX 17 + dograh ARI wiring

Runs the Innotel FreePBX fullstack image (`ghcr.io/innotelinc/pbx-portal:latest-fullstack`,
built from [pbx-portal](https://github.com/innotelinc/pbx-portal)) and wires it
to dograh over ARI:

| File (in `pbx/asterisk/`) | Injects into `/etc/asterisk/` | Purpose |
|---|---|---|
| `ari.conf` | `ari.conf` | ARI user `[dograh]` — Stasis app name + password |
| `http.conf` | `http.conf` (only if missing) | Asterisk HTTP on 8088 |
| `websocket_client.conf` | `websocket_client.conf` | External media WS → dograh-api |
| `extensions_custom.conf` | merged into `extensions_custom.conf` (idempotent) | `[dograh-inbound]` dialplan → `Stasis(dograh)` |

`pbx/entrypoint-dograh.sh` copies these into the `pbx-asterisk-config` volume
on every boot, then execs the stock entrypoint (MariaDB → Asterisk → web
stack). FreePBX regenerates `extensions.conf` on Apply Config but **not** the
four files above, so the injection survives GUI reloads.

## Run

The PBX is a service in the main compose file, so the whole stack starts with
one command:

```bash
# Full capstone stack (dograh + PBX together)
docker compose up -d

# PBX only (the freepbx service)
docker compose up -d freepbx

# Optional: also start the PBX Customer Portal (Next.js)
docker compose --profile portal up -d
```

Add to `.env` (see `.env.example`):

```bash
# openssl rand -base64 24
DOGRAH_ARI_PASSWORD=<strong-password>   # MUST match dograh UI "App Password"
DOGRAH_WS_URI=ws://host.docker.internal:8000/api/v1/telephony/ws/ari  # default
FREEPBX_AMI_SECRET=<openssl rand -base64 24 | tr -d '/+='>   # only if the portal profile is used — strip '/','+','=' so it can't break the entrypoint sed
```

## Route calls into dograh (automatic with setup.sh)

The dialplan context `[dograh-inbound]` already exists (injected), and
`./scripts/setup.sh` wires the FreePBX half automatically: for each DID
`8000`, `8001`, `8002` it runs `pbx/bootstrap_dograh_route.py`, which creates
the Custom Destination + Inbound Route (DID → `dograh-inbound,<exten>,1`) and
verifies the live dialplan.

`scripts/sync_dograh_routes.py` is the general path: it mirrors
**every** dograh phone number (the shipped agents plus anything created in
the dograh UI / Workflow Studio) into FreePBX as a **Custom Extension**
(customappsreg `custom_extensions` table → Applications → Extensions, basic:
no voicemail, no call waiting), a Custom Destination + Inbound Route, and a
dynamic `extensions_custom_dograh.conf` dialplan include for numbers beyond
the static `8000-8007` set. Removing a number in dograh deletes the matching
dograh-created entries on the next sync run (`capstone-pbx-sync.timer` runs
it every 2 minutes); user-created FreePBX entries are never touched. To (re)run by hand:

```bash
# requires FREEPBX_CLIENT_ID/SECRET in .env (entrypoint registers the OAuth
# client on boot — empty allowed_scopes = full GraphQL access)
python3 pbx/bootstrap_dograh_route.py            # creates route DID 8000
python3 pbx/bootstrap_dograh_route.py --did 8001 --exten 8001   # second extension
python3 pbx/bootstrap_dograh_route.py --check    # verify only
python3 pbx/bootstrap_dograh_route.py --force    # update an existing route
```

It is idempotent, runs `fwconsole reload`, and verifies the live dialplan:
`[dograh-inbound]` → `Stasis(dograh)`, and the DID route landing in
`ext-did-0002` (FreePBX puts normal DID routes there; `dialplan show
from-trunk` only lists the include chain, so the script checks the context
the route actually lands in).

### Internal dialing (softphones on the LAN)

`pbx/asterisk/extensions_custom.conf` also defines `[from-internal-custom]`
with `8000`/`8001`/`8002` → `Goto(dograh-inbound,...)`, so any SIP extension
registered to the PBX can dial the three interview lines directly (agent
answers) — no inbound route involved. The entrypoint merges both contexts on
boot; edit the file in `pbx/asterisk/` (never the volume copy) and restart
the freepbx container to propagate.

### GUI method (alternative)

1. **Connectivity → Inbound Routes → Add Inbound Route**
   - DID Number: `8000`
   - Set Destination → **Custom Destinations** → the destination created next.
2. **Admin → Custom Destinations → Add Destination**
   - Description: `Dograh Voice Agent`
   - Destination: `dograh-inbound,8000,1`
   - ⚠️ Keep the concrete extension (`8000`) — do **not** use `s`. Dograh
     matches inbound calls by the channel's dialplan exten at `StasisStart`;
     with `s` the call is hung up as "no matching phone number".
3. **Apply Config.**

For each additional extension registered in dograh, the sync script
(`scripts/sync_dograh_routes.py`) generates the `[dograh-inbound]` /
`[from-internal-custom]` entries automatically into
`/etc/asterisk/extensions_custom_dograh.conf` (a persistent `#include` from
`extensions_custom.conf`) — no manual edit or container restart needed. If
you'd rather define a static number, add `exten =>` lines to
`pbx/asterisk/extensions_custom.conf` (or use a pattern like `_8XXX`) and
`docker compose restart freepbx`; the entrypoint merges the file idempotently
per context, so static extensions propagate on boot without duplicating
the sync-generated ones (numbers defined in the static file are skipped by
the sync).

The current track routing (FreePBX extension → dograh workflow) is managed by
`scripts/dograh_wire.py` (called by setup.sh) or the Ansible manifest
(`ansible/dograh-ari.yml`, `dograh_inbound_routes`): `8000` → IT Help Desk,
`8001` → DevOps, `8002` → SQL. Extensions must exist in the dialplan **and**
be registered as dograh phone numbers with an inbound workflow — setup.sh
(or the playbook) does the dograh half; the dialplan + inbound route here do
the PBX half.

## Configure dograh (Telephony Configurations → Add → Asterisk ARI)

| Field | Value |
|---|---|
| ARI Endpoint URL | `http://127.0.0.1:8088` (dograh runs host-mode; same box) |
| Stasis App Name | `dograh` (section name in `ari.conf`) |
| App Password | `DOGRAH_ARI_PASSWORD` value |
| WebSocket Client Name | `dograh` (section name in `websocket_client.conf`) |
| From Extensions | optional, e.g. `PJSIP/6001` for outbound |

Save → open the configuration → add extension `8000` as a **phone number** →
assign an **Inbound workflow**. Then dial `8000` — the voice agent should
answer.

> **Codec:** dograh's external media channel uses **G.711 µ-law (`ulaw`)**.
> Make sure the SIP trunk/endpoint that places calls allows `ulaw`
> (e.g. `allow=ulaw` on the PJSIP endpoint).

### WebRTC, STUN & TURN (automatic)

`pbx/entrypoint-dograh.sh` wires the host coturn into FreePBX on every boot
(settings-DB level, so the GUI's Apply Config can't undo it):

- **SIP Settings → RTP** — `stunaddr` / `turnaddr` / `turnusername` /
  `turnpassword` → `rtp_additional.conf`: the RTP engine discovers its
  external address via STUN and can relay media through TURN for ICE peers.
- **SIP Settings → WebRTC** — `webrtcstunaddr` / `webrtcturnaddr` /
  `webrtcturnusername` / `webrtcturnpassword` fields.
- **SIP Settings → binds + HTTP TLS** — the **WSS transport is enabled on
  `0.0.0.0:8089`**. In Asterisk, a `wss` transport does *not* create its own
  socket — it registers with the HTTP server's websocket support
  (`res_http_websocket`), so Asterisk **HTTP TLS must be enabled** on
  `0.0.0.0:8089` for the WSS listener to exist at all. The entrypoint flips
  `HTTPTLSENABLE` / `HTTPTLSBINDADDRESS` / `HTTPTLSBINDPORT` in
  `freepbx_settings` (cert: `/etc/asterisk/keys/integration/`). The
  transport bind change forces one Asterisk restart at boot (pjsip
  transports are `allow_reload=no`).
- **`[webrtc-template](!)` endpoint template** — written into
  `pjsip.endpoint_custom.conf` (included, never regenerated): WebRTC
  devices get DTLS-SRTP, ICE, `use_avpf`/`rtcp_mux`, and TURN relay by
  setting `template=webrtc-template` on the extension.
- **WebRTC test extension `102`** — endpoint (inherits `webrtc-template`)
  + auth (`102-auth`) + aor (`102`) written to the `*_custom.conf` files on
  boot. Register any browser SIP client against
  `wss://<host>:8089` with user `102` / password `webrtc-test-102`
  (override via `WEBRTC_TEST_PASSWORD`).

The STUN/TURN address defaults to `coturn:<TURN_LISTENING_PORT>` (the coturn
compose service, same Docker network — always resolvable from inside the
container). Override with `PJSIP_STUN_TURN_ADDR` in `.env` if needed. TURN
creds come from `TURN_USERNAME` / `TURN_PASSWORD`. For remote WebRTC
clients, forward `3478/tcp` + `3478/udp` and `49152-49251/udp` on the router
(see below) and make sure the coturn `TURN_EXTERNAL_IP` is the public IP.

Verify:

```bash
docker exec pbx-freepbx asterisk -rx "pjsip show transports"
# expect 0.0.0.0-udp :5060 and 0.0.0.0-wss :8089

docker exec pbx-freepbx cat /etc/asterisk/rtp_additional.conf
# expect stunaddr=turnaddr=coturn:3478 + creds

docker exec pbx-freepbx cat /etc/asterisk/pjsip.endpoint_custom.conf
# expect the [webrtc-template](!) section and [102](webrtc-template)

# Full WSS registration probe (no browser needed — same signaling path):
python3 scripts/webrtc-register-test.py --insecure
# expect: 101 upgrade → 401 challenge → 200 OK → RESULT: PASS
```

## Verify

```bash
docker compose ps freepbx                                    # healthy

# From inside the container:
docker exec -it pbx-freepbx bash
asterisk -rx "ari show users"                 # expect: dograh
asterisk -rx "http show status"               # server up on 0.0.0.0:8088
asterisk -rx "module show like res_websocket_client"   # media WS module loaded
asterisk -rx "dialplan show dograh-inbound"   # expect: exten 8000, 8001, 8002 → Stasis(dograh)
asterisk -rx "dialplan show from-internal-custom"  # expect: 8000/8001/8002 → Goto(dograh-inbound,…)
exit

# From the host (dograh's host-mode view of ARI):
curl -s -u dograh:$DOGRAH_ARI_PASSWORD http://127.0.0.1:8088/ari/asterisk/info
```

Place a test call to `8000` (IT), `8001` (DevOps), or `8002` (SQL). Watch
dograh logs for the StasisStart, the "Created inbound workflow run N" line
(run ids increment globally; the bound workflow per extension is IT/DevOps/
SQL), and the media WebSocket connecting; then check SigNoz for the
`dograh-interview-agent` trace of the call.

## NAT / router setup (external callers dialing in)

### This box, right now

```
host LAN IP    192.168.1.168   (eth0, static lease via 192.168.1.1)
gateway        192.168.1.1
public IP      73.68.203.71    (NAT egress — what the internet sees)
local firewall  none (ufw inactive, iptables ACCEPT)
```

The PBX publishes these ports (freepbx service in `docker-compose.yml`):

| Port | Proto | Purpose | Expose externally? |
|------|-------|---------|--------------------|
| 5060 | udp   | SIP signalling | ✅ forward |
| 5061 | tcp   | SIP-TLS (optional) | ✅ if used |
| 10101-10120 | udp | RTP media | ✅ forward |
| 8089 | tcp   | PJSIP WSS (WebRTC softphones) | ✅ if using WebRTC |
| 80   | tcp   | FreePBX web UI | ❌ admin only |
| 8088 | tcp   | Asterisk HTTP/ARI | ❌ dograh reaches it on loopback |
| 5038 | tcp   | AMI | ❌ admin only |
| 10000 | tcp  | Webmin | ❌ admin only |

### 1. Router port-forwarding

Forward on the router (`192.168.1.1`) → `192.168.1.168`:

```
5060/udp        → 192.168.1.168:5060        SIP signalling
10101-10120/udp → 192.168.1.168:10101-10120 RTP media
5061/tcp        → 192.168.1.168:5061        (only if you use SIP-TLS)
8089/tcp        → 192.168.1.168:8089        (only if you use WebRTC softphones)
```

Also on the router: **disable SIP ALG** (it mangles SIP/SDP and breaks
registration + audio on nearly every consumer router).

### 2. Asterisk must advertise the public IP (SIP/SDP)

Without this, Asterisk writes its private address into `Contact` and SDP, and
remote callers get **one-way or no audio**. The compose image bakes the
public IP into `pjsip.transports.conf` at build time; verify it matches THIS
box and fix it via the FreePBX GUI (`Connectivity → Trunks`, the UDP
transport) or `pjsip.transports_custom.conf` (survives Apply Config):

```ini
[0.0.0.0-udp]
type = transport
protocol = udp
bind = 0.0.0.0:5060
external_media_address = 73.68.203.71
local_net = 192.168.1.0/24      ; don't NAT the LAN back into itself
```

Verify what Asterisk thinks it's advertising:

```bash
docker exec pbx-freepbx asterisk -rx "pjsip show transport 0.0.0.0-udp" | \
  grep -E "external_(media|signaling)_address"
```

If the box's public IP ever changes (DHCP WAN), update the transport — the
`external_*_address` is static in this setup. `local_net` keeps LAN callers
from being NAT'd back through the router.

### 3. RTP range — must match what Docker publishes

The compose publishes **10101-10120/udp**, while host TCP port `10000` is reserved for Webmin. FreePBX's default RTP range can extend to `20000`; the entrypoint writes the durable `rtpstart`/`rtpend` values into FreePBX's settings database so Asterisk stays inside the published range.

`pbx/asterisk/rtp_custom.conf` provides the fallback cap:

```ini
[general]
rtpstart=10101
rtpend=10120
```

Verify:

```bash
docker exec pbx-freepbx cat /etc/asterisk/rtp_custom.conf
# expect rtpstart=10101 rtpend=10120
```

### 4. Sanity check from the outside

- SIP: `nmap -sU -p 5060 73.68.203.71` or a SIP OPTIONS ping (e.g. `sipsak`)
  should reach Asterisk.
- RTP: place a test call and watch one-way audio; if the caller hears nothing,
  run `docker exec pbx-freepbx asterisk -rx "rtp set debug on"` during the
  call and confirm the negotiated ports are inside 10101-10120.
- If calls reach the PBX but drop immediately, the inbound route destination
  may be `s` — fix the Custom Destination (see Troubleshooting).

## Troubleshooting

- **`UNVERIFIED media socket` in dograh logs** — dograh signs the media WS URL
  with `TELEPHONY_WS_TOKEN_SECRET`; the dograh `.env` and this PBX are out of
  sync on the token secret (or `DOGRAH_WS_URI` points somewhere wrong).
- **Call answers but no audio** — check `ulaw` on the trunk/endpoint, then
  `asterisk -rx "rtp set debug on"` during a test call. Confirm the
  negotiated RTP port is inside `10101-10120` (the compose publish) — if
  Asterisk picked a higher port, `rtp_custom.conf` lost its override (it's
  re-applied by `pbx/entrypoint-dograh.sh` on boot).
- **"no matching phone number" hang-up** — the inbound route destination is
  `s` instead of the concrete extension; fix the Custom Destination.
- **ARI changes not picked up** — the stock entrypoint runs a final
  `core restart now` after the web stack starts; if you edit configs later,
  run `asterisk -rx "ari reload"` / `asterisk -rx "dialplan reload"` /
  `asterisk -rx "module reload res_websocket_client.so"` by hand.
- **`invalid_client` (401) from the API token endpoint** — the OAuth client
  is registered by the stock entrypoint on boot, but that step can fail if
  MariaDB isn't ready yet, leaving `api_applications` empty. Re-run the
  registration: `docker exec pbx-freepbx php /tmp/register_oauth.php` (with
  `FREEPBX_CLIENT_ID`/`FREEPBX_CLIENT_SECRET` env vars set), then retry
  `bootstrap_dograh_route.py`.
