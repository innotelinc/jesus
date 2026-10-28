# Cantus 1.0

**A realtime voice standard built around one socket.**

Status: Candidate Standard, revision 1.0.
Wire token: `cantus/1`
Default port: **7443/UDP**, and **7443/TCP** for the fallback binding.

---

## 0. Abstract

Cantus carries a bidirectional voice call between two endpoints over a single
transport connection, on a single port, with traversal that cannot fail silently.
Signalling, media, traversal probing and liveness all share one 5-tuple, so one
NAT mapping serves the entire call. Media path selection is automatic, bounded in
time, and always has a pre-opened relay path to fall back to. The call is a
first-class object with a normative state machine. Capability negotiation is a
typed set and completes in one round trip. Routing is a schema-checked document.

The design targets four properties, in priority order:

1. **It connects.** No configuration can leave a call connected but silent.
2. **It is simple.** 14 message types, 3 datagram kinds, 1 port, 1 config file.
3. **It is safe by default.** Integrity is mandatory, identity is a key, and no
   field is trusted because of where it came from.
4. **It is fast.** One round trip to negotiate, no re-offers, no in-band event
   packets, bounded datagrams, no IP fragmentation.

### 0.1 Relationship to earlier work

Cantus is not a dialect of SIP and does not carry SDP. It replaces, rather than
extends, the 1990s model in which signalling and media negotiate separate
addresses and a human reconciles them. Appendix D maps every familiar SIP
concept to its Cantus equivalent, including the ones deliberately dropped.

---

## 1. Conformance and terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

An implementation is **Cantus 1.0 conformant** if it:

- implements the `cantus/udp` binding (Section 4.1) and Section 5 framing,
- completes the handshake of Section 5.3,
- negotiates capability sets per Section 6,
- follows the call state machine of Section 7 exactly,
- performs Reach path selection per Section 8, including the relay fallback,
- accepts media on the relay path at all times while a call is ACTIVE.

The `cantus/tcp` binding (Section 4.2) is RECOMMENDED. The `pcm-s16` codec of
Section 9.3 is a conformance aid and MUST NOT be used on a production path.

Entities:

| Term | Meaning |
|---|---|
| **Node** | Any program speaking Cantus: an endpoint, a relay, or both. |
| **Endpoint** | A node that terminates calls. Has one key pair and one `EndpointId`. |
| **Relay** | A node that forwards datagrams between endpoints and reports observed addresses. Holds no call state. |
| **Call** | One bidirectional voice session, identified by a `CallId`, with a generation counter. |
| **Stream** | One media flow inside a call. Cantus 1.0 defines stream 0; more are reserved. |
| **Route** | A declarative document that decides what an endpoint does with an arriving call. |
| **Reach** | The traversal layer of Section 8: candidate gathering, probing, path commit, failover. |
| **Path** | The media route in use for a call: `direct` or `relay`. |

---

## 2. Design rules

These are normative constraints on the protocol, not advice.

1. **One socket.** A node MUST send and receive signalling, media, probes,
   registration and relay traffic through one socket (one local UDP port, or one
   TCP connection). Section 8 depends on this: the NAT mapping opened by the
   first datagram is the mapping that carries media.
2. **No silence.** If a peer accepted a call, media MUST be flowing within the
   Section 8.6 deadline, on some path. A node MUST NOT report a call as ACTIVE
   while it has no committed media path.
3. **Bounded everything.** A datagram MUST NOT exceed 1150 bytes. A control
   message MUST NOT exceed 1150 bytes. No message may cause unbounded allocation.
4. **Nothing trusted by position.** No behaviour may depend on a source address
   or port matching a claimed identity. Identity is verified per Section 10.
   Source addresses are only used as *hints* for Reach.
5. **Unknown is ignorable.** Unknown message types are dropped and counted;
   unknown fields are skipped. Unknown *capabilities* are skipped. Forward
   compatibility MUST NOT require a version bump.
6. **Idempotent by construction.** Every message that changes state carries a
   `nonce`; duplicate deliveries MUST be absorbed silently.
7. **No re-negotiation.** A negotiated capability set is fixed for the life of
   the call. Changing media mid-call is a new call (Section 7.8).

---

## 3. Model

```
                    +-----------------------------+
   Endpoint A  ---- |  one socket, port 7443      | ---- Endpoint B
   (key A)          |  CONTROL | MEDIA | RELAY    |      (key B)
                    +-----------------------------+
                                 |
                                 | always-on Reach connection
                                 v
                         +---------------+
                         |     Relay     |
                         | observed addr |
                         | route handles |
                         +---------------+
```

An endpoint has:

- an `EndpointId` = `name@domain` (ASCII, ≤ 253 octets, case-insensitive),
- a long-term key pair, whose public key is bound to the `EndpointId` in the
  discovery record (Section 10.4),
- one socket (Section 4),
- an ordered capability set (Section 6),
- a declared `Limits` (Section 5.3.2),
- zero or more active calls (Section 7),
- one Reach registration with a relay (Section 8.2).

---

## 4. Transport bindings

### 4.1 `cantus/udp` (baseline, normative)

One UDP socket, bound to an ephemeral port by default, or to 7443.

- Every datagram begins with magic `0xCA`.
- Datagram boundaries are message boundaries. Messages are never split across
  datagrams.
- The node MUST send from the same socket and same local port that it receives
  on. **Symmetric sending is mandatory.**
