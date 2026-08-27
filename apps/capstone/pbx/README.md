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

```bash
# Full capstone stack (dograh + PBX together)
docker compose -f docker-compose.yml -f docker-compose.asterisk.yml up -d

# PBX only
docker compose -f docker-compose.asterisk.yml up -d

# Optional: also start the PBX Customer Portal (Next.js)
docker compose -f docker-compose.asterisk.yml --profile portal up -d
```

Add to `.env` (see `.env.example`):

```bash
# openssl rand -base64 24
DOGRAH_ARI_PASSWORD=<strong-password>   # MUST match dograh UI "App Password"
DOGRAH_WS_URI=ws://host.docker.internal:3010/api/v1/telephony/ws/ari  # default
FREEPBX_AMI_SECRET=<openssl rand -base64 24>   # only if the portal profile is used
```

## Route calls into dograh (one-time, per extension)

The dialplan context `[dograh-inbound]` already exists (injected). Point an
inbound route at it — **API method (recommended)** or GUI:

### API method — `pbx/bootstrap_dograh_route.py`

No GUI steps. Uses the FreePBX API module (OAuth2 + GraphQL `addInboundRoute`)
for the route, and inserts the custom destination into customappsreg's
kvstore (the API module doesn't expose it) via `docker exec ... mysql`:

```bash
# requires FREEPBX_CLIENT_ID/SECRET in .env (entrypoint registers the OAuth
# client on boot — empty allowed_scopes = full GraphQL access)
python3 pbx/bootstrap_dograh_route.py            # creates route DID 8000
python3 pbx/bootstrap_dograh_route.py --did 8001 --exten 8001   # second extension
python3 pbx/bootstrap_dograh_route.py --check    # verify only
python3 pbx/bootstrap_dograh_route.py --force    # update an existing route
```

Idempotent, runs `fwconsole reload`, and verifies the live dialplan:
`[dograh-inbound]` → `Stasis(dograh)`, and the DID route landing in
`ext-did-0002` (FreePBX puts normal DID routes there; `dialplan show
from-trunk` only lists the include chain, so the script checks the context
the route actually lands in).

### GUI method

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

For each additional extension registered in dograh, add an `exten =>` line to
`[dograh-inbound]` in `pbx/asterisk/extensions_custom.conf` (or use a pattern
like `_8XXX`) and `docker compose -f docker-compose.asterisk.yml restart freepbx`.
The entrypoint merges the file idempotently — it appends the context when
missing and appends only the missing `exten =>` blocks otherwise, so new
extensions propagate on boot without duplicating existing ones.

The current track routing (FreePBX extension → dograh workflow) is managed by
the Ansible manifest (`ansible/dograh-ari.yml`, `dograh_inbound_routes`):
`8000` → IT Help Desk, `8001` → DevOps, `8002` → SQL. Extensions must exist
in the dialplan **and** be registered as dograh phone numbers with an inbound
workflow — the playbook does the dograh half; the dialplan + inbound route
here do the PBX half.

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

## Verify

```bash
docker compose -f docker-compose.asterisk.yml ps            # healthy

# From inside the container:
docker exec -it pbx-freepbx bash
asterisk -rx "ari show users"                 # expect: dograh
asterisk -rx "http show status"               # server up on 0.0.0.0:8088
asterisk -rx "module show like res_websocket_client"   # media WS module loaded
asterisk -rx "dialplan show dograh-inbound"   # expect: exten 8000, 8001 → Stasis(dograh)
asterisk -rx "websocket show clients"         # expect: one connected client (dograh)
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

The PBX publishes these ports (from `docker-compose.asterisk.yml`):

| Port | Proto | Purpose | Expose externally? |
|------|-------|---------|--------------------|
| 5060 | udp   | SIP signalling | ✅ forward |
| 5061 | tcp   | SIP-TLS (optional) | ✅ if used |
| 10000-10200 | udp | RTP media | ✅ forward |
| 8089 | tcp   | PJSIP WSS (WebRTC softphones) | ✅ if using WebRTC |
| 80   | tcp   | FreePBX web UI | ❌ admin only |
| 8088 | tcp   | Asterisk HTTP/ARI | ❌ dograh reaches it on loopback |
| 5038 | tcp   | AMI | ❌ admin only |
| 10000 | tcp  | Webmin | ❌ admin only |

### 1. Router port-forwarding

Forward on the router (`192.168.1.1`) → `192.168.1.168`:

```
5060/udp        → 192.168.1.168:5060        SIP signalling
10000-10200/udp → 192.168.1.168:10000-10200 RTP media
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

The compose publishes **10000-10200/udp** (a wider publish wedges the Docker
daemon — 10k docker-proxy instances), but FreePBX's `rtp_additional.conf`
ships `rtpstart=10000 rtpend=20000`. If left, Asterisk picks RTP ports above
10200 that the container never publishes and external audio dies.

`pbx/asterisk/rtp_custom.conf` (installed by the entrypoint; included after
`rtp_additional.conf`, so it wins on merge) caps the range:

```ini
[general]
rtpstart=10000
rtpend=10200
```

Verify:

```bash
docker exec pbx-freepbx cat /etc/asterisk/rtp_custom.conf
# expect rtpstart=10000 rtpend=10200; the file is NOT regenerated by
# fwconsole reload, so the override survives Apply Config
```

### 4. Sanity check from the outside

- SIP: `nmap -sU -p 5060 73.68.203.71` or a SIP OPTIONS ping (e.g. `sipsak`)
  should reach Asterisk.
- RTP: place a test call and watch one-way audio; if the caller hears nothing,
  run `docker exec pbx-freepbx asterisk -rx "rtp set debug on"` during the
  call and confirm the negotiated ports are inside 10000-10200.
- If calls reach the PBX but drop immediately, the inbound route destination
  may be `s` — fix the Custom Destination (see Troubleshooting).

## Troubleshooting

- **`UNVERIFIED media socket` in dograh logs** — dograh signs the media WS URL
  with `TELEPHONY_WS_TOKEN_SECRET`; the dograh `.env` and this PBX are out of
  sync on the token secret (or `DOGRAH_WS_URI` points somewhere wrong).
- **Call answers but no audio** — check `ulaw` on the trunk/endpoint, then
  `asterisk -rx "rtp set debug on"` during a test call. Confirm the
  negotiated RTP port is inside `10000-10200` (the compose publish) — if
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
