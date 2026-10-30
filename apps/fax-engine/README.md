# fax-engine

The fax machine the estate does not otherwise have.

Cantus carries voice only: no T.38, no in-band modem signalling, and no media
path that treats a modem tone as anything but audio. That is the right design for
a voice switch and it means a fax cannot be terminated *by the switch*. So this
container terminates it, a little outside the switch:

```
carrier ──SIP──▶ Asterisk ──IAX2──▶ iaxmodem ──tty──▶ HylaFAX ──▶ recvq/*.tif
 (fax DID)        (chan_iax2)        (spandsp)        (faxgetty)
```

Three pieces, and each one is doing the job you would expect:

| Piece | Role |
|---|---|
| `iaxmodem` ×2 | A modem in software. It speaks IAX2 to the Asterisk beside it and presents a tty that behaves like a Class 1 fax modem, because the modulation is spandsp inside this process. |
| `HylaFAX` | The fax application: `faxgetty` answers on each tty, `faxq` schedules, `sendfax` transmits, `recvq` holds what arrived. |
| `Asterisk` | Only a switchboard. Two local IAX2 peers, one SIP door for the carrier. `res_fax` is *not* used — there is no Asterisk fax machine here, only modems. |

Why not `res_fax` in the switch? Because the switch is Cantus, and `res_fax`
needs an Asterisk on the call path. This container *is* that Asterisk, and once it
exists the modem is a better answer than a DSP on a voice channel: iaxmodem does
the modulation itself, HylaFAX does the pages, and neither is a plugin that has
to agree with a switch that never had T.38 to begin with.

## Run it

```sh
docker build -t christ-fax apps/fax-engine
docker run --rm -p 8091:8080 -v fax-spool:/var/spool/hylafax christ-fax
curl -s localhost:8091/status | jq
```

In the estate it is a profile:

```sh
cd christ
node cli.js select fax                  # resolves to voice, platform, fax-engine
docker compose --profile fax up -d --build
```

## Verify it

The container ships its own carrier: one modem dials the other. This is a real
transmission — V.29/V.17 modem tones, T.30 handshake, a page in `recvq` — and it
needs no phone line, no carrier and no credentials.

```sh
docker compose --profile fax exec -T fax-engine sh /opt/fax/loopback.sh
# [self-test] received fax000000001.tif · 1 page(s) · 30s
# [self-test] PASS: a page went out of one modem and arrived at the other
```

Measured on a fresh volume: `1 page`, `14400 bit/s`, `2-D MMR`, 15 s of transfer,
30 s wall clock from `sendfax` to a readable page. `xferfaxlog` shows the pair:

```
… RECV  ttyIAX1  recvq/fax000000001.tif  ""  fax  "14132642700"  "Telno" …
… SEND  000000001  ttyIAX0  1  ""  root@…  "9999"  "Telno" …
```

If it fails, the script prints `faxstat -s` and the tail of `xferfaxlog` rather
than a bare non-zero exit — a fax that does not go through always has a reason.

## The HTTP door

Telno asks before it offers to send anything; a document queued into a dead
engine looks sent and never arrives.

`GET /status` (token via `x-fax-token` when `FAX_ENGINE_TOKEN` is set):

```json
{
  "engine": "iax+hylafax",
  "serving": true,
  "modem": { "device": "/dev/ttyIAX0", "peer": "iax0", "registered": true, "state": "OK (497 ms)" },
  "modems": [ … one entry per modem … ],
  "hylafax": { "ready": true, "faxq": true, "hfaxd": true, "version": "3:6.0.7-11.1" },
  "spool": { "recvq": 1, "sendq": 0, "doneq": 1 }
}
```

`registered` means the peer answered the switch's own IAX2 qualify. These peers
are static — their host and port are in `iax.conf` — so a registration is not
what makes them reachable, and a modern Asterisk refuses iaxmodem's old
registration attempt anyway. `OK` or `LAGGED` is the honest liveness signal;
`UNREACHABLE` means the tty exists with nothing behind it, which is exactly the
state that used to look healthy.

`POST /send` takes a TIFF as the body, the destination in `x-fax-to`, and hands
it to `sendfax`. It refuses anything that is not a TIFF, because a PDF queued as
a fax is a job that fails five minutes later instead of immediately.

## Configuration

| Variable | Meaning |
|---|---|
| `FAX_NUMBER` | The DID, used as Caller\*ID and printed in the page header. |
| `FAX_STATION_ID` | The station name on sent pages (`Telno`). |
| `FAX_SECRET` | What the two iaxmodems authenticate to the switchboard with. Local to the container pair. |
| `FAX_ENGINE_TOKEN` | Required header value for `/status` and `/send`. |
| `FAX_SIP_USERNAME`, `FAX_SIP_PASSWORD` | The fax's own carrier sub-account. Empty means loopback only. |
| `FAX_SIP_HOST`, `FAX_SIP_PORT` | Carrier proxy (`newyork1.voip.ms`). |
| `PUBLIC_IP` | Advertised to the carrier as the media and signalling address. |

## What is deliberately not here

- **A spool that sets itself up at runtime.** `faxsetup` asks questions on stdin
  and loops for ever on the numeric ones when stdin is closed, which is what a
  build has. The image seeds `/etc/hylafax/config` *before* the package is
  installed so the dialogue is skipped, symlinks `/var/spool/hylafax/etc` at
  `/etc/hylafax` (Debian bind-mounts it; a build has no `CAP_SYS_ADMIN`), and
  ships the finished spool at `/opt/fax/spool-seed` for a volume that arrives
  empty anyway.
- **Fax over Cantus.** A page through a voice codec is a page that fails slowly.
  The engine sits beside the switch, not behind it.
- **A shared DID.** The fax registers its own sub-account. A fax sharing the
  voice DID would need CNG detection on the carrier side, which is a carrier
  feature, not a container one.
