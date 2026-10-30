# Cantus in the estate

**What "compatible with Cantus" means for each system that touches a call.**

Cantus is one wire protocol and one socket, but a deployment is several programs:
a switch, a platform, an agent runtime, a console, a SIP border. This document
is the contract between them. It is written against the code in this monorepo,
so every interface below exists and is exercised by a test; where something is
not built yet, it says so.

The normative wire format is [`spec/CANTUS-1.0.md`](../spec/CANTUS-1.0.md). SIP
is confined to [`spec/CANTUS-SIP-BORDER.md`](../spec/CANTUS-SIP-BORDER.md) and
never becomes an interior protocol.

---

## 1. The pieces

| Component | Repository path | Role |
|---|---|---|
| **Cantus** | [`apps/cantus`](..) | The standard and a Perl reference stack that proves it |
| **cantus-switch** | [`apps/cantus-switch`](../../cantus-switch) | The deployable node: lines, trunks, calls, routing, control API, ARI surface, browser softphone |
| **cantus-gateway** | [`apps/cantus-gateway`](../../cantus-gateway) | The SIP border: one Cantus endpoint, one carrier |
| **telno** | [`apps/telno`](../../telno) | The platform: accounts, numbers, inventory, routing document, CDRs, recordings, console |
| **capstone** | [`apps/capstone`](../../capstone) | AgentOps: agent definitions, dashboards, dograh supervision |
| **dograh** | [`apps/dograh`](../../dograh) | The voice-agent runtime: STT/LLM/TTS pipeline over ARI |
| **zeus** | `innotelinc/zeus` *(separate repository, not in this tree)* | VoiceOps: customer numbers, trunks, portal, voicemail, billing |
| **warden** | `innotelinc/warden` *(separate repo)* | The operations browser: what is this switch doing, right now |
| **jesus** | this repository | The monorepo that carries all of the above and the estate compose |

### 1.1 Compatibility profiles

A system is compatible by implementing one or more of these, and nothing else:

| Profile | Transport | Who implements it |
|---|---|---|
| `cantus-node` | Cantus UDP on 7443 (one socket) | switch, gateway, any endpoint |
| `cantus-control` | HTTP `/v1/*` + `WS /ws/events` | switch (server); telno, capstone, zeus, console (clients) |
| `cantus-ari` | HTTP `/ari/*` + `WS /ari/events` | switch (server); dograh, capstone (clients) |
| `cantus-line` | `WS /ws/line` — JSON control + 20 ms PCM16 | switch (server); telno's browser softphone |
| `cantus-ops` | read-only `GET /v1/status`, `/v1/calls`, `/v1/events`, `/v1/lines`, `/healthz` | switch and gateway (servers); warden (client) |
| `cantus-border` | SIP/RTP to a carrier | gateway only |

The profiles are deliberately few. Adding a second way to ask a switch a
question is how a protocol becomes a platform.

---

## 2. jesus — the monorepo

**Compatibility is structural: the apps land here unchanged and CI runs them.**

- Each product is a directory under `apps/`, with its own tests, container and
  release history. The switch, gateway and platform are separate processes, not
  modules of one program.
- Root workflows are **generated** from `apps/*/.github/workflows` by
  [`tools/port-workflows.pl`](../../../tools/port-workflows.pl) and checked for
  drift in CI. A product's tests run in the monorepo exactly as they run in its
  own repository; there is no second CI definition to maintain.
- [`estate/docker-compose.yml`](../../../estate/docker-compose.yml) is the
  reference topology: `switch`, `gateway`, `telno`, `console`, one data volume
  each. `estate/up.sh` brings it up and waits for the switch.
- The pre-commit guard (attribution policy) is shared; nothing in a call path
  depends on it.

A product is "in the estate" when it can be started from `estate/` against the
switch without a configuration file the switch does not read.

---

## 3. telno — the platform

**Owns the inventory and the dialplan; never sees a datagram.**

| Telno owns | Switch owns |
|---|---|
| accounts, numbers, extensions, trunks | calls, media, path decisions, recordings |
| the routing document (generated, validated) | evaluation of that document at call time |
| CDR storage, billing, the console | emission of `call.*` events and CDRs |
| line inventory (`lines.json`) | registration and health of those lines |