- RECOMMENDED receive buffer: ≥ 256 KiB.
- Nodes MUST tolerate reordering and duplication of all control messages.

### 4.2 `cantus/tcp` (fallback, recommended)

Same framing, carried on a single TCP connection to port 7443, prefixed by a
2-octet big-endian length instead of the magic byte. Used when UDP is blocked.
Reach treats a TCP binding as a `relay` path with the relay as the far end.

### 4.3 Datagram kinds

| Kind | Name | Purpose |
|---|---|---|
| `0x00` | CONTROL | Handshake, calls, Reach, feedback, registration |
| `0x01` | MEDIA | Voice payload for one stream |
| `0x02` | RELAY | A datagram encapsulated for relay forwarding |

```
CONTROL = 0xCA 0x00 msg_type:varint field*
MEDIA   = 0xCA 0x01 stream:varint tag:varint seq:varint ts:varint codec:varint flags:varint payload*
RELAY   = 0xCA 0x02 route:varint [name:string when route==0] <inner datagram, 0xCA...>
```

`RELAY` is only ever sent to a relay. `route` is a handle the relay issued, or
`0` meaning *address this peer by `EndpointId`*, in which case the relay resolves
`name` in its registry. Name addressing is what lets a node place its first call
before it has learned any peer handle, so **no endpoint ever needs a routable
address to be reached** (section 8).

A relay MUST drop an inner datagram whose kind is `RELAY` (no nesting), and MUST
NOT forward to an address with no live registration.

---

## 5. Encoding and handshake

### 5.1 Primitives

**Varint**: unsigned LEB128, little-endian base-128, 1–9 octets. A decoder MUST
reject a varint longer than 9 octets or one whose value exceeds 2^63−1.

**Field**: `tag:varint value`, where `tag = (field_id << 3) | wire_type`.

| wire_type | Meaning | Value |
|---|---|---|
| 0 | varint | unsigned integer |
| 1 | fixed64 | 8 octets, little-endian |
| 2 | bytes | `len:varint` then `len` octets |
| 5 | fixed32 | 4 octets, little-endian |

Decoders MUST skip unknown field ids and MUST skip a field with an unknown wire
type that can still be length-determined. A repeated field takes its last value.
An encoding error in a control message is a `BAD_REQUEST` and the message is
dropped.

**Strings** are UTF-8, carried as wire_type 2.

### 5.2 Field registry

Ids are global; a given id keeps its meaning in every message.

| Id | Name | Type | Used by | Meaning |
|---|---|---|---|---|
| 1 | `from` | string | all | Sending `EndpointId` |
| 2 | `to` | string | INVITE, INFO | Destination `EndpointId` |
| 3 | `call` | string | call msgs | `CallId`: 128-bit, 32 lowercase hex chars |
| 4 | `nonce` | varint | call msgs | Sender's per-session monotonic counter |
| 5 | `sig` | bytes | all | Signature, Section 10.2 |
| 6 | `gen` | varint | call msgs | Call generation, starts at 1 |
| 7 | `reason` | varint | REJECT, TERMINATE | Reason code, Section 11 |
| 8 | `text` | string | REJECT, TERMINATE, INFO | Human-readable detail |
| 9 | `caps` | bytes | HELLO, HELLO_ACK, INVITE, ACCEPT | Capability set, Section 6.1 |
| 10 | `limits` | bytes | HELLO, HELLO_ACK | Limits, Section 5.3.2 |
| 11 | `node` | string | REGISTER, REGISTER_ACK | Node label |
| 12 | `cands` | bytes | PATH | Candidate list, Section 8.4 |
| 13 | `token` | bytes | PATH, PATH_ACK | 16-octet path verification token |
| 14 | `path` | varint | PATH, PATH_ACK | 0 = direct, 1 = relay |
| 15 | `handle` | varint | REGISTER_ACK, PATH | Relay route handle |
| 16 | `time` | varint | FEEDBACK, PROBE | Sender monotonic milliseconds |
| 17 | `payload` | bytes | INFO | Application payload |
| 18 | `event` | varint | INFO | 0 = dtmf, 1 = app, 2 = text |
| 19 | `observed` | bytes | REGISTER_ACK | Observed address, Section 8.2 |
| 20 | `grant` | bytes | REGISTER_ACK | Relay grant, Section 8.2 |
| 21 | `version` | string | HELLO | Must be `cantus/1` |
| 22 | `stream` | varint | media-related | Stream id, default 0 |
| 23 | `report` | bytes | FEEDBACK | Quality report, Section 9.5 |
| 24 | `key` | bytes | HELLO, REGISTER | Long-term public key |

### 5.3 Handshake

Handshake happens once per connection (per socket), not per call.

#### 5.3.1 Exchange

```
A -> B   HELLO      version, from, key, caps, limits, nonce, sig
B -> A   HELLO_ACK  version, from, key, caps, limits, nonce, sig
```

Both sides send `HELLO` independently and immediately on first contact; there is
no initiator/client role and no ordering dependency. A node that receives
`HELLO` MUST reply `HELLO_ACK` unless it already holds a valid session with that
peer. Both messages are signed. A node that fails signature verification sends
exactly one `HELLO_ACK` with `reason=AUTH_FAILED`, then discards further traffic
from that address for 30 seconds.

The negotiated session is the pair of capability sets, the pair of limits, and
the derived replay window (Section 10.3).

#### 5.3.2 Limits

