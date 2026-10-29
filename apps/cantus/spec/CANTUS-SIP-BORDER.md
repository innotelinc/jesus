# Cantus 1.0 — SIP Border Profile

**SIP where it is unavoidable, and nowhere else.**

Status: Candidate profile, revision 1.0.
Pairs with: Cantus 1.0 (`CANTUS-1.0.md`).
Reference implementation: [`cantus-gateway`](../../cantus-gateway).

---

## 0. Abstract

Cantus 1.0 replaces SIP inside a deployment: every endpoint, switch, relay and
agent speaks one protocol on one socket. It does not replace the public
telephone network, which is reachable only through a carrier that speaks SIP and
RTP. This profile defines the **border node** that stands between the two, and
the rules that keep SIP from leaking past it.

A border is a normal Cantus node with a trunk attached. It is not a proxy, not a
B2BUA in the SIP sense, and not a place where call state lives. It translates a
small, enumerated set of things:

| Thing | Cantus side | SIP side |
|---|---|---|
| Call setup | `INVITE`/`ACCEPT`/`TERMINATE` | `INVITE`/200/`BYE`, `CANCEL` |
| Audio | 20 ms PCM16 on the media socket | 20 ms PCMU in RTP |
| Keypresses | `INFO event=dtmf` | RFC 4733 `telephone-event` |
| Refusal | reason code (§11 of the standard) | SIP status code |
| Identity | key-bound `EndpointId` | digest-authenticated trunk account |

Everything else about SIP is **out of scope on purpose**: re-INVITE, `REFER`,
`PRACK`, session timers, forking, T.38, video, and SIP over TLS. A border that
answered those half-way would be a SIP stack, and the point of this profile is
that no deployment needs one.

---

## 1. Position in the network

```
   PSTN ──SIP/RTP──▶ border ──Cantus──▶ switch ──Cantus──▶ endpoints
                     (one node)        (routing)          (phones, browsers, agents)
```

Normative rules:

1. **SIP terminates at the border.** No endpoint, agent or switch process may
   open a SIP socket. A deployment has exactly one border per carrier trunk.
2. **The border is a Cantus node.** It `REGISTER`s with the relay, signs its
   messages, runs Reach, and accepts media on the relay path like any endpoint.
   There is no second traversal mechanism for the trunk: the carrier's RTP port
   range is the only configured range, and it exists inside the border.
3. **The border does not route.** An inbound DID becomes a Cantus call addressed
   at the switch, carrying the DID as the dialled address (`§2`). The routing
   document decides what rings. A border that chose a line would be a second
   dialplan.
4. **A refusal is carried, not invented.** If the switch rejects a call, the
   border must send the mapped SIP status (`§5`), not a generic failure.
5. **No SIP feature is emulated in Cantus.** Hold is a media flag, transfer is a
   new `INVITE` with `gen+1`, DTMF is typed `INFO`. The border does not
   synthesise SIP dialogs to imitate a PBX.

### 1.1 What the border may keep

Only what a SIP dialog requires, keyed by the Cantus `CallId`:

- the SIP `Call-ID`, tags and `CSeq` of the leg,
- the carrier's media address and negotiated payload types,
- the SDES keys for this call, when encrypted,
- the RTP socket and its counters.

No routing table, no registration database, no recording, no CDR. A border that
restarts loses its calls and nothing else.

---

## 2. Addressing

The Cantus address of an outbound call is `<number>@<trunk>@<border>`, e.g.
`14134210134@voipms@gateway`. The first component is what is dialled; the second
selects the trunk on the switch; the third names the node.

Inbound, the border addresses the switch as `<did>@<switch>` where `<did>` is the
number the carrier dialled. Properties:

- The DID is a **dialled address**, not metadata. A routing document can match
  `+14132642700@*` with the same pattern syntax it uses for extensions.
- The caller's number is carried in `INVITE` context (source `sip`,
  `from`), not in the address. It is display and policy data, never a routing
  key that the border itself acts on.
- A number that cannot be parsed as a dialable address (6–15 digits, optional
  leading `+`) is refused before a Cantus call exists.