Interfaces, all currently in use:

| Direction | Interface | Notes |
|---|---|---|
| telno → switch | `POST /v1/routes` (the whole document, validated) | 422 with errors if invalid; the doc is also written to disk so a switch restart loads it |
| telno → switch | `POST /v1/lines` per extension | idempotent; a line is a dialable address, not a SIP account |
| switch → telno | `GET CANTUS_LINES_URL` every 30 s | telno serves `/api/cantus/lines`; a new extension is dialable without a restart |
| switch → telno | `WS /ws/events` + `GET /v1/events?limit=` | `call.*`, `cdr`, `node`, `relay` |
| browser ↔ switch | `WS /ws/line` | JSON control, 20 ms PCM16 frames; telno's softphone is a client of this |
| telno → switch | `POST /v1/calls`, `DELETE /v1/calls/:id`, `POST /v1/calls/:id/{answer,dtmf,record}` | originate, hang up, control |

Both implementations validate the routing document — `lib/Cantus/Router.pm`
and `cantus-switch/src/router.js` — and a document one accepts and the other
rejects is a bug, not a matter of taste. `route-test` exists on both sides so
the disagreement is testable offline.

**What telno must not do:** hold a SIP socket, keep a second dialplan, write a
recording path the switch did not produce, or rename a call cause. The switch's
`cause` strings are part of this contract (§6).

---

## 4. capstone — AgentOps

**Consumes the switch, owns the agents.**

Capstone's switch-side half lives in [`apps/capstone/pbx/`](../../capstone/pbx):

| Tool | Interface | Purpose |
|---|---|---|
| `bootstrap_cantus.py` | `POST /v1/routes`, `POST /v1/lines`, `GET /v1/status` | apply capstone's routing document and line inventory, idempotently; exits 1 naming an ARI app that no client has registered |
| `sync_agent_numbers.py` | `POST /v1/lines`, `POST /v1/routes` | make every number dograh advertises dialable, preserving hand-written routes |
| `routes.json`, `lines.json` | files, validated before apply | the same schema telno writes; one source of truth per deployment |

The route that hands a call to an agent is:

```json
{ "when": { "to": "8001@capstone.local" },
  "then": [ { "answer": {} }, { "ari": { "app": "dograh" } } ] }
```

`ari` is terminal: the application owns answer, playback, recording and bridging
from that point. An application with no connected client ends the call with
cause `app-unavailable` rather than parking it until the network gives up.

Capstone no longer needs FreePBX, MySQL rows, `docker exec`, or a second PBX
container. Its `standalone` compose profile remains for offline development, and
in that mode it runs the same switch image this repository builds.

---

## 5. dograh — the agent runtime

**Unchanged dialect. That is the point.**

Dograh was written against Asterisk's ARI. The switch implements an
ARI-compatible surface so an agent runtime does not have to be rewritten:

| ARI resource | Implemented | Notes |
|---|---|---|
| `channels` | list, get, create, delete, answer, hangup, play, dtmf, `POST channels/externalMedia` | chan_websocket's protocol: `external_host` is a connection name, `MEDIA_START` declares the format, and audio crosses as ulaw/slin/slin16 binary frames. `transport_data` becomes query parameters, so the ids an agent routes a call by survive |
| `bridges` | create, list, get, delete, addChannel, removeChannel | the bridge decides who hears whom; two channels is a true pair, more than two is not a mixer yet and says so |
| `applications` | list, get, subscribe | `/ari/events?app=…` |
| `endpoints` | list | shows Cantus peers, not SIP endpoints |
| `asterisk/info` | yes | enough for a client that probes versions |
| snoop, channel variables, persistent recordings, arbitrary sound names | **not implemented, 501** | refused rather than approximated |

Configuration that moves:

| Before | Now |
|---|---|
| `DOGRAH_ARI_HOST=freepbx` | the switch host |
| `DOGRAH_ARI_PORT=8088` | the switch's HTTP port (8088 inside the estate) |
| `DOGRAH_ARI_USER/PASSWORD` | `CANTUS_ARI_USER` / `CANTUS_ARI_PASSWORD` on the switch |
| ARI app name | `CANTUS_ARI_APP` (default `dograh`) |
| external-media WS | unchanged in shape; the switch dials the agent's WS |