`Limits` is a length-delimited field of TLVs:

| Id | Name | Meaning |
|---|---|---|
| 1 | `max_calls` | Concurrent calls this node accepts |
| 2 | `max_streams` | Streams per call (1 in Cantus 1.0) |
| 3 | `max_bitrate` | Aggregate kbit/s this node will send |
| 4 | `max_datagram` | Largest datagram accepted, ≤ 1150 |
| 5 | `keepalive_ms` | Liveness interval the node wants |
| 6 | `reach_ms` | Longest Reach deadline the node will wait |

A node MUST NOT exceed the peer's declared limits, and MUST reject a call that
would. Announcing limits is how Cantus avoids the silent resource exhaustion that
unbounded port ranges and unbounded dialog counts allow.

#### 5.3.3 Session failure

No `HELLO_ACK` within 4 seconds → the peer is not a Cantus node, or is
unreachable. The node MUST NOT fall back to a second protocol dialect; there is
exactly one.

---

## 6. Capabilities

### 6.1 Encoding

A capability set is a `bytes` field:

```
caps  = count:varint cap:count
cap   = name:string ptime:varint bitrate_kbps:varint nparams:varint
        (key:string value:string)*nparams
```

`name` is `codec/clock/channels`, lowercased: `opus/48000/2`,
`pcm-s16/48000/1`, `red/48000/1`. `ptime` is milliseconds. `bitrate` is 0 when
unknown. Parameters are profile-specific key/value strings (`useinbandfec=1`,
`maxaveragebitrate=24000`).

Sets are **ordered by preference, most preferred first**.

### 6.2 Negotiation

Given offer `O` (caller, in `INVITE`) and answer `A` (callee, in `ACCEPT`):

1. Walk `O` in order. For each element, find the first element of `A` with the
   same `name` and compatible clock/channels.
2. The first match is **the** codec. Exactly one codec is chosen per stream.
3. Parameters from the answerer's element are authoritative where they are
   transport constraints (`ptime`, `bitrate`); parameters absent from the
   answerer's element are taken from the offerer's.
4. If no element matches, `ACCEPT` MUST NOT be sent; send `REJECT` with
   `NO_CAPABILITY`.

Consequences, all deliberate:

- Precedence belongs to the **caller**, so a caller's codec preference is
  honoured exactly and cannot be reordered by the callee.
- There is no re-offer, no `UPDATE`, no `PRACK`. Negotiation is one round trip
  and is complete when `ACCEPT` arrives.
- Payload-type numbers do not exist on the wire. The selected codec is named in
  `ACCEPT`; media datagrams carry its id (Section 9.1). There is nothing to
  remap and no asymmetric-payload-type class of bug.

### 6.3 Test profile

For loopback and conformance testing an endpoint MAY offer `pcm-s16/8000/1`
with `ptime=20` (160 samples, 320 octets per frame, comfortably inside the
1150-octet datagram limit of section 13). Real deployments MUST offer `opus/48000/1` or
`opus/48000/2`. An implementation that offers only test-profile codecs MUST NOT
be advertised as production-capable.

---

## 7. Call state machine

### 7.1 States

| State | Entered by | Media |
|---|---|---|
| `IDLE` | start, or end of `ENDED` | none |
| `OFFERED` | sending `INVITE` (caller) or receiving one (callee) | none |
| `RINGING` | receiving `RING` | none |
| `ACTIVE` | sending/receiving `ACCEPT` and committing a path | flowing |
| `ENDED` | `TERMINATE`, or any fatal reason | none |

`REJECT` moves directly `OFFERED → ENDED`. There is no `CANCELLED` state:
cancelling is `TERMINATE` with `reason=CANCELLED`, and it is idempotent.

### 7.2 Sequence

```
caller                                          callee
  | INVITE  (call, gen=1, caps, ncands)  ------->  |
  | <---------------------------------- RING        |   optional, repeatable
  | <-------------------------------- ACCEPT caps   |   negotiation fixed here
  | PATH (cands, token) <-------------------------> |   Section 8, both ways
  | PATH_ACK (path=direct|relay) <----------------> |
  | <=========== MEDIA (stream 0) ================> |
  | TERMINATE reason=NORMAL  -------------------->  |
  | <------------------- TERMINATE reason=NORMAL    |   one of the two is enough
```

`ACCEPT` carries the callee's capability set, its Reach candidates and its relay
handle. Media starts only after both sides have committed a path. `INVITE`
likewise carries the caller's handle (field 15), which is how the callee replies
when the offer arrived through a relay.

Signalling may always take the relay path. A node with a relay registration
SHOULD address its first message by `EndpointId` (section 4.3) and use the peer's
returned handle thereafter. Direct signalling is permitted when the peer's
address is already known from a static directory. This asymmetry is deliberate:
call set-up never depends on inbound reachability, and only *media* is
optimised toward a direct path.

### 7.3 Timers

