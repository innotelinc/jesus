# Telephony on Cantus

This platform used to carry a telephone switch inside its own image. It does not
any more: Asterisk is gone from the build, from the container and from the
control plane. What replaced it is **Cantus 1.0** — the voice standard in
[`apps/cantus`](../../cantus) — implemented as a service in
[`apps/cantus-switch`](../../cantus-switch).

This document is the contract between the two.

## What each side owns

| | Cantus switch | Telno |
|---|---|---|
| Calls | owns them: state machine, media, recordings, path decisions | never sees a datagram |
| Dial plan | loads the routing document it is given | **owns** it: generated from the database |
| Lines | registers every address it answers for | **owns** the inventory: extensions, numbers, trunks |
| CDRs | emits them | stores them, bills them, shows them |
| Console | none | the whole UI |
| Credentials | `CANTUS_SECRET` (node signing), `CANTUS_CONTROL_TOKEN` (API) | same token, same domain |

There is one source of truth (the database) and one derived artefact (the
routing document). Neither side can drift into a second configuration surface,
which is what the old `.conf` tree and its "Apply" step did.

## The three files

```
/data/cantus/routes.json    the dial plan             written here, loaded there
/data/cantus/lines.json     the inventory             written here, served there
/data/recordings/*.wav      call audio                written there, played here
```

`routes.json` is validated before it is written and again when it is loaded. The
same schema is validated by two implementations — `apps/cantus/lib/Cantus/Router.pm`
and `apps/cantus-switch/src/router.js` — so a document that one accepts and the
other rejects is a bug in one of them, not a matter of taste:

```bash
perl -Iapps/cantus/lib apps/cantus/bin/cantus route-test /data/cantus/routes.json --to 101@telno.local
node apps/cantus-switch/src/cli.js route-test /data/cantus/routes.json --to 101@telno.local
```

Both print the same route and the same ordered action list.

## What a call does

1. A caller INVITEs `101@telno.local`. The relay resolves the name to the
   switch's socket; the switch has registered that address because this platform
   told it the line exists.
2. The switch evaluates the routing document with `{to, from, calls}`. The first
   matching route wins. For a line the actions are `bridge → 101`, then the
   greeting, a recording and a normal release.
3. `bridge` rings every endpoint currently holding line 101: the browser socket,
   a Cantus desk phone, and an ARI subscriber if the route names an agent. The
   first to answer wins; the rest are released.
4. Reach probes the direct path while the relay carries the call. Under 300 ms a
   direct path commits; otherwise the relay keeps it. A rebinding mid-call is
   detected in under a second and the call moves rather than ends.
5. The switch emits `call.*` events and a CDR. This platform writes the same
   `calls` row the console, the billing ladder and the audit log already read.

Nothing in that list is an SDP negotiation, and no step can produce a connected
call with no audio: a path is committed before media starts.

## Digit presses

An IVR is a route with an `event` predicate. The switch re-evaluates the
document with `event: "<digit>"` when a key arrives and only considers routes
that name an `event` — so pressing 1 cannot re-run the route that answered the
call. A menu that nobody answers raises `event: "timeout"` after the `play`
action's own timeout.

## Configure it

| Variable | Side | Meaning |
|---|---|---|
| `CANTUS_URL` | telno | control API, e.g. `http://cantus:8088` |
| `CANTUS_CONTROL_TOKEN` | both | shared bearer token; the switch refuses without it |
| `CANTUS_DOMAIN` | both | the dialling domain: `101@telno.local` |
| `CANTUS_SECRET` | switch | signing secret for Cantus messages |
| `CANTUS_CONFIG_DIR` | telno | where `routes.json` is written (`/data/cantus`) |
| `CANTUS_ROUTES_FILE` | switch | the same file, read at boot |
| `CANTUS_LINES_URL` | switch | `http://telno:8080/api/cantus/lines` |
| `CANTUS_RECORD_DIR` | both | shared recordings directory |
| `SOFTPHONE_SOCKET_URL` | telno | browser socket path (default `/softphone/line`) |

`CANTUS_LINES_URL` is polled every 30 seconds, so a new extension is dialable
without restarting either service. `applyAfterChange()` re-writes the document
and POSTs it to `/v1/routes` after every save; if the switch is down the file is
still written and the console reports "written, not applied".

## Telephony features and where they now live

| Feature | Status on Cantus |
|---|---|
| Extensions, DND, forwarding | routes (`reject: 1`, `forward`) |
| DID routing, fax detection | DID routes with the number's own action list |
| IVR menus | `play` + `event` routes |
| Voicemail greeting + message | `play` → `record`; audio lands in `/data/recordings` |
| Call recording (agent policy) | `record` action, SCIF lines excluded in the document |
| Parallel ring (desk + browser) | `bridge` to the line's own endpoints |
| Softphone | one WebSocket, `web/src/cantus.js` |
| Hold | `hold`/`unhold` on the line socket; the waiting party hears switch-generated music, the holder hears silence, and resuming keeps the same call |
| Trunks | a Cantus endpoint on the carrier gateway (`<trunk>@<host>`) |
| ARI agents (dograh/capstone) | the switch's ARI-compatible surface on `:8088` |
| Fax (T.38) | **not terminated here**: Cantus has no T.38. Sending needs `FAX_GATEWAY`, and is refused with that reason when it is absent |
| Parking lot | **not implemented on the switch**. `PARKING_ENABLED` defaults to false and `7XXX` is reserved for retrieval |
| Video / screen share | **not carried**: a Cantus line is 8 kHz audio on one socket |
| Client-side voice mask | **not wired** into the new media graph; SCIF caller-ID withholding and no-recording are still enforced |

The last four are deliberate gaps with the reason stated, not buttons that fail
silently. Each is a candidate for the next change, and each is the kind of thing
the switch's own conformance suite can be extended to cover.

## Why the port list shrank

| | before | now |
|---|---|---|
| Browser signalling | 8089/tcp (TLS) | 8080/tcp, same origin as the console |
| Media | 10000–10100/udp | the signalling socket |
| Control | 5038/tcp (AMI) | HTTP on the private network |
| Relay / NAT | TURN + STUN | one UDP relay, optional |

Two UDP ports and one TCP port for the whole switch, and a firewall rule that is
a rule and not a range.