- **No SIP URI ever appears in a routing document.** If a determinant of a call
  is a URI, hostname, transport or header, it stays at the border.

---

## 3. Media

### 3.1 Mandatory codec

**PCMU (G.711 µ-law), 8 kHz, mono, 20 ms.** RTP payload type 0 in the static
table; no dynamic mapping is needed or accepted.

- Cantus carries PCM16/8000/1 across the border (`pcm-s16`, the standard's
  conformance codec). PCM16↔µ-law is a table lookup per sample; no resampler, no
  frame re-blocking, no jitter buffer beyond one frame.
- Any other codec in the carrier's `m=audio` line is refused with
  `488 Not Acceptable Here`. Offering G.722/G.729/Opus and then carrying silence
  is the failure mode this refusal prevents.
- The Opus profile of the standard is for Cantus endpoints. A border that
  re-encoded to Opus for the PSTN leg would add a transcode the carrier does not
  use; it is explicitly not part of this profile.

### 3.2 Encryption

- `RTP/SAVP` with an SDES inline key (`AES_CM_128_HMAC_SHA1_80`) MAY be offered
  and answered. It is the only encrypted carrier transport this profile defines.
- If the carrier offers `RTP/SAVP` and encryption is off, or the key is missing
  or uses a profile the border does not implement, the call is refused with
  `488`. It must not be answered as plain `RTP/AVP`: an encrypted carrier that is
  told `200 OK` for plain media cannot read what it receives.
- If the border offered `SAVP` and the carrier answers without a key, the
  reference implementation logs `srtp-missing` and carries the call as plain
  audio. This is the **single sanctioned downgrade** in the profile: the carrier
  has already chosen the transport, and refusing would end a call both sides
  can otherwise carry. It is logged with the number so an operator can fix the
  sub-account, and it is why §6 requires the border's state to be observable.
- SIP signalling itself is UDP and unencrypted in this profile. `sips:` and
  `UDP/TLS/RTP/SAVP` are refused rather than downgraded.

### 3.3 What is refused

| Offered | Result | Why |
|---|---|---|
| No `m=audio`, or no payload 0 | `488` | nothing carryable |
| G.722, G.729, Opus, multi-codec offers | `488` | PCMU only; no transcoding |
| `SAVP` without a usable key | `488` | cannot encrypt as asked |
| Second `m=` line, video, T.38 | `488` | a Cantus call is one audio stream |
| re-INVITE in a confirmed dialog | ignored (no 491 is sent) | no re-negotiation exists |

---

## 4. Keypresses

A digit is not audio, and a gateway that treats it as audio silently drops every
IVR on the PSTN side. The mapping is exact and bidirectional:

```
carrier  ──RTP PT=<telephone-event> (RFC 4733)──▶  border  ──INFO event=dtmf──▶  switch
switch   ──INFO event=dtmf──────────────────────▶  border  ──RTP PT=<telephone-event>──▶  carrier
```

Normative rules:

1. **Payload type is negotiated, never assumed.** The border reads
   `a=rtpmap:<pt> telephone-event/8000` from the carrier's SDP and uses that
   number for both directions. An answer must not name a payload type the offer
   did not contain; if the carrier offers none, the border's answer omits the
   event type and the call has no keypress path.
2. **The offer advertises an event type.** The border's own offer includes
   `telephone-event/8000` and `a=fmtp:<pt> 0-16`, so a carrier that can send
   digits as events will.
3. **One digit per key, not per packet.** An RFC 4733 keypress is a burst of
   packets repeating one event number with a growing duration, terminated by a
   packet with the end bit. The border MUST emit one Cantus `INFO` for the burst
   and MUST NOT forward the repeats — a single `1` press would otherwise take
   an IVR menu eleven times. A new event number after the end bit is a new key.
4. **Digits map by the RFC, not by ASCII.** `0`–`9` are events 0–9, `*` is 10,
   `#` is 11, `A`–`D` are 12–15. Anything else is not a key and is not sent.
