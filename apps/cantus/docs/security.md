# Security model

**What Cantus guarantees, what it deliberately removes, and what is still
missing before "most secure" is a claim rather than a direction.**

This document describes the code in this monorepo, not an aspiration. Where the
normative standard requires something the reference stack does not yet implement,
that is stated as a gap with its consequence.

Normative text: [`spec/CANTUS-1.0.md`](../spec/CANTUS-1.0.md) §10 and §14.
SIP-side posture: [`spec/CANTUS-SIP-BORDER.md`](../spec/CANTUS-SIP-BORDER.md) §7.

---

## 1. Goals

| Goal | How the design pursues it |
|---|---|
| An attacker on the network cannot place, answer or join a call | every state-changing message is signed, every identity is key-bound, every source address is a hint |
| A forged packet cannot reach a microphone or speaker | media is accepted only for an ACTIVE call with a committed path, demuxed by a `CallId`-derived tag |
| There is no internet-facing PBX to scan | one UDP port, no registrar, no SIP surface inside the estate |
| A relay is not a place to hide | the relay holds no call state, cannot join a call, and is not trusted for identity or path confirmation |
| Traffic volumes cannot be amplified | bounded datagrams, bounded field counts, no response larger than its request to an unverified address |
| Failures are visible, not silent | a call cannot be `ACTIVE` without a committed path; a refusal carries a reason code |

Non-goals: anonymity, traffic-analysis resistance, protecting against a
compromised endpoint, or replacing the platform's identity provider. Cantus
carries a *call* identity; Authentik owns *user* identity.

---

## 2. Structural controls

These hold because of how the protocol is shaped, not because a setting is on.

1. **One port, one protocol.** Signalling, media, probing and registration share
   a socket. There is no second listener to find, no SIP registrar to brute-force,
   no RTP range to scan, no AMI socket, and no `From` header that means anything
   to the switch. A deployment that keeps a SIP registrar alongside Cantus has
   reintroduced the entire attack surface Cantus removes.
2. **Nothing is trusted by position.** A message is accepted on its signature and
   replay counter, never because it arrived from an address the node recognises.
   Reach candidates are hints for *media*; they never authorise a call. The
   consequence is that source-address spoofing buys an attacker nothing: they
   cannot sign, cannot complete a `PATH` probe without the call-derived token,
   and cannot cause a call to be answered.
3. **Signed transitions.** `HELLO`, `HELLO_ACK`, `INVITE`, `ACCEPT`,
   `TERMINATE`, `REGISTER` and `REGISTER_ACK` carry a signature over a canonical
   encoding of the message with the signature field excluded
   (`lib/Cantus/Wire.pm`, `cantus-switch/src/wire.js`). A verification failure
   discards the message and emits `auth-fail`. The standard also requires a
   30-second discard window for that address; that part is not implemented (§4.2).
4. **Replay is bounded.** A monotonic per-peer nonce and a 64-slot window mean a
   captured message cannot be replayed, while ordinary reordering is tolerated.
5. **Media has its own demux.** A `MEDIA` datagram carries a 16-bit tag derived
   from the `CallId`. A datagram whose tag matches no ACTIVE session is dropped,
   so a stray or forged payload cannot be injected into another call on the same
   socket.
6. **The relay is a forwarder, not a participant.** Registration maps a handle
   to `(address, expiry)` and nothing else. There is no call table, no media
   processing, no nesting of relay datagrams, and no forwarding to an address
   without a live registration. A relay restart drops forwarding, not calls'
   state, because it never had any.
7. **Bounded everything.** Datagrams and control messages are capped at 1150
   octets, candidates at 16, capability entries at 32, fields at 64. A size
   claim is never used to allocate. Exceeding a cap is `BAD_REQUEST`/`LIMIT` and
   a drop.
8. **No downgrade inside the estate.** Cantus does not fall back to another
   dialect when a handshake fails; it reports a reason. SIP exists only at a
   border, and the border cannot relax the Cantus side's guarantees.

### 2.1 Control-plane controls

| Surface | Control | Where |
|---|---|---|
| `/v1/*` | bearer token (`CANTUS_CONTROL_TOKEN`), 401 without it | `cantus-switch/src/server.js` |
| `/ws/line` | same token (header or query) | `server.js` |
| `/ari/*`, `/ari/events` | HTTP Basic, one user per app | `cantus-switch/src/ari.js` |
| body reads | 2 MiB cap, JSON only | `server.js` |
| routing document | validated at load and on write; 422 with errors | `router.js`, `Router.pm` |
| gateway status | no write surface except the explicit `/srtp` toggle | `cantus-gateway/src/index.js` |