Authentication is HTTP Basic on every `/ari` path and on `/ari/events`. There is
no second credential store: the switch holds one user per app.

---

## 6. zeus — VoiceOps

**The contract a VoiceOps deployment must meet; where the current repo still
describes FreePBX, this section is the target.**

Zeus owns the customer-facing telephony: numbers, trunks, the portal, voicemail,
SMS/fax, billing. Under Cantus it does so through the control API, not through a
PBX database.

| Zeus concern | Cantus interface | What replaces |
|---|---|---|
| Number inventory | `POST /v1/lines`, `POST /v1/routes` | FreePBX inbound routes and extensions |
| Trunk + caller ID | `POST /v1/trunks` (name, host, fromUser, username, secret) | `pjsip` trunk rows |
| Portal call control | `POST /v1/calls`, `POST /v1/calls/:id/{answer,dtmf,record}`, `DELETE` | AMI originate / ARI |
| Call history | `WS /ws/events` → `cdr`; `GET /v1/calls` | CDR database written by Asterisk |
| Voicemail | `play` → `record` routes; recordings under `CANTUS_RECORD_DIR` | `VoiceMail()` and the mailbox store |
| Softphone | `WS /ws/line` | SIP.js over WSS |
| AI hand-off | `{ "ari": { "app": … } }` in a route | `Stasis()` |

Rules that keep one voice plane instead of two:

1. **Zeus does not run a second switch.** One switch owns the calls; Zeus is a
   client of its control API, like telno.
2. **A trunk is a Cantus endpoint on the gateway**, e.g. `voipms@gateway`. Zeus
   creates the trunk record; the gateway authenticates to the carrier. Zeus
   never handles a SIP credential for a live call.
3. **Customer extensions are lines**, not SIP accounts. A line has an
   extension, a display name, numbers and zero or more live endpoints.
4. **The portal does not write a dialplan.** It writes a routing document,
   validated on both sides.
5. **SIP exists only at the border.** A Zeus deployment that still has a SIP
   registrar, an RTP range, AMI or a FreePBX database is mid-migration; the
   target removes all four.

What is *not* yet ported, stated plainly: capstone's `dashboard-backend` still
provisions extensions by running `fwconsole` and MySQL in `addon` mode, and
`capstone/docs/zeus-integration.md` still describes the FreePBX topology. The
switch-side replacement already exists (`POST /v1/lines` plus a route merge) and
is what `sync_agent_numbers.py` uses; the dashboard is the remaining client.

---

## 7. warden — the operations browser

**Read-only by construction. A console that can hang up a call is a console that
can hang up the wrong one.**

Warden answers "what is this switch doing right now?" from surfaces that already
exist:

| Question | Surface |
|---|---|
| Is the node alive, registered, relayed? | `GET /v1/status` |
| What calls are up, on which legs, with what counters? | `GET /v1/calls` |
| What just happened? | `WS /ws/events` (`call.*`, `cdr`, `node`, `relay`) |
| What happened while I was not watching? | `GET /v1/events?limit=500` |
| Which lines are online, and why did one drop? | `GET /v1/lines` → `registered`, `online`, `lastChange.reason` |
| Is the carrier reachable? | gateway `GET /healthz`, `/status` |
| Is the carrier encrypted? | gateway `GET /srtp` |

Rules:

- **No write path.** Warden may not `POST`/`DELETE` anything on the switch. The
  estate console already follows this shape and is the reference client.
- **Path decisions are events, not inferences.** `call.path` carries the chosen
  path and whether it changed; Warden must not derive "is it relayed?" from
  packet counts.
- **A line's absence has a reason.** `lastChange` is part of the contract
  precisely so a console can say "the phone stopped answering health checks"
  instead of showing a grey dot.
- **No credentials beyond a read token.** `CANTUS_CONTROL_TOKEN` is a bearer
  token; a deployment that gives Warden one gives it a token scoped to a
  reverse proxy that only forwards the read paths.

The console in [`estate/console`](../../../estate/console) is small enough to
read as the reference implementation of this profile.

---

## 8. Shared contracts

### 8.1 Identity and secrets

