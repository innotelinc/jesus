# cantus-gateway

The one place a PSTN protocol still exists. Cantus on one side, SIP and RTP on
the other, PCM16 to PCMU in between.

```bash
node src/index.js          # needs SIP_HOST and credentials, see below
npm test                   # 17 tests, including a real UDP registrar and dialog
```

## Why it exists

`cantus-switch` routes to *trunks*, and a trunk is an endpoint that speaks
Cantus and whatever it likes to the carrier — see
[`telno/telephony/provision.js`](../telno/src/telephony/provision.js). This is
that endpoint. Without it a number can be attached to a line and ring nothing,
because nothing in the estate can talk SIP.

## The two directions

```
carrier ──INVITE + RTP──▶ gateway ──Cantus INVITE──▶ switch ──▶ line 101
                                   (+14132642700@switch@estate.local)

softphone ──call 14134210134──▶ switch ──INVITE 14134210134@voipms@gateway──▶ gateway ──SIP INVITE──▶ carrier
```

The DID is the *dialled address* on the Cantus side, so the routing document —
not the gateway — decides which line rings. Outbound, the Cantus leg is accepted
only when the carrier answers, so a failed call has a cause the switch records
instead of silence.

## Configuration

| Variable | | |
|---|---|---|
| `SIP_HOST` | **required** | carrier SIP server, e.g. `atlanta.voip.ms` |
| `SIP_PORT` | `5060` | |
| `SIP_USERNAME` / `SIP_PASSWORD` | — | the sub-account the trunk registers as |
| `SIP_FROM_USER` | `SIP_USERNAME` | the number outbound calls present as (the trunk's DID) |
| `SIP_SRTP` | off | `on` offers and answers `RTP/SAVP` with an SDES key (`AES_CM_128_HMAC_SHA1_80`) |
| `SRTP_STATE_FILE` | — | where a change made over HTTP is remembered; it wins over `SIP_SRTP` on the next boot |
| `SIP_DOMAIN` | `SIP_HOST` | realm/From domain |
| `SIP_ADVERTISE` | first public IPv4 | what goes in `Contact` and `c=` SDP |
| `SIP_LOCAL_PORT` | `0` (ephemeral) | bind 5060 when the container maps it |
| `GATEWAY_RTP_START` / `GATEWAY_RTP_END` | `40000` / `40063` | the UDP range to open |
| `CANTUS_ID` | `voipms@gateway` | must equal the trunk's endpoint (`name@host`) |
| `CANTUS_RELAY` | — | the switch's relay, e.g. `switch:7444` |
| `CANTUS_SECRET` | `cantus-loopback` | shared with the switch |
| `CANTUS_SWITCH` | `switch@<domain>` | who inbound calls are dialled at |
| `GATEWAY_HTTP_PORT` | `7454` | `/healthz` and `/status` |

`GET /healthz` is `200` only when both halves are usable: a bound Cantus socket
**and** a registered trunk. Anything else is `503` with the reason.

Encryption can be changed while the gateway runs, because the other half of it
lives at the carrier and the two have to move together:

```bash
GET  /srtp                       # {"enabled":true,"registered":true}
POST /srtp  {"enabled":false}    # {"ok":true,"enabled":false,"registered":true}
```

The change applies to the **next** call in either direction; a call already up
keeps the keys it negotiated. `SIP_SRTP` is the value a fresh deployment starts
with, and `SRTP_STATE_FILE` — written on every change — is what a restart boots
with. Without that file a restart would quietly restore encryption the carrier
had already been told to stop expecting, and every call would be refused with
`488` until somebody found out why.

## Pointing VoIP.ms at it

1. Create a sub-account (e.g. `123456_switch`) at VoIP.ms; set its password.
2. Create the trunk in the platform so the switch knows the endpoint:

```bash
curl -X POST http://<console>/api/trunks -b cookie -H 'content-type: application/json' \
  -d '{"name":"voipms","host":"gateway","fromUser":"14132642700",
       "username":"123456_switch","secret":"<sub-account password>","provider":"voip.ms"}'
```

3. Set `SIP_*` in the estate's `.env` and `docker compose up -d gateway` —
   or, on a deployed box, `estate/tools/vultr-demo.sh trunk <host> <sub-account>
   <password> <did>`, which writes them and waits for the registration.
4. At VoIP.ms, point the DID's routing at that sub-account (or its SIP URI) so
   the carrier sends the INVITE here.

## Limits, stated

- **PCMU only.** G.729, G.722 and Opus are refused with `488 Not Acceptable
  Here` rather than negotiated into something that would carry silence.
- **SDES-SRTP only, no TLS.** `SIP_SRTP=on` encrypts the carrier media with
  `AES_CM_128_HMAC_SHA1_80`, keyed in the SDP the way a carrier expects. The
  signalling itself stays plain UDP: `sips:` and DTLS-SRTP are not implemented,
  so a carrier that offers `UDP/TLS/RTP/SAVP` is refused rather than downgraded.
  Interop is proven against Asterisk + libsrtp2, not only against itself — see
  [`estate/tools/asterisk-srtp`](../../estate/tools/asterisk-srtp).
- **No re-INVITE.** An offer inside a confirmed dialog is not handled; the
  gateway answers `491` by omission and keeps the original stream.
- **One codec, no transcoding per frame.** PCM16↔µ-law is a table lookup, which
  is why this can run in a 64 MB container.
