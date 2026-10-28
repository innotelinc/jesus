# What Asterisk 22.11.0 actually costs you

Source artifact: `asterisk-22-current.tar.gz`
SHA-256 `3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94`
Unpacked release: `asterisk-22.11.0` (2,207 files, per `ChangeLogs/ChangeLog-22.11.0.md`).

Re-extract the survey tree with:

```bash
tar -xzf vendor/asterisk-22-current.tar.gz -C vendor/
```

This is a source-repository survey of the shipped release artifact, using normal
repository tools. No REA analysis server was required or registered for it: the
questions here are architectural (what does the design force on an operator),
not questions that need decompilation of a binary.

Every number below was measured in the extracted tree, not estimated.

## 1. Measured shape

| Measure | Value | Command basis |
|---|---|---|
| C source in `main channels res codecs apps funcs pbx` | **724,178 lines** | `find ... -name '*.c' \| xargs wc -l` |
| Sample configuration files shipped | **101** `*.conf.sample` | `ls configs/samples/*.conf.sample \| wc -l` |
| `pjsip.conf.sample` | **1,761 lines, 944 of them comments** | `grep -c '^;'` |
| `extensions.conf.sample` (dialplan) | 880 lines | `wc -l` |
| Composable applications / dialplan functions | **85 apps, 59 funcs** | `ls apps/*.c`, `ls funcs/*.c` |
| `res_pjsip*` + `chan_pjsip` implementation | **55,858 lines** | `cat ... \| wc -l` |
| `channels/chan_iax2.c` (second, parallel stack) | 497,005 bytes | file size |
| `main/rtp_engine.c` (generic media) | 4,366 lines | `wc -l` |
| `res/res_rtp_asterisk.c` (UDP media + ICE + TURN) | 367,122 bytes; 233 `ice_*` refs, 70 `turn_*` refs | `grep -c` |
| Registration code alone | 4,629 lines (`res_pjsip_registrar.c` + `res_pjsip_outbound_registration.c`) | `wc -l` |
| T.38 fax + UDPTL | 2,637 lines (`res_pjsip_t38.c` + `main/udptl.c`) | `wc -l` |
| `res_pjsip_session.c` (SIP dialog engine) | 6,255 lines; 15 `UPDATE`, 10 `re-INVITE`, 3 `100rel` refs | `wc -l`, `grep -c` |

## 2. Finding: NAT traversal is opt-in, per-endpoint, and manual

This is the headline problem, so it gets the direct evidence.

`configs/samples/pjsip.conf.sample` line 692:

```
;ice_support=no ; Enable the ICE mechanism to help traverse NAT (default: "no")
```

ICE — the only real traversal mechanism in the stack — **defaults to off**. Enabling
it is not one switch; the operator is expected to understand and set a cluster of
independent, interacting booleans. From the same sample file:

- lines 278–280: `force_rport=yes`, `direct_media=no`, `ice_support=yes`
- lines 398–399, 416–420: a documented recipe — `direct_media`, `rtp_symmetric`,
  `force_rport`, `rewrite_contact` (commented "necessary if endpoint does not
  know/register public ip:port"), `ice_support` ("specific to clients that
  support NAT traversal")
- line 140: `external_media_address=203.0.113.1` — a *statically typed public IP*,
  which is wrong the moment the host moves or the IP is dynamic
- line 664: `direct_media_glare_mitigation=none`; line 682:
  `disable_direct_media_on_nat=no` — NAT behaviour is entangled with re-INVITE
  glare mitigation, i.e. the traversal story and the dialog-refresh story are
  the same mechanism, and both are manual
- line 724: `rewrite_contact` — the server rewrites the client's address because
  the client does not know its own public address

`res/res_stun_monitor.c` exists, but it only *monitors* whether the external
address changed; it does not traverse.

Media also spans **20,001 UDP ports by default** (`configs/samples/rtp.conf.sample`:
`rtpstart=10000`, `rtpend=20000`; the file notes the built-in defaults are
5,000–31,000). Every port is another mapping the NAT or firewall must create and
keep open, and the mapping is *not* the one the signaling connection already
established.

Consequence: the operator must get all of these right, per endpoint, and if any
one is wrong the call still "succeeds" — signaling completes, then audio is
silent. Silence is the classic failure signature precisely because the failure is
not signalled. That is the "killer" behaviour, and it is structural, not a bug:
the design separates the address used for signaling, the address used for media,
and the address the peer learns, and then asks a human to reconcile three views
of the same Network Address Translation.

Two independent stacks make this worse: `chan_pjsip` (55,858 lines) and
`chan_iax2` (a 497 KB file) each carry their own registration, qualification and
NAT story. IAX2's answer to liveness is a "poke"/qualify timer
(`chan_iax2.c:657-662`, `iax2_poke_peer`), 95 NAT-related references in one file.
Fixing traversal means fixing it twice, in two dialects, with two config files.

## 3. Finding: negotiation is textual, stateful and multi-round-trip

SDP is neither parsed nor produced in one place: `main/sdp_srtp.c` is only 137
lines, while `res/res_pjsip_sdp_rtp.c` is 2,580 lines and further depends on
pjproject. Media description therefore depends on a third-party SDP engine plus
glue, and the resulting semantics (m-lines, attributes, payload-type numbers,
re-offers) are a document grammar rather than a data structure.

The dialog engine that has to sequence all of this — `res_pjsip_session.c` —
contains 15 `UPDATE`, 10 re-INVITE and 3 `100rel` references: provisional
acknowledgement, target refresh, session timers and glare resolution all mutate
the same dialog. Each is a state machine layered on a state machine, and every
one of them is an opportunity for a race that manifests as one-way audio.

## 4. Finding: the call model does not exist as a first-class object

A call in Asterisk is a *channel*, and a channel is a bag of formats, a PBX
thread, a bridge member and a technology-private struct. The 85 applications and
59 functions are the real API surface, and the dialplan (`extensions.conf`, 880
sample lines) is a line-oriented language evaluated at runtime. There is no
schema, so there is no static checking and no offline test of routing behaviour;
`config_test.conf.sample` exists, which is evidence that config correctness
became its own sub-project.

## 5. Finding: security is a configuration decision, not a protocol property

`media_encryption` (SRTP/DTLS) is per-endpoint configuration. Identity in SIP is
a `From` header the sender chooses, so it is unauthenticated by construction and
must be bolted back on with digest credentials, TLS and mutual auth — all
optional, all per-endpoint. T.38 fax (2,637 lines) and RFC 4733 telephone-events
remain first-class because the model cannot express "a typed event" any other way.

## 6. Requirements this imposes on a replacement

Derived directly from the above, in priority order. NAT is first because the
measured evidence says it is the failure mode that costs the most operator time.

1. **Traversal must be the default path, not a feature.** One socket, one
   mapping, always-open fallback, and a call that cannot end in silence.
2. **One port for everything.** Signaling, media, probing and presence share a
   single 5-tuple, so a single NAT mapping serves the whole session.
3. **A guaranteed relay path**, pre-opened before the call exists, so traversal
   failure degrades to extra latency instead of no audio.
4. **Negotiation as data, one round trip.** A typed capability set, not a text
   grammar; no re-offer, no UPDATE/PRACK.
5. **A call object with a normative state machine** and idempotent teardown.
6. **Routing as a schema-checked document** that can be evaluated offline.
7. **Identity bound to a key**, verified in the protocol, not inferred from a
   header.
8. **1150-byte datagrams**, no IP fragmentation, bounded everything.

## 7. What is deliberately not carried over

T.38 fax, RFC 4733 in-band events (replaced by a typed event), SDP, the dialplan
language, separate registrar and presence servers, port ranges, and the notion of
a "technology" (chan_*) plugin. These are all measurable costs above and none of
them is required to place a voice call with clean audio.
