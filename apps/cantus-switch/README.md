# cantus-switch

The Cantus 1.0 switch: a node, a relay, a routing document, a control API and an
ARI-compatible surface — in Node, with **no dependencies**.

```bash
node src/cli.js selftest        # two switches, one relay, one real call
node src/cli.js run             # serve it
node src/cli.js route-test routes.json --to 101@telno.local
npm test                        # 46 tests, including byte-for-byte parity with the Perl stack
```

## Why this exists

[`apps/cantus`](../cantus) is the standard and a Perl reference stack that proves
it. This is the deployment side of the same protocol: the process a product can
run, with the control surfaces products need.

Asterisk was the thing it replaces. That decision is measured, not asserted:
[`apps/cantus/analysis/asterisk-22-findings.md`](../cantus/analysis/asterisk-22-findings.md).

## The two surfaces

**Control API** (`/v1/*`) — what a platform uses instead of AMI:

| | |
|---|---|
| `GET /v1/status` | node, relay, routes, lines, live calls |
| `POST /v1/calls` | originate `{from, to}` |
| `DELETE /v1/calls/:id` | hang up |
| `POST /v1/calls/:id/{answer,dtmf,record}` | call control |
| `GET/POST /v1/routes` | read or replace the routing document (validated) |
| `GET/POST/DELETE /v1/lines` | the line inventory |
| `POST /v1/trunks` | gateway endpoints |
| `WS /ws/events` | `call.*`, `cdr`, `node`, `relay` |
| `WS /ws/line` | a browser softphone: JSON control + 20 ms PCM16 frames |

**ARI-compatible surface** (`/ari/*`) — so capstone and dograh do not have to be
rewritten to change switch. Channels (list/get/create/delete/answer/hangup/play/
dtfm/externalMedia), bridges (`create/list/get/delete/addChannel/removeChannel`),
applications, endpoints, and `/ari/events`.

externalMedia is chan_websocket's, not a private dialect: `external_host` is a
connection name (or a literal `ws://` URL), the switch dials it, sends
`MEDIA_START` with the format and 20 ms frame size, and then carries raw audio
in `ulaw`, `slin` or `slin16` over binary frames — 160-byte ulaw being what
pipecat decodes. Names come from `CANTUS_WS_CLIENTS`
(`dograh=ws://dograh-api:8000/api/v1/telephony/ws/ari`), the switch's stand-in
for `websocket_client.conf`. `transport_data` (`v(key=value,…)`) is appended as
query parameters, which is how an agent runtime receives the workflow ids it
routes the call by. The channel is created by `POST /ari/channels/externalMedia`
with `channelId`, exactly as ARI documents it; the bridge that follows is what
puts the caller and the agent in the same conversation, and a bridge of more
than two channels pairs each with the first other rather than pretending to be
a mixer (stated, not hidden).

Routing is not only for inbound calls. `POST /v1/calls` evaluates the same
document, so dialling `8000@…` from a console reaches the same `ari` hand-off a
trunk call does, and the call records the rule that took it (`call.routed`). A
hand-off to an ARI app with **no connected client** ends the call with cause
`app-unavailable` instead of parking it in stasis until the network gives up.

Implemented honestly, and stated where not: no snoop (501), no channel
variables, no Asterisk sound library beyond the prompt directory.

## One call, end to end

```
INVITE 101@telno.local  ──relay──▶ switch
                        ◀─ACCEPT──  caps agreed, candidates offered
PATH probes (0/100/200 ms) ──────▶  direct committed, or relay at 300 ms
media 20 ms PCM16 ────────────────▶  both ways, one 5-tuple
FEEDBACK every 200 ms ────────────▶  recv_high: proof the other side is hearing
```

`node src/cli.js selftest` prints exactly this, with the path it took and the
peak amplitude of the audio that arrived. A call is not reported as passing
unless audio actually landed.

## Hold

The line socket controls a connected call with `call`, `answer`, `hangup`,
`dtmf`, `hold` and `unhold`. The switch answers a `call` with
`{type: "dialing", callId, state}` — the id is minted here, so a console has
something to name while the call is still ringing — and every browser leg on a
call receives `{type: "answered", callId}` when the far end picks up, the socket
that dialled included. Without that frame a console could only know it had
*sent* a call: its own state stayed on "Calling…" for the whole conversation,
so its hold and keypad had no connected call to act on while audio was already
flowing. Hold is a property of the leg, not a second call:
the call stays answered and the far leg stays up. The party who was put on hold
hears music — synthesised in `src/media.js`, eight notes looping every four
seconds, so no licensed file has to ship — and the party who pressed hold hears
silence, which is the point of holding. `unhold` restores both directions on the
same call. The switch answers with `{type: "held", callId, held}` so a console
shows the call's state rather than the last thing somebody clicked, and refuses
a leg that is not connected.

## Files

| | |
|---|---|
| `src/wire.js` | varints, TLV, the three datagram kinds, signing input |
| `src/endpoint.js` | the node: sessions, Reach, media, registration |
| `src/relay.js` | registry + forwarder; holds no call state |
| `src/switch.js` | lines, trunks, calls, bridging, recording, events |
| `src/router.js` | the routing document, validated and evaluated |
| `src/ari.js` | the ARI-compatible translation |
| `src/server.js` | one listener: control, ARI, events, softphone |
| `src/ws.js` | WebSocket server and client, RFC 6455, no dependencies |

## Configuration

| Variable | Default | |
|---|---|---|
| `CANTUS_DOMAIN` | `telno.local` | dialling domain |
| `CANTUS_ID` | `switch@<domain>` | this node's endpoint id |
| `CANTUS_SECRET` | `cantus-loopback` | signing secret (shared by the estate) |
| `CANTUS_BIND` | `0.0.0.0:7443` | Cantus UDP — signalling *and* media |
| `CANTUS_RELAY_BIND` | `0.0.0.0:7444` | relay UDP; `CANTUS_RELAY_ADDRESS` uses an external one |
| `CANTUS_HTTP_PORT` | `8088` | control + ARI + WebSockets |
| `CANTUS_CONTROL_TOKEN` | — | bearer token; when set, the API and line socket need it |
| `CANTUS_ROUTES_FILE` | — | routing document loaded at boot |
| `CANTUS_RECORD_DIR` / `CANTUS_PROMPTS` | `./data/...` | audio |
| `CANTUS_LINES_URL` | — | polled line inventory (telno serves it) |
| `CANTUS_ARI_USER` / `CANTUS_ARI_PASSWORD` / `CANTUS_ARI_APP` | `dograh` | the ARI subscriber |

## Interoperability

The wire format is not checked against itself. `test/wire.test.js` asserts the
exact bytes the Perl reference stack produces for an INVITE (signature included),
media, capability sets, candidates, a relay datagram and a quality report. If a
change here breaks interoperability, a unit test fails before a call does.

## Limits, stated

- The signing profile is `sig-hmac-sha256` (the standard's loopback test
  profile). Ed25519 is the normative profile and is not implemented here.
- Codec: `pcm-s16/8000/1` and `opus` capability sets are negotiated; the switch
  forwards Opus payloads opaque and does not transcode.
- Recording is WAV of the far-end leg; a stereo mix of both legs is not produced.
- Parking, T.38 and video are not implemented. They are absent on purpose, and
  the products that used them say so rather than offering a button.