5. **No in-band DTMF.** The border neither generates nor detects audio tones.
   A carrier that sends keys as audio is not supported, and saying so is
   cheaper than a tone detector that works half the time.

The `INFO` payload is one ASCII digit or `*`/`#`/`A`–`D`, per §7.7 of the
standard. The switch re-evaluates the routing document with `event: "<digit>"`,
so an IVR needs no code that knows about SIP at all.

---

## 5. Refusal mapping

The switch's reason code is information a carrier acts on: `486` goes to
call-forward-busy, `480` tries the next branch, `404` is a wrong number. The
mapping is normative for a border.

### 5.1 Cantus → SIP

| Cantus reason | Status | Phrase |
|---|---|---|
| `BUSY` | 486 | Busy Here |
| `NOT_FOUND` | 404 | Not Found |
| `REJECTED` | 403 | Forbidden |
| `UNAVAILABLE` | 480 | Temporarily Unavailable |
| `TIMEOUT` | 408 | Request Timeout |
| `NO_CAPABILITY` | 488 | Not Acceptable Here |
| `NOT_REACHABLE` | 503 | Service Unavailable |
| `BAD_REQUEST` | 400 | Bad Request |
| `GLARE` | 491 | Request Pending |
| `AUTH_FAILED` | 403 | Forbidden |
| `LIMIT` | 486 | Busy Here |
| `CANCELLED` | 487 | Request Terminated |
| `TRANSPORT_ERROR`, `PATH_FAILED` | 503 | Service Unavailable |
| `UNSPECIFIED` | 480 | Temporarily Unavailable |

`LIMIT` maps to 486 rather than 503 deliberately: at capacity, a carrier should
try the next number, not take the trunk out of rotation.

`NORMAL` is not a refusal and MUST NOT be sent as an SIP status; it ends a call
through `BYE`.

### 5.2 SIP → Cantus

| Status | Cantus reason |
|---|---|
| 400 | `BAD_REQUEST` |
| 401, 407 | `AUTH_FAILED` |
| 403 | `REJECTED` |
| 404 | `NOT_FOUND` |
| 408 | `TIMEOUT` |
| 480 | `UNAVAILABLE` |
| 486, 600 | `BUSY` |
| 487 | `CANCELLED` |
| 488, 606 | `NO_CAPABILITY` |
| 491 | `GLARE` |
| 503 | `UNAVAILABLE` |
| 603 | `REJECTED` |
| other 4xx/5xx | `REJECTED` |
| no answer (timer) | `TIMEOUT` |

Only the **status number** is parsed. The reason phrase is the carrier's own
wording and no two carriers agree on it; matching text would make behaviour
depend on a vendor's copywriting.

---

## 6. Failure and observability

- **No carrier configured** is a state, not a boot failure. PSTN calls are
  refused with `REJECTED` and a logged cause; the switch keeps routing internal
  calls. A border that refused to start would take the estate with it.
- **The Cantus leg is answered only when the carrier answers**, outbound. A
  failed outbound call therefore has a cause the switch records, instead of a
  32-second silence followed by a timeout.
- **A health endpoint must mean both halves.** `GET /healthz` returns 200 only
  when the Cantus socket is bound *and* the trunk is registered; otherwise 503
  with the reason. A load balancer that sees 200 for a border with a dead trunk
  is worse than no health check.
- **The carrier's refusal text is logged verbatim.** `404 Not Found` and
  `403 Call barred by carrier` both become reasons on the switch, but the
  operator needs the carrier's words to tell them apart.

---

## 7. Security posture

The border is the only place in a Cantus deployment that touches untrusted
bytes from outside the estate. It is therefore also the only place allowed to be
boring.

1. **SIP never crosses the border.** An endpoint cannot be reached over SIP, so
   there is no registration port to scan, no digest to brute-force, and no
   `From` header to spoof into an internal call. This is the single largest
   reduction in attack surface in the design, and it is structural rather than
   configured.
2. **The trunk account is a credential, not an identity.** It authenticates the
   carrier to the border (digest) and says nothing about the caller. Caller
   numbers from `From` are metadata; a route may use them, but the border never
   authorises anything by them.