| Name | Who holds it | Purpose |
|---|---|---|
| `CANTUS_SECRET` | every node in one deployment | `sig-hmac-sha256` signing profile (loopback/test; see security doc) |
| `CANTUS_CONTROL_TOKEN` | switch + every writer client | bearer token on `/v1/*` and `/ws/line` |
| `CANTUS_ARI_USER` / `CANTUS_ARI_PASSWORD` | switch + dograh | HTTP Basic on `/ari/*` |
| `SIP_USERNAME` / `SIP_PASSWORD` | gateway only | carrier trunk digest |
| `SRTP_STATE_FILE` | gateway | remembers the encryption choice across restarts |

Node identities are `name@domain`: `switch@telno.local`, `voipms@gateway`,
`101@telno.local`. A node's `EndpointId` is not a login and carries no
credential; the key (or, in the reference profile, the shared secret) is separate.

### 8.2 Events

| Event | Emitted when | Carries |
|---|---|---|
| `call.incoming` | an INVITE addressed to a line arrives | from, to, route |
| `call.routed` | the document picked a rule | route name, actions |
| `call.ringing`, `call.answered` | leg state changes | leg id, ext |
| `call.dtmf` | a digit arrived (Cantus, ARI or API) | digit, leg |
| `call.path` | Reach committed or changed path | `direct` or `relay` |
| `call.recording`, `call.recorded` | recording started / finished | file |
| `call.ended`, `call.unanswered`, `call.failed` | terminal state | cause, duration |
| `cdr` | a call is billed | from, to, duration, billsec, cause, route |
| `node`, `relay`, `routes.applied` | switch-level state | registered, error, count |

A cause string is stable and is the only thing a client should branch on:
`normal`, `busy`, `no-answer`, `rejected`, `timeout`, `cancelled`,
`app-unavailable`, `path-failed`, `transport-error`, `not-found`.

### 8.3 Ports

| Port | Protocol | What |
|---|---|---|
| 7443 | UDP | Cantus: signalling, media, probes, registration |
| 7444 | UDP | relay |
| 8088 | TCP | control API, ARI, event socket, browser line |
| 7454 | TCP | gateway status (`/healthz`, `/status`, `/srtp`) |
| 7453 | UDP | gateway's Cantus endpoint |
| 5060 | UDP | SIP, **gateway only** |
| 40000–40063 | UDP | carrier RTP, **gateway only** |

A firewall for a Cantus deployment is two UDP rules and one TCP rule, plus the
gateway's carrier ports where the gateway runs.

### 8.4 When SIP is used

Exactly three cases, all at a border:

1. A PSTN carrier: numbers, DIDs, inbound and outbound calls.
2. A carrier-side requirement (SRTP, a specific codec) — still one gateway.
3. A temporary carrier bridge while a number is migrated; the Cantus side is
   unchanged before, during and after.

SIP is **not** used for endpoints, agent media, softphones, trunking between
internal products, or call control. Two Cantus products in the same estate do
not need a trunk between them: they are nodes on the same relay.

A legacy SIP desk phone has no path into this design today. It needs a border
instance with a registrar, which the gateway deliberately is not; the supported
endpoints are a Cantus client, the browser line, or an ATA that terminates SIP
and presents audio some other way. Saying this is cheaper than a half-built
registrar.

---

## 9. Compatibility checklist

A deployment can claim these systems are compatible when:

- [ ] every call path is `cantus-node` — no SIP socket outside the gateway
- [ ] exactly one writer owns the routing document, and both implementations
      accept it (`route-test` on Perl and Node agree)
- [ ] telno's lines are the switch's lines (`GET /v1/lines` matches the
      inventory, `lastChange` explains every offline line)
- [ ] capstone's `bootstrap_cantus.py` exits 0 against a cold switch
- [ ] dograh connects to `/ari/events` and answers a call routed with `ari`
- [ ] zeus originates, answers, records and hangs up through `/v1/calls`
- [ ] warden reads status, calls, events and lines, and writes nothing
- [ ] the gateway's `/healthz` is 200 with a registered trunk, and 503 with a
      cause when it is not
- [ ] a PSTN keypress reaches an IVR route, and an IVR prompt's keypress reaches
      the caller (`dtmf.test.js` covers the border half)
- [ ] a refused call reaches the carrier as the right SIP status
      (`reason.test.js` covers the table)
