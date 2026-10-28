<div align="center">

# CANTUS

[![CI](https://github.com/innotelinc/cantus/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/cantus/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-brightgreen.svg)](LICENSE)

**Voice that connects, or says why it didn't.**

A realtime voice standard built around **one socket**, specified from scratch and
implemented as a dependency-free Perl reference stack: no SIP, no SDP, no RTP,
no port range to open, and no way for a call to connect with silent audio.

[![Perl 5.16+](https://img.shields.io/badge/perl-5.16%2B-39457e)](spec/CANTUS-1.0.md)
[![Dependencies: none](https://img.shields.io/badge/dependencies-none-2ea043)](lib/Cantus)
[![Assertions: 167](https://img.shields.io/badge/assertions-167%20passing-2ea043)](t)
[![NAT: always on](https://img.shields.io/badge/traversal-always%20on-f5b95b)](spec/CANTUS-1.0.md)
[![Landing page](https://img.shields.io/badge/landing-innotelinc.github.io%2Fcantus-2ea043)](https://innotelinc.github.io/cantus/)

**Landing page:** [innotelinc.github.io/cantus](https://innotelinc.github.io/cantus/) ·
**The standard:** [spec/CANTUS-1.0.md](spec/CANTUS-1.0.md) ·
**Known limits:** [below](#status-and-known-limits)

</div>

---

## Why Cantus

| Problem | Cantus answer |
| --- | --- |
| A call connects and nobody can hear anything. | One 5-tuple, one mapping; a relay path that exists before the call does. |
| NAT traversal is a setting you must reconcile across six knobs. | Always on, zero config, and it cannot be silently off. |
| Opening a call means opening 10,000 UDP ports. | **One** port, signalling and media together. |
| Negotiation is SDP text, re-offers, `UPDATE` and `PRACK`. | Typed capability sets, one round trip, caller's order wins. |
| "Is the audio going where I think?" is unanswerable. | Every path decision is an event you can print, assert, or ship to a log. |

The evidence for those claims is a measured review of Asterisk 22.11.0, not an
impression: [analysis/asterisk-22-findings.md](analysis/asterisk-22-findings.md).

## What this repository is

A **standard** and a **working implementation of it**, in that order.

- [spec/CANTUS-1.0.md](spec/CANTUS-1.0.md) — normative wire format, handshake,
  capability negotiation, call state machine, traversal (Reach), media framing,
  identity, routing language, reason codes, conformance suite, and a SIP feature map.
- [lib/Cantus](lib/Cantus) — the reference stack: ~2,500 lines of Perl 5, core
  modules only. It places real calls over real UDP sockets.
- [bin/cantus](bin/cantus) — `demo`, `selftest`, `encode`, `route-test`.
- [t/](t) — 167 assertions across nine files, including calls behind a real NAT
  middlebox whose mapping table is flushed mid-call.

Nothing here wraps an existing voice stack, and no part of the wire protocol is
delegated to one.

## Quick start

Perl 5.16+ with core modules only. No CPAN, no build step, no services.

```bash
make setup                                        # install the attribution guard hooks
make test                                         # 167 assertions, nine files

perl -Ilib bin/cantus demo                        # one call, one socket, direct path
perl -Ilib bin/cantus demo --nat symmetric        # both ends behind hard NAT, relay path
perl -Ilib bin/cantus demo --nat cone --rebind    # NAT table flushed mid-call: failover + recovery
perl -Ilib bin/cantus selftest
perl -Ilib bin/cantus encode hello                # the actual bytes, hexdumped
perl -Ilib bin/cantus route-test examples/routes.json --to support@example.net
```

## The problem, measured

All counts taken from the shipped `asterisk-22.11.0` release tarball:

| | Asterisk 22.11.0 | Cantus 1.0 |
|---|---|---|
| Ports per call | signalling + 10,000–20,000/udp | **1** |
| Traversal | opt-in ICE, 6 interacting knobs, `ice_support=no` by default | **always on, zero config** |
| If traversal fails | call connects, audio is silent | **relay path, audio flows** |
| Negotiation | SDP text, ~2,580 lines of glue, re-offers/UPDATE/PRACK | typed set, 1 round trip |
| Cause of "one-way audio" | address views disagree, nothing signals it | cannot occur: one 5-tuple, one mapping |
| Config files | 101 sample `.conf` files | 1 routing document |
| SIP stack size | 55,858 lines (`res_pjsip*` + `chan_pjsip`) | 2,494 lines, no deps |
| Identity | `From` header + optional digest/TLS | key-bound, per-message signature |

`ice_support=no` is the documented default at
`configs/samples/pjsip.conf.sample:692`. Getting traversal right by hand means
reconciling `direct_media`, `rtp_symmetric`, `force_rport`, `rewrite_contact`,
`ice_support` and a statically typed `external_media_address` — that is the tax
Cantus removes.

## Traversal is the feature, not a setting

`--nat symmetric` puts **both endpoints behind a real UDP middlebox**
([lib/Cantus/NatSim.pm](lib/Cantus/NatSim.pm)) that allocates a distinct public
port per destination. Packets genuinely traverse it and the endpoints are
unmodified, so what the demo prints is what the protocol did:

```
path          relay  (direct was not usable, relay carried it)
audio         16-19 frames received, peak amplitude 6000
direct/relay  0 / 16-19 frames
ended         clean
nat           alice: 3 dropped unsolicited, 64 forwarded
```

The drops are the direct probes: the candidate address learned through the relay
is unreachable behind symmetric NAT, exactly as the standard predicts. With
`--nat cone` the same code commits **direct** in 15–33 ms, so the fallback is not
simply always taken.

## Mid-call rebinding: fail over, then come back

[t/12-rebind.t](t/12-rebind.t) flushes the NAT's UDP table mid-call — every
mapping destroyed, new public ports allocated — and
[t/13-rebind-one.t](t/13-rebind-one.t) does it to one endpoint at a time, in both
directions.

```
0.12s  direct committed
0.63s  NAT rebound (every mapping gone, new ports)
1.18s  break detected after ~560 ms of silence -> path=relay, re-REGISTER
1.21s  path=direct restored on both sides
       ~0.55 s of silence end to end, previously 2.1-2.6 s
       call never ended
```

Detection is sub-second and the tests assert it: a `rebind` event that only fired
on the 2000 ms safety net fails `detect_ms < 1000`. The mechanisms — re-register
before anything else, candidate refresh on every retry wave, path-scoped replies,
liveness measured on *direct* media only, the far side punching the hole when only
one endpoint moves, and `recv_high` in `FEEDBACK` — are normative in
[spec §8.7](spec/CANTUS-1.0.md).

## The standard in one page

1. **One socket for everything.** Signalling, media, probing and registration
   share one 5-tuple, so one NAT mapping serves the whole call.
2. **The relay mapping is opened at startup, not at call time.** Registration uses
   the media socket, so the fallback already exists before anyone dials.
3. **No silence.** If a direct path is not confirmed within 300 ms, media starts on
   the relay. The call does not fail; it takes one hop.
4. **No SDP.** Capability sets are ordered data; one round trip, caller's order wins.
5. **A real call object.** Five states, fixed timers, idempotent `TERMINATE`, no
   `ACK` because nothing needs a third leg.
6. **Routing is a checked document**, evaluable offline and validated at load.
7. **Identity is a key**, not a header field.

## Verification

```
t/00-wire.t          37 assertions   framing, unknown fields, signature input, MTU
t/01-caps.t          11 assertions   caller precedence, clock/channel match, no-match
t/02-session.t       25 assertions   every transition, idempotency, replay window
t/03-router.t        12 assertions   first match, globs, time windows, validation
t/10-e2e.t           10 assertions   complete call, direct path, real audio
t/11-nat.t           11 assertions   symmetric -> relay, cone -> direct, media verified
t/12-rebind.t        14 assertions   both mappings lost -> relay -> direct, sub-second
t/13-rebind-one.t    30 assertions   one-sided rebinding (caller, callee) + symmetric
t/14-feedback.t      17 assertions   report format, peer-stall trigger, timer net
```

All 167 pass. The suite asserts behaviour, not logs: audio is verified by peak
amplitude of the received PCM, `ACTIVE` is read from the state machine, and
"the NAT dropped the probes" is a counter inside the middlebox.

## Documentation

| Doc | What it covers |
|---|---|
| [spec/CANTUS-1.0.md](spec/CANTUS-1.0.md) | The normative standard: everything that must be true of an implementation |
| [docs/stack.md](docs/stack.md) | Cantus's role in the Innotel Platform Stack (Voice) |
| [analysis/asterisk-22-findings.md](analysis/asterisk-22-findings.md) | The measured review of Asterisk 22.11.0 that drove the design |
| [examples/routes.json](examples/routes.json) | A routing document, with the offline evaluator |
| [web/landing](web/landing) | The static landing page published to GitHub Pages |

## Repo layout

```
cantus/
├── spec/                  # the normative standard
├── lib/Cantus/            # reference implementation (Perl 5, core only)
├── bin/cantus             # CLI: demo, selftest, encode, route-test
├── t/                     # 167 assertions, real sockets
├── examples/              # routing documents
├── analysis/              # measured findings from the Asterisk tarball
├── docs/                  # stack role, architecture notes
├── web/landing/           # static GitHub Pages landing page
├── .github/workflows/     # CI, attribution guard, conformity, Pages
├── .githooks/             # attribution guard (commit-msg, pre-commit, guard-lib)
├── Makefile               # operator workflow
└── .env.example           # environment template (nothing required to run)
```

## Status and known limits

Deliberate, and stated so nobody mistakes a reference stack for a deployment:

- **Codec.** The normative codec is Opus; the reference ships `pcm-s16/8000/1` (a
  sine tone) so the stack runs with zero dependencies and media arrival can be
  verified by amplitude. There is no Opus encoder here.
- **Cryptography.** The normative profile is Ed25519 over a TLS 1.3 or DTLS 1.3
  binding. The reference uses the loopback-only `sig-hmac-sha256` profile with a
  shared secret, and there is no transport encryption in the reference.
- **`FEEDBACK`** carries real received bitrate, sequence-gap loss and `recv_high`.
  RTT and jitter are still zero, and `desired_kbps` is fixed rather than driven by
  a congestion controller.
- **No T.38, no in-band DTMF, no dialplan** — by design.
- **Bind default** is `127.0.0.1:0`; pass `bind => '0.0.0.0:7443'` for a real node.
- **The Asterisk tarball is not committed** (26 MB, reproducibly downloadable);
  its SHA-256 is in the findings doc.

## What was found while building it

The spec and the implementation disagreeing was the useful part. Each of these was
a real defect caught by the tests, and the spec now states the fixed behaviour:
missing call demux in media framing, a test codec that broke the 1150-octet MTU
rule, codec matching that ignored channels, a spoofable relay handle refresh,
relay-sourced offers answered to an address the relay ignored, a `PATH_ACK`
deadlock on the return to direct, a `recv_kbps` that was a constant, and relay
liveness that counted relayed media as proof about a direct path. The list with
detail is in the findings doc and in `git log`.

## Who builds this

**Darnel Hunter** ([@innotelinc](https://github.com/innotelinc)) builds operator tooling for
people who have to answer "what is this thing actually doing?" and then prove it: the
[WARDEN](https://github.com/innotelinc/warden) operations browser, and the
[Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack) the
projects sit on. Cantus is the same argument pointed at voice: a protocol small enough
to read, with its traversal behaviour stated rather than configured, and every claim in
it measured by a test that drives real sockets.

Work here keeps one rule: nothing is credited except the person who wrote it. The
repository enforces that in `.githooks` and again in CI, not by convention.

## License

Cantus is licensed under the **GNU Affero General Public License v3.0** — see
[LICENSE](LICENSE). The normative text in [spec/](spec) is covered by the same
licence. Nothing here re-licenses upstream material: the Asterisk tarball is
external evidence, fetched on demand and never redistributed.

*Cantus 1.0 — © 2026 Darnel Hunter.*

## 🏛️ Platform stack

Cantus is the ecosystem's **Voice** platform in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture where Authentik owns identity,
Cerulean Vault owns secrets, Cerulean owns trust, ONYX owns storage, Magnate owns
revenue, NPM Edge owns the edge, and every other platform is a business function
that consumes them. See [docs/stack.md](docs/stack.md) for this platform's
owns/consumes boundaries.