The switch exposes no shell, no file read, no dialplan evaluation of arbitrary
code, and no ARI resource that can execute a command. `ari` hands a call to an
application; the application cannot ask the switch to run anything.

---

## 3. Threat model

| Threat | Control in place | Residual risk |
|---|---|---|
| **Caller spoofing** — claim someone else's `EndpointId` | signed messages, key-bound identity; signature checked before acting | in the reference profile the "key" is a deployment-wide shared secret, so any node holding it can impersonate another (§4) |
| **Replay / retransmission attack** | per-peer nonce + 64-slot window; duplicate `INVITE` re-sends the last response, does not re-ring | none beyond the window's design |
| **Media injection** | `CallId` tag, ACTIVE-session check, path-scoped probes, SDES/DTLS at the border | a direct path is only as private as the transport binding (§4) |
| **Path hijack / forced relay** | `PATH_ACK path=direct` must arrive from the candidate address with the call token; relay-sourced "direct" messages are ignored; liveness is measured on direct media only | a relay that lies about observed addresses can deny direct paths, not read media |
| **Relay abuse** | no call state, no nesting, no forwarding without live registration, signed registration and grants, byte quota, expiry | a relay learns who talks to whom and the byte volume |
| **Unauthenticated call setup** | `ACCEPT` requires a verified `INVITE`; `INVITE` requires a verified `HELLO` session | — |
| **Amplification / reflection** | `HELLO` and `HELLO_ACK` are comparable in size; no response larger than its request to an unverified address; rate limits per peer | — |
| **Control API takeover** | bearer token, 401 by default, no default token | a token in a query string can appear in proxy logs |
| **Toll fraud through the border** | the switch decides every outbound call; the gateway refuses numbers it cannot parse; carrier failures return causes | a compromised switch can still dial; rate limiting is a carrier/account concern |
| **SIP scanning / registration brute force** | there is no SIP listener except the gateway's trunk socket, which does not accept registrations (`405`), and no inbound endpoint registration anywhere | the gateway's carrier socket is still internet-reachable and must be firewalled to the carrier |
| **Carrier media interception** | SDES-SRTP optional at the border | signalling is plaintext, so the key is visible on the path; not a substitute for SIPS/DTLS |
| **Compromised endpoint** | per-endpoint identity, per-call generation, limits | out of scope: an endpoint can always misuse its own microphone |
| **Denial of service** | bounded datagrams and counts, per-peer rate limits, no unbounded allocation | a saturated link is a network problem, not a protocol one |

---

## 4. Gaps, with consequences

These are the reasons this document does not claim the deployment is already the
most secure voice protocol in existence. Each is a known, bounded delta between
the normative standard and what ships.

**4.1 — Ed25519 is not implemented.** The standard's normative profile is
Ed25519 per-message signatures (§10.2). Both implementations ship
`sig-hmac-sha256`, the loopback test profile, with a deployment-wide
`CANTUS_SECRET` (`cantus-switch/src/identity.js`, `lib/Cantus/Identity.pm`).
Consequence: any node that holds the secret can sign as any other node, and a
single leak compromises every node in the estate. The signature mechanism,
canonical input and verification path are correct; the primitive and per-node
keying are not.

**4.2 — The 30-second discard window is missing.** §5.3.1 and §10.2 require a
node to discard traffic from an address for 30 seconds after a failed
verification. The code drops the failing message and emits `auth-fail`, then
keeps processing the next one. Consequence: a replay of a previously valid
message (rejected by the nonce window) or a flood of forgeries is handled
per-message instead of being cut off at the address. It is not an authentication
bypass, but it is a cheaper attack than the standard allows.

**4.3 — The test profile is not refused off-loopback.** §10.2 says a node MUST
refuse `sig-hmac-sha256` on a non-loopback address. The reference switch and
gateway will run it on `0.0.0.0` because the estate does. Consequence: the
protocol's identity guarantee is weaker than the standard's text wherever this
profile is used in production.

**4.4 — There is no transport encryption.** §9.6 requires media confidentiality
from a TLS 1.3 / DTLS 1.3 binding; the reference stack has no such binding.
Media on a direct path is plaintext on the wire, and a relay can read it even
though it is designed not to. Consequence: confidentiality today comes from the
network (private VLAN, VPN, WireGuard), not from Cantus. The relay-blind
property is a design property awaiting the binding, not a shipped one.

**4.5 — The default secret is a default.** `CANTUS_SECRET` defaults to
`cantus-loopback` in the switch, gateway and compose files. Consequence: an
estate that never sets it shares a publicly known signing key. Every deployment
must set it; the value is a deployment secret, not a repo value.