3. **Cantus is not downgraded.** The Cantus leg keeps its signing, replay window
   and Reach guarantees regardless of what the carrier does. A failure on the
   SIP side is a reason code on the Cantus side, never a relaxation of it.
4. **Media is bridged, not mixed.** One RTP socket per call, closed when the leg
   ends. No recording, no conference mixer, no shared port that a stray packet
   can join.
5. **Encryption state is explicit and observable.** `GET /srtp` reports what the
   next call will offer; a deployment can compare it against what the carrier
   expects without making a call.

A full threat model, including what is still missing (Ed25519 at the border,
DTLS, key rotation), is in [`docs/security.md`](../docs/security.md).

---

## 8. Conformance

A border implementation is conformant when it passes, at minimum:

1. SDP round-trip: offered and answered media addresses, PCMU detection,
   `SAVP` detection, and the telephone-event payload type read from the far side.
2. A keypress burst (start packets plus end packet) produces exactly one Cantus
   `INFO`; a following different key produces one more.
3. A Cantus `INFO` produces an RTP event packet with the negotiated payload type
   and the RFC event code.
4. Every row of §5.1 and §5.2, in both directions.
5. An offer with no PCMU, or with `SAVP` and no key, is refused rather than
   answered.
6. A carrier that never answers fails the call with `TIMEOUT`; a carrier that
   refuses with 404 produces `NOT_FOUND`.
7. `/healthz` is 503 for a bound Cantus socket with unregistered trunk, and for
   the reverse, and 200 only when both work.

The reference implementation runs these in
[`cantus-gateway/test/`](../../cantus-gateway/test): `sip.test.js` and
`dialog.test.js` for SDP and dialogs, `dtmf.test.js` for keypresses in both
directions, `reason.test.js` for the mapping tables, `srtp.test.js` for SDES and
`gateway.test.js` for the bridge itself. Media assertions use real UDP sockets,
so a parser that only agrees with itself does not pass.

---

## 9. Limits, stated

- **PCMU only.** No G.722, G.729, Opus or wideband audio across the border.
- **No SIP over TLS, no DTLS-SRTP.** Signalling is plain UDP; media encryption
  is SDES only. A carrier that requires `sips:` is not reachable through this
  profile.
- **No re-INVITE, REFER or PRACK.** A transfer across the border is a new call
  from the switch, not a SIP `REFER`.
- **No T.38 and no fax.** Cantus does not carry fax; a fax path needs a separate
  service, and a deployment that used Asterisk for it must keep one.
- **One trunk per border.** Multiplexing carriers is a second border process.
- **No carrier-side call recording or monitoring.** The border is not a media
  server.

---

## Appendix A — Message flow, inbound

```
carrier                    border                        switch
  | INVITE (DID, PCMU) -----> |                              |
  | <----- 100, 180 --------- |                              |
  |                           | INVITE <did>@switch --------> |
  |                           | <---------------- ACCEPT ----- |
  |                           | PATH probes (Reach) <-------> |
  | <----- 200 OK + SDP ----- |  media starts on chosen path  |
  | <======= RTP PCMU =======>| <===== Cantus PCM16 ========> |
  | ---- RTP event (#) ------>| INFO event=dtmf (#) --------> |
  |                           | <------- INFO event=dtmf (5) - |
  | <---- RTP event (5) ------|                              |
  | <--------- BYE ---------- | <--------- TERMINATE -------- |
```

## Appendix B — Message flow, outbound

```
switch                    border                     carrier
  | INVITE 1413…@voipms@border -> |                        |
  |                          | INVITE (SIP, PCMU) -------> |
  |                          | <---------- 180, 200 ------ |
  |                          | ACK ----------------------> |
  | <--------------- ACCEPT --|  media starts              |
  | <===== Cantus PCM16 =====>| <===== RTP PCMU ==========>|
  |                          | <---------- BYE ----------- |
  | <------------ TERMINATE --|                            |
```

The Cantus side is accepted only after the carrier's 200, which is why a refused
outbound call reaches the switch as a reason rather than as a ring that never
ends.