| Timer | Value | On expiry |
|---|---|---|
| `T_RING` | 32 s | caller sends `TERMINATE reason=TIMEOUT` |
| `T_ANSWER` | 32 s | callee discards the offer, logs `TIMEOUT` |
| `T_TERMINATE` | 4 s | state becomes `IDLE`; duplicates absorbed |
| `T_KEEPALIVE` | 15 s (or peer's `keepalive_ms`) | send `PROBE` |
| `T_DEAD` | 3 missed keepalives | end call `reason=TRANSPORT_ERROR` |
| `T_REACH` | 300 ms | commit relay path (Section 8.6) |

### 7.4 Idempotency

Every call message carries `(call, gen, nonce)`. A node MUST:

- ignore any message whose `nonce` is ≤ the highest seen for that call from that
  sender,
- re-send its last response for a repeated `INVITE` identical to one already
  handled (retransmission absorption), for `T_TERMINATE` after `ENDED`,
- treat a second `TERMINATE` for the same call as a no-op.

This is why there is no `ACK`: nothing needs three-way confirmation, because
there are no unreliable-but-load-bearing transitions.

### 7.5 Glare

Both endpoints may `INVITE` with the same `CallId` (this happens on transfer and
on redial races). Resolve deterministically: compare `EndpointId` bytewise. The
lexicographically greater `from` wins; the loser MUST `REJECT` its own attempt
with `reason=GLARE` and accept the winner's offer. No retry timers, no glare
mitigation settings.

### 7.6 Hold and resume

Hold directs the sender to stop sending media and set `flags.pause` in `MEDIA`.
It is **not** a state change and **not** a re-negotiation: no `INVITE`, no
`re-INVITE`, no new SDP. Receiver MUST keep its own stream open and continue
sending unless it also pauses. `resume` clears the flag.

### 7.7 DTMF and typed events

Keypresses are `INFO` with `event=dtmf` and `payload` = one ASCII digit or
`*`/`#`/`A`–`D`. There is no in-band event packet and no RTP timestamp arithmetic
for tones. An endpoint MUST NOT send `INFO` for a key it did not receive from a
user.

### 7.8 Transfer

Transfer is `INVITE` carrying an existing `call` and `gen = gen + 1`, addressed to
the transfer target. The target becomes a normal call. Media of the original call
continues until the new call reaches `ACTIVE`, then the original is
`TERMINATE reason=NORMAL`. There is no `REFER`, no `Referred-By`, no `NOTIFY`
subscription.

---

## 8. Cantus Reach — traversal

Reach is the reason Cantus exists. It is not an optional feature; a conformant
endpoint always runs it.

### 8.1 The invariant

> **Every endpoint keeps a NAT mapping to its relay open for its entire
> lifetime, from the same socket it uses for media.**

Because signalling, media and registration share one socket (Rule 1), the mapping
created by `REGISTER` at startup is the mapping media uses. Traversal therefore
never depends on discovering a mapping; it depends only on *choosing* a path, and
one of the available paths is already open. There is no arrival order, no
timing window, and no configuration that can leave the call connected and silent.

### 8.2 Registration (always on, from startup)

```
endpoint -> relay   REGISTER  node, from, key, limits, nonce, sig
relay -> endpoint   REGISTER_ACK  observed, grant, handle, nonce, sig
```

- `observed` is the endpoint's address **as the relay saw it** (Section 8.3).
- `handle` is a relay-issued route handle for this registration. The relay uses
  it to address inbound datagrams to this endpoint.
- `grant` is a signed permission to use the relay for media: `handle`, expiry
  (default 300 s), byte quota, and the relay's media address. It is refreshed by
  the next `REGISTER`.
- Refresh every 20 s, or sooner if `grant` is closer to expiry than 3 × the
  refresh interval. A missing relay MUST NOT prevent direct calls; it removes
  only the fallback.
- The relay keeps **no call state**: it maps `handle → (address, expiry)` and
  forwards. It cannot read media (Section 9.6) and cannot join a call.

### 8.3 Observed addresses

`observed` = `family:varint ip:string port:varint`. This is the only reflexive
discovery mechanism in Cantus, and it is a single message on the connection that
already exists — no separate STUN server, no separate TURN server, no separate
ICE agent, no candidate-per-port explosion.

### 8.4 Candidates

A candidate list is:

```
cands = count:varint cand:count
cand  = kind:varint ip:string port:varint priority:varint token:bytes[8]
```

`kind`: 0 = udp4, 1 = udp6, 2 = tcp (via relay). `token` is 8 octets derived from
the `CallId` and generation. The probe challenge is 16 octets derived from the
same inputs, so both sides compute the expected value without extra signalling.
This is a **loop and liveness check, not an identity check**: it proves the
probe arrived over the path being probed. Identity is section 10, and because
the binding is encrypted a third party cannot learn the values to inject a
probe.

An endpoint MUST include, in this order of priority:

1. any local interface address that is globally routable,
2. its `observed` address from `REGISTER_ACK`,
3. its relay candidate: `relay address`, with the peer's expected handle.

A node MAY omit local candidates. A node MUST always include its relay candidate.
That is what makes the fallback unconditional.

### 8.5 Probing

Both endpoints probe; there is no controlling/controlled role.

1. On `PATH`/`ACCEPT`, send a `PATH` probe to every candidate of the peer.
2. A probe is a CONTROL `PATH` with `path=0`, the peer's `token`, a fresh 16-octet
   verification value in `token` field, and `time`.
3. A direct path is **confirmed** when a probe arrives from an address that
   appears in the peer's candidate list *and* carries the correct token.
4. Waves at 0 ms, 100 ms and 200 ms (three sends per candidate). This is
   simultaneous open: both sides send first, so endpoint-dependent and
   port-restricted mappings are opened in both directions without prediction.
5. **The confirmation reply travels back on the path it arrived by.** A probe is
   answered with a `PATH_ACK path=direct` sent **directly to the probe's source
   address**, never through the relay. This is the rule that makes confirmation
   meaningful: an acknowledgement relayed by a third party says nothing about
   whether a direct path exists, and a node MUST discard a `path=direct`
   `PATH_ACK` or probe whose source is its relay.
6. **No port prediction.** Cantus never guesses a mapping's port number; guessing
   is the source of the "works on some NATs" folklore.

### 8.6 Commit and the guarantee

- On confirmation, send `PATH_ACK path=direct` and begin media.
- At `T_REACH` (300 ms) with no confirmation, send `PATH_ACK path=relay` and
  begin media through the relay. **This is not a failure.** No reason code is
  raised, the call stays `ACTIVE`, and audio flows.
- Media MUST have started by `T_REACH + 100 ms`. A node that has committed no
  path by then MUST end the call with `PATH_FAILED` rather than leave it silent.

Because the relay mapping was opened at registration, the relay path needs no new
traversal at call time. The only case that reaches `PATH_FAILED` is a relay that
is unreachable, which is a node-level fault, not a NAT fault.

### 8.7 Failover and rebinding

Endpoints tolerate **both** paths at all times during a call:

- Media received via relay is accepted even if the committed path is direct.
- Media received directly is accepted even if the committed path is relay.

Rebinding (NAT mapping change, Wi-Fi handover, VPN flap) MUST be detected within
one second when evidence exists, and MUST NOT take longer than 2000 ms. Three
signals are examined on every `FEEDBACK` interval, in this order:

1. **Peer reception stall.** `FEEDBACK` carries `recv_high`, the highest media
   sequence number the peer has seen from us. Two consecutive reports at the same
   mark, spanning at least 400 ms, while we have kept sending (`SEND_STALL`
   frames beyond it), mean the committed path is delivering nothing we send. This
   is the only signal that reveals an asymmetric break — our own reception can be
   perfect while nothing we send arrives — and it MUST be acted on.
2. **Silence with a live peer.** No media from the peer for 400 ms while a report
   arrived within the last 1000 ms. The peer is demonstrably alive, so the silence
   is the path, not a pause.
3. **Silence alone.** No media for 2000 ms, whatever the reports say. This is the
   safety net that bounds the outage when the peer's reports stop as well.

The stall counter is cleared whenever a path is committed: reception evidence
belongs to the path it was gathered on, and reports that predate a commit MUST
NOT be read as a break on it.

Response, in this order, with no call teardown:

1. **re-`REGISTER`** immediately. The relay must learn the endpoint's new public
   address before it can carry audio to it; this is a registration refresh, not a
   call transition.
2. Switch media transmission to the relay at once, so the outage is bounded by
   the next packet rather than by the next retry.
3. Send `PATH` `path=relay` carrying **the sender's current candidate list**.
   After a rebinding the old candidates are dead, so a fallback announcement that
   does not refresh them cannot lead to recovery.
4. Re-probe in the background at 100 ms, 600 ms, 1600 ms and 4000 ms. **Each wave
   re-states the sender's candidates as well as probing**, because a single
   announcement can be lost while the peer is itself re-registering; recovery
   MUST NOT depend on one message arriving.
5. On a verified direct probe, switch back and send `PATH` `path=direct`. The
   reply is path-scoped as in 8.5, so the peer learns the address from the reply
   itself rather than from a claim.

**One-sided rebinding.** Only one endpoint need lose its mapping, and the failure
is asymmetric: the far side keeps a working mapping of its own, so it observes no
problem on its own account and MUST NOT rely on doing so. When a `PATH`
`path=relay` announcement carries a candidate list that differs from the one
currently held, the receiver MUST probe the new candidates immediately and start
its own retry wave, without announcing anything in response. That outbound packet
is what creates the mapping the rebound side's return probes require; without it
those probes are unsolicited inbound and are discarded by any NAT with
endpoint-independent filtering, so recovery waits on a probe that can never
arrive. Probing in response to an announcement is not the ping-pong forbidden
below — a probe is never answered with an announcement, because `path=direct` is
announced only on a change of state.

Two rules keep this from oscillating:

- A node that is receiving direct media MUST ignore a `path=relay` announcement
  for 500 ms after the last packet; a late announcement is stale, and abandoning
  a working path on hearsay produces audible flapping. Liveness here means media
  received **on the direct path**: media arriving over the relay says nothing
  about whether direct still works, and treating it as liveness makes a peer's
  correct fallback wait for no reason.
- A `path=direct` message whose source address is the relay MUST be ignored for
  path purposes (8.5). It proves nothing, and acting on it sends audio to the
  relay by mistake.

A call survives an IP address change. There is no re-INVITE, because the call's
media addressing is not part of its negotiated state.

### 8.8 Leaving NAT

Registration is also how an endpoint leaves a NAT that blocks UDP: if `REGISTER`
gets no reply over UDP, retry once over TCP 7443 (`cantus/tcp` binding). A TCP
binding is reported to peers as a `tcp` candidate whose address is the relay's.

---

## 9. Media

### 9.1 Framing

```
MEDIA = 0xCA 0x01 stream:varint tag:varint seq:varint ts:varint codec:varint flags:varint payload
```

| Field | Meaning |
|---|---|
| `stream` | 0 |
| `tag` | 16-bit call tag, `unpack('n', SHA-256(CallId)[0..1])` |
| `seq` | per-stream packet counter, starts at a random 16-bit value, wraps at 2^32 |
| `ts` | sample position in the codec clock (48 kHz), wraps at 2^32 |
| `codec` | id of the negotiated codec: 1 = opus, 2 = pcm-s16, 3 = red, 0 = reserved |
| `flags` | bit 0 `pause`, bit 1 `dtx`, bit 2 `marker` (start of talkspurt), bits 3–7 reserved, MUST be 0 |

Payload is the codec frame. No headers from other protocols, no CSRC list, no
extension blocks, no padding.

`tag` exists because every call in a node shares one socket: without it, a
receiver could not tell which session a 320-octet payload belongs to. It is
derived identically by both sides from the `CallId` with no extra signalling and
no negotiation, so it costs one varint and adds no state. A receiver MUST drop a
`MEDIA` datagram whose tag matches no ACTIVE session.

### 9.2 Profile

- Mandatory: **Opus**, 48 kHz, 20 ms, mono (stereo allowed if negotiated).
- Bitrate: 24 kbit/s default, 6–40 kbit/s adaptive (Section 9.5).
- `dtx` and `useinbandfec` SHOULD be enabled. `useinbandfec` costs ~10 % bitrate
  and is what makes loss survivable without retransmission.
- Audio is never retransmitted. Loss concealment is the receiver's job, and the
  receiver MUST conceal rather than insert silence.
- Clock is always 48 kHz, so timestamp arithmetic never needs resampling.
- Jitter buffer: adaptive, 20–200 ms, target = measured jitter + 2 frames,
  shrinks no faster than 1 frame per 2 seconds.

### 9.3 `pcm-s16` (conformance only)

`pcm-s16/8000/1`: raw little-endian signed 16-bit samples, 160 per 20 ms frame
(320 octets). Used for loopback tests and for implementations without an Opus
encoder. MUST NOT be offered on a production path. Its id is 2. The 8 kHz rate
is chosen so that a frame plus header stays far below the datagram limit; a
48 kHz PCM frame would be 1920 octets and would break section 13.

### 9.4 Silence and comfort noise

`dtx` frames are sent at 400 ms during silence with `flags.dtx` set and a payload
of at most 2 octets. A receiver MUST generate comfort noise for the gap rather
than digital silence.

### 9.5 Congestion feedback

`FEEDBACK` every 200 ms, `report` field:

```
report = loss_q8:varint rtt_us:varint jitter_us:varint recv_kbps:varint
         desired_kbps:varint frames_lost:varint recv_high:varint
```

`loss_q8` is loss in 1/256ths. `desired_kbps` is the receiver's request to the
sender. `recv_kbps` is the bitrate actually received in the reporting interval,
not a capability. `recv_high` is the highest media sequence number the receiver
has seen in this session; it is what tells a sender that its own packets are not
landing, which no local counter can reveal. A decoder MUST accept a report that
ends before `recv_high` (a 1.0 peer sends six fields) and MUST then rely on
silence detection alone. Senders MUST honour `desired_kbps` within one feedback interval and MUST
not exceed the peer's `max_bitrate` limit.

Degradation order when the path degrades, applied in this order, one step per
feedback interval: lower bitrate → disable stereo → enable `dtx` → reduce `ptime`
to 40 ms. Recovery reverses it no faster than one step per second (hysteresis).

### 9.6 Media confidentiality

Media payloads are opaque to Cantus and MUST be protected by the transport
binding: TLS 1.3 (QUIC) or DTLS 1.3, with the keys bound to the handshake of
Section 5.3. Cantus defines no in-band keying, no `a=crypto`, no MIKEY, no
`ZRTP`. A relay can forward a call it cannot understand, which is the only
property that makes a relay acceptable in a secure design.

---

## 10. Identity and integrity

### 10.1 Address of record

`EndpointId = name@domain`. The binding from `EndpointId` to public key is
published as a discovery record and cached. Cantus does not define the discovery
protocol; it defines the requirement that the key be obtained over an
authenticated channel and be stable for the record's TTL.

### 10.2 Signatures

Every `HELLO`, `HELLO_ACK`, `REGISTER`, `INVITE`, `ACCEPT` and `TERMINATE` MUST
carry `sig` over:

```
digest = SHA-256( "cantus/1-sig" || msg_type:varint ||
                  for each present field in ascending id order, excluding 5:
                      id:varint len:varint value_bytes )
```

- Normative: **Ed25519** over `digest`.
- Test profile `sig-hmac-sha256`: HMAC-SHA256 with a shared key, permitted only on
  loopback. A node MUST refuse the test profile on a non-loopback address.

A node MUST verify before acting. Verification failure = `AUTH_FAILED`, one
attempt, then a 30 s discard window for that address.

### 10.3 Replay

Per (peer, session) counter, per call generation. A message with `nonce` ≤ the
highest accepted is dropped. The window is 64 slots, so reordering within a
burst is tolerated but replay is not.

### 10.4 Spoofing

Because no decision depends on a claimed address, a forged source address gains
nothing: it cannot complete a `PATH` probe (needs the token), cannot produce a
valid `sig`, and cannot cause a call to be answered. This closes the class of
problems that arises from trusting `From`, or from address-based peer matching.

---

## 11. Reason codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `UNSPECIFIED` | none given |
| 1 | `BUSY` | callee at capacity |
| 2 | `NOT_FOUND` | no such `EndpointId` |
| 3 | `REJECTED` | policy said no |
| 4 | `UNAVAILABLE` | registered but not accepting |
| 5 | `TIMEOUT` | `T_RING`/`T_ANSWER` expired |
| 6 | `NO_CAPABILITY` | no common codec |
| 7 | `NOT_REACHABLE` | no route and no relay grant |
| 8 | `BAD_REQUEST` | malformed message |
| 9 | `GLARE` | Section 7.5 |
| 10 | `AUTH_FAILED` | signature or identity failure |
| 11 | `LIMIT` | would exceed a declared limit |
| 12 | `CANCELLED` | caller withdrew |
| 13 | `NORMAL` | completed |
| 14 | `TRANSPORT_ERROR` | `T_DEAD` |
| 15 | `PATH_FAILED` | Section 8.6 last resort |

Codes are stable and never reused. `text` may accompany any code but MUST NOT be
parsed.

---

## 12. Routing as data

An endpoint's behaviour on an arriving call is a document, not a script.

```json
{
  "version": 1,
  "default": { "reject": 3 },
  "routes": [
    { "name": "support-hours",
      "when": { "to": "support@example.net", "weekday": ["mon","tue","wed","thu","fri"],
                "time": "09:00-17:00", "limit": 20 },
      "then": [ { "answer": {} }, { "bridge": { "to": "queue.support" } } ] },
    { "name": "night",
      "when": { "to": "support@example.net" },
      "then": [ { "forward": { "to": "voicemail@example.net" } } ] }
  ]
}
```

Rules:

- Routes are evaluated **top to bottom, first match wins**. No implicit ordering,
  no priorities to reconcile.
- Predicates are ANDed inside one `when`. Supported: `to`, `from`, `weekday`,
  `time` (`HH:MM-HH:MM`, local to the endpoint's declared zone), `limit`
  (concurrent calls matched by this route), `event` (INFO subtype), `verified`
  (identity status).
- Actions, each an object with one key: `answer`, `reject`, `forward`, `bridge`,
  `play` (file), `record` (file, `max_ms`), `pause`, `noop`.
- `then` runs in order; an action that ends the call (`reject`, `forward`) stops
  evaluation. `bridge` connects to a declared resource; `play`/`record` are
  local.
- Evaluation MUST be side-effect free until the first action executes. This is
  what makes `cantus route-test` able to prove behaviour offline, which the
  dialplan cannot.
- An unknown predicate or action is a **document error**, rejected at load time,
  not a runtime surprise.

---

## 13. Limits and robustness

Norms for a conformant node:

| Resource | Cap |
|---|---|
| Datagram | 1150 octets, hard |
| Control message | 1150 octets, hard |
| Fields per message | 64 |
| Capability entries | 32 |
| Candidates | 16 |
| Concurrent calls | announced `max_calls`, default 64 |
| Message rate from one peer | 200/s control, 400/s media bursts absorbed |
| Unknown message types | counted, dropped |

On exceeding a cap: `BAD_REQUEST` or `LIMIT`, and drop. Never allocate to satisfy
a claimed size.

---

## 14. Security considerations

- **Confidentiality**: transport binding only (Section 9.6). No plaintext header
  carries a call's content; there is no analogue of a readable SIP `Call-ID` and
  `From` on the wire in a private deployment, because everything runs inside the
  binding.
- **Availability**: relay quota and per-peer rate limits bound amplification. A
  relay MUST NOT forward to an address that has no live `handle`.
- **Amplification**: `HELLO` is client-sized and `HELLO_ACK` is not materially
  larger; no request causes a response larger than itself to an unverified
  address.
- **Privacy**: a relay learns who talks to whom and when, and the byte volume.
  It cannot read media. Direct paths expose nothing to the relay.
- **Key compromise**: keys are per-endpoint; a rotated key invalidates outstanding
  `grant`s at the next `REGISTER`.

---

## 15. Conformance suite

A conformant implementation MUST pass, and SHOULD ship, tests for:

1. Varint and TLV round-trip, including 9-octet maximum and truncation rejection.
2. Unknown field and unknown message tolerance.
3. Capability negotiation: caller precedence, no-match rejection, single RTT.
4. State machine: every transition in Table 7.1, timer expiry, duplicate
   absorption, glare resolution both ways.
5. Reach: direct success within deadline; **relay fallback when direct is
   impossible, with media verified**; failover mid-call and return to a direct
   path, with **both** endpoints rebound and with **only one** rebound (in each
   direction); dual-path tolerance.
6. Routing: first-match precedence, document validation errors, offline dry-run
   equality with live evaluation.
7. Limits: exceeding `max_calls`, oversize datagram, oversize control message.
8. Signature verification failure and the 30 s discard window.

Test 5's relay case must be run behind a **symmetric NAT emulator** whose mapping
differs per destination. That is the only test that demonstrates the property this
standard exists for. Its rebinding cases must flush a real mapping table, and the
one-sided cases must flush exactly one, because an implementation that only ever
recovers when both ends move is not conformant to 8.7.

---

## Appendix A — Message summary

| # | Message | Direction | Required fields |
|---|---|---|---|
| 1 | `HELLO` | either | `version from key caps limits nonce sig` |
| 2 | `HELLO_ACK` | either | same, or `reason` on failure |
| 3 | `INVITE` | caller→callee | `from to call gen caps cands handle nonce sig` |
| 4 | `RING` | callee→caller | `call gen nonce` |
| 5 | `ACCEPT` | callee→caller | `call gen caps cands handle nonce sig` |
| 6 | `REJECT` | callee→caller | `call gen reason nonce` |
| 7 | `TERMINATE` | either | `call gen reason nonce sig` |
| 8 | `PATH` | either | `call gen path nonce`; `token` on a probe; `cands` on a fallback announcement |
| 9 | `PATH_ACK` | either | `call gen path nonce token`, sent on the probed path |
| 10 | `FEEDBACK` | either | `call report nonce` |
| 11 | `PROBE` | either | `time nonce` |
| 12 | `INFO` | either | `call event payload nonce` |
| 13 | `REGISTER` | endpoint→relay | `node from key limits nonce sig` |
| 14 | `REGISTER_ACK` | relay→endpoint | `observed grant handle nonce sig` |

Media and relay frames are not messages: `MEDIA` carries `stream tag seq ts codec
flags payload`, and `RELAY` carries `route [name] inner`.

## Appendix B — Wire examples

Actual output of the reference encoder, not an illustration. Field ids are
encoded as the varint `(id << 3) | wire_type`, so field 1 (string) is tag
`0x0A` and field 21 (string) is tag `0xAA 0x01`.

`HELLO`, 116 octets (`cantus encode hello`):

```
0000  CA 00 01 0A 0A 61 6C 69 63 65 40 64 65 6D 6F 20  .....alice@demo
0010  01 4A 33 02 0E 70 63 6D 2D 73 31 36 2F 38 30 30  .J3..pcm-s16/800
0020  30 2F 31 14 80 01 00 0C 6F 70 75 73 2F 34 38 30  0/1.....opus/480
0030  30 30 2F 31 14 18 01 0C 75 73 65 69 6E 62 61 6E  00/1....useinban
0040  64 66 65 63 01 31 AA 01 08 63 61 6E 74 75 73 2F  dfec.1...cantus/
0050  31 C2 01 20 01 01 01 ...                         1.. ...
```

Breakdown of the first line: `CA 00` magic + CONTROL, `01` type HELLO,
`0A` field 1 string, `0A` length 10, `alice@demo`, `20` field 4 varint = 1,
`01` value, `4A` field 9 bytes, `33` length 51, then the capability set
(`02` two entries, `0E` `pcm-s16/8000/1`, ...).

A `MEDIA` datagram, stream 0, tag `0x1234`, seq 1000, ts 48000, opus,
marker set, 40-octet payload (`cantus encode media`):

```
CA 01 00 B4 24 E8 07 80 F7 02 01 04 <40 octets>
 |  |  |   |     |     |     |  |
 |  |  |   |     |     |     |  +-- flags  = 0x04 (marker)
 |  |  |   |     |     |     +----- codec  = 1 (opus)
 |  |  |   |     |     +----------- ts     = 48000
 |  |  |   |     +----------------- seq    = 1000
 |  |  |   +----------------------- tag    = 0x1234
 |  |  +--------------------------- stream = 0
 |  +------------------------------ kind   = MEDIA
 +--------------------------------- magic
```

## Appendix C — Differences from SIP, in one table

| Concern | SIP/Asterisk model | Cantus |
|---|---|---|
| Ports | signalling + 20,001 media ports | 1 |
| NAT | opt-in ICE, 6 interacting knobs, static external IP | Reach, always on, no config |
| NAT failure | call connects, audio silent | relay path guaranteed |
| Negotiation | SDP text, re-offers, UPDATE/PRACK | typed set, one round trip |
| Answer confirmation | ACK on unreliable transport | no ACK needed |
| Teardown | BYE + CANCEL + ACK races | one idempotent `TERMINATE` |
| Identity | `From` header, digest bolt-on | long-term key, per-message signature |
| Hold | re-INVITE, new SDP | flag in `MEDIA` |
| DTMF | RFC 4733 event packets | typed `INFO` |
| Fax | T.38 | out of scope |
| Routing | runtime dialplan language | schema-checked document |
| Extensibility | vendor parameters | unknown-field tolerance |
| Media security | optional SRTP/DTLS per endpoint | mandatory via binding |
| Liveness | OPTIONS, qualify timers | `PROBE` + `T_DEAD` |
| Code size to implement | ~56 k lines for the SIP stack alone | ~2 k lines (reference) |

## Appendix D — SIP feature mapping

| Present in SIP/Asterisk | Cantus |
|---|---|
| `INVITE`/`ACK`/`CANCEL`/`BYE` | `INVITE`/`ACCEPT`/`TERMINATE`/`TERMINATE` |
| `100rel`, `PRACK` | removed (transport handles reliability) |
| `UPDATE`, `re-INVITE` | removed (no re-negotiation) |
| SDP `m=`/`a=` grammar | capability set |
| Payload type numbers | codec ids in `MEDIA` |
| `REGISTER`, registrar, `Expires` | `REGISTER`/`REGISTER_ACK` to a relay |
| OPTIONS / qualify | `PROBE` |
| `REFER`, `NOTIFY` | `INVITE` with `gen+1` |
| RFC 4733 `telephone-event` | `INFO event=dtmf` |
| T.38 / UDPTL | out of scope, by design |
| `ice_support`, `rewrite_contact`, `rtp_symmetric`, `force_rport`, `external_media_address` | removed: Reach has no knobs |
| `extensions.conf` dialplan | routing document |
| `chan_pjsip`/`chan_iax2`/`chan_*` plugins | one protocol, one implementation |