**4.6 — SDES is the only carrier encryption.** At the border, keys travel in SDP
over plain UDP. A carrier that answers `SAVP` without a key is carried as plain
audio with a logged `srtp-missing` event — the one sanctioned downgrade, and it
is visible in the logs and in `GET /srtp`.

**4.7 — No key rotation.** A node's identity is fixed for its lifetime. Rotating
a secret invalidates outstanding relay grants and requires restarting the nodes
that share it.

**4.8 — No audit sink.** Call events, CDRs and refusals are emitted over the
event socket and printed, but nothing ships them to an append-only store. A
compromised switch can therefore rewrite its own local history. WARDEN is a
read-only viewer, not an audit log.

**4.9 — The control API is HTTP.** Inside the compose network it is plaintext;
the bearer token is the only authentication. A deployment that exposes 8088 to
anything wider must put TLS and an authenticating proxy in front of it.

Closing 4.1–4.4 is the work that turns this design into the standard it
describes. Until then, the correct statement is: **Cantus removes the attack
surface of SIP structurally; its cryptographic profile is the strongest part of
the design on paper and the weakest part of the reference implementation in
practice.**

---

## 5. Deployment hardening

Ordered by what removes the most risk for the least effort.

| # | Action | Why |
|---|---|---|
| 1 | Set `CANTUS_SECRET` to a per-deployment random value, not `cantus-loopback` | default key = every node can impersonate every node |
| 2 | Set `CANTUS_CONTROL_TOKEN`; never expose 8088 without it | the control API can originate and hang up calls |
| 3 | Keep 7443/7444 UDP and 8088 TCP on a private network; publish only the gateway | the switch has no business on the internet |
| 4 | Restrict the gateway's SIP socket (5060) and RTP range to the carrier's addresses | the only internet-facing voice surface |
| 5 | Keep `SIP_SRTP=on` where the carrier supports it, and verify with `GET /srtp` | carrier media is otherwise readable on the path |
| 6 | Run the relay on a host with no access to recordings, CDRs or the control API | a relay compromise should reveal metadata, not calls |
| 7 | Give WARDEN a read-only proxy path, not the control token | a viewer cannot hang up a call |
| 8 | Put the ARI surface behind the same private network as the agents | ARI can answer, play, record and bridge |
| 9 | Rotate `CANTUS_ARI_PASSWORD` and trunk credentials on deploy | they are static otherwise |
| 10 | Keep the switch's `data/` (recordings) on an encrypted volume | recordings outlive the call |

Validation, not assumption:

```sh
# Unauthenticated control is refused.
curl -s -o /dev/null -w '%{http_code}\n' http://switch:8088/v1/status     # 401

# The border is only healthy when both halves work.
curl -s http://gateway:7454/healthz                                      # 503 with a reason

# What the next carrier call will offer.
curl -s http://gateway:7454/srtp                                         # {"enabled":…}
```

---

## 6. What is verified today

| Property | Test |
|---|---|
| the signing input excludes the signature field, so it cannot sign itself | `t/00-wire.t` |
| unknown fields survive round-trip and are not given meaning | `t/00-wire.t` |
| replay is dropped by the nonce window | `t/02-session.t` |
| oversize control messages are refused rather than fragmented | `t/00-wire.t` |
| direct cannot be committed behind a symmetric NAT; relay carries the call | `t/11-nat.t` |
| a lost mapping fails over and returns to direct without ending the call | `t/12-rebind.t`, `t/13-rebind-one.t` |
| control API refuses without the token (401) | `cantus-switch/test/server.test.js` |
| ARI refuses without Basic credentials (401) | `cantus-switch/test/server.test.js` |
| SRTP drops altered packets and packets from the wrong key | `cantus-gateway/test/srtp.test.js` |
| an unimplemented SDES profile is refused, not half-supported | `cantus-gateway/test/srtp.test.js` |
| a carrier keypress becomes one Cantus `INFO`, and vice versa | `cantus-gateway/test/dtmf.test.js` |
| every reason/status mapping row is exercised | `cantus-gateway/test/reason.test.js` |

Run them with `make test` in `apps/cantus`, `npm test` in `apps/cantus-switch`
and `apps/cantus-gateway`.

---

## 7. Reporting

Security issues in the protocol or the reference implementation should go to the
maintainer privately rather than into a public issue: see the repository's
`SECURITY.md` where present, or contact **Darnel Hunter <dhunter@innotel.us>**.
A protocol issue that affects deployed estates (identity, replay, path
selection, amplification) is treated as urgent; a documentation gap is not.
