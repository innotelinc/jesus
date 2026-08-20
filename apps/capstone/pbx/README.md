# PBX / Asterisk side — FreePBX 17 + dograh ARI wiring

Runs the Innotel FreePBX fullstack image (`ghcr.io/innotelinc/pbx-portal:latest-fullstack`,
built from [pbx-portal](https://github.com/innotelinc/pbx-portal)) and wires it
to dograh over ARI:

| File (in `pbx/asterisk/`) | Injects into `/etc/asterisk/` | Purpose |
|---|---|---|
| `ari.conf` | `ari.conf` | ARI user `[dograh]` — Stasis app name + password |
| `http.conf` | `http.conf` (only if missing) | Asterisk HTTP on 8088 |
| `websocket_client.conf` | `websocket_client.conf` | External media WS → dograh-api |
| `extensions_custom.conf` | appended to `extensions_custom.conf` | `[dograh-inbound]` dialplan → `Stasis(dograh)` |

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
DOGRAH_WS_URI=ws://host.docker.internal:8000/api/v1/telephony/ws/ari  # default
FREEPBX_AMI_SECRET=<openssl rand -base64 24>   # only if the portal profile is used
```

## FreePBX GUI — route calls into dograh (one-time, per extension)

The dialplan context `[dograh-inbound]` already exists (injected). Point an
inbound route at it:

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
asterisk -rx "dialplan show dograh-inbound"   # expect: exten 8000 → Stasis(dograh)
asterisk -rx "websocket show clients"         # expect: one connected client (dograh)
exit

# From the host (dograh's host-mode view of ARI):
curl -s -u dograh:$DOGRAH_ARI_PASSWORD http://127.0.0.1:8088/ari/asterisk/info
```

Place a test call to `8000`. Watch dograh logs for the StasisStart and the
media WebSocket connecting; then check SigNoz for the `dograh-interview-agent`
trace of the call.

## NAT / externip (only if external callers dial in)

External callers reaching the PBX from the internet need Asterisk to advertise
a public IP in SIP/SDP (otherwise one-way audio):

- **PJSIP transport** (FreePBX default) — `Connectivity → Trunks`, or
  hand-edit `/etc/asterisk/pjsip_custom.conf`:

  ```ini
  [transport-udp]
  type = transport
  protocol = udp
  bind = 0.0.0.0:5060
  local_net = 192.168.1.0/24
  external_media_address = <PUBLIC_IP>
  external_signaling_address = <PUBLIC_IP>
  ```

- **RTP** — the compose already publishes `10000-20000/udp`; forward the same
  range (plus `5060/udp`) at the router → host IP. Disable **SIP ALG** on the
  router.

## Troubleshooting

- **`UNVERIFIED media socket` in dograh logs** — dograh signs the media WS URL
  with `TELEPHONY_WS_TOKEN_SECRET`; the dograh `.env` and this PBX are out of
  sync on the token secret (or `DOGRAH_WS_URI` points somewhere wrong).
- **Call answers but no audio** — check `ulaw` on the trunk/endpoint, then
  `asterisk -rx "rtp set debug on"` during a test call.
- **"no matching phone number" hang-up** — the inbound route destination is
  `s` instead of the concrete extension; fix the Custom Destination.
- **ARI changes not picked up** — the stock entrypoint runs a final
  `core restart now` after the web stack starts; if you edit configs later,
  run `asterisk -rx "ari reload"` / `asterisk -rx "dialplan reload"` /
  `asterisk -rx "module reload res_websocket_client.so"` by hand.
