# The handset that goes quiet — what the RTP evidence says

On 2026-11-25 two calls to 201 were torn down mid-call by
`res_pjsip_sdp_rtp: lack of audio RTP activity in 30 seconds`. The teardown is
fixed (`rtp_timeout=0`, `rtp_keepalive=15` — see
[Voice hardening](operations.md#voice-hardening--the-endpoint-settings-live-in-the-repo-now)),
but the question that matters for the *phone* was never answered: **did the
handset stop sending, or did the network stop delivering?** They have opposite
fixes, and Asterisk's notice is identical either way.

This is the record of that investigation, and the rule that turns the next
occurrence into an answer instead of another hypothesis.

## What was observed

| Observation | Source |
|---|---|
| Two notices, both on `PJSIP/101-…` | Asterisk log, 00:07:19 and 04:22:47 |
| Each arrived ~30 s before a long call ended (the second: a 121 s call) | `rtp_timeout` was 30 |
| The agent leg emits **no RTP at all** — it is a `WebSocket/dograh/…` channel over ARI | `core show channels`, call legs |
| A ringing call on 101 captures **0 RTP streams** | `call-20261125T051444Z.pcap`: 8163 packets, linktype 276, no media |
| The handset is a **Yealink SIP-T54W, firmware 96.86.0.70** — it holds two accounts, 101 ("Desk T54W") and 102 ("Fax"), both registering from `192.168.1.10`; 301/302 register from `192.168.1.5` | `User-Agent: Yealink SIP-T54W 96.86.0.70` on a live `pjsip qualify 101`, and `https://192.168.1.10/` answers `<title>Yealink T54W Phone</title>` |
| Earlier revisions called it a **Grandstream DP750 1.0.21.33** — that was wrong, read off the 05:14 capture; the auto-answer instruction below names the Yealink setting | `pjsip qualify 101` and the phone's own web UI, both checked 2026-11-25 09:47Z |
| No SDP from the handset is on record, so its declared VAD/comfort-noise capability is unknown | the capture's only SIP responses were two `200 OK` to qualify |

Zero media on a ringing call is correct, not a capture fault: an unanswered call
has no media, and the dograh side never has any. **A capture only produces
evidence once a handset call is answered** — which is why the watcher exists.

## The rule that settles it

RTP identifies itself: the sequence number counts packets the sender actually
produced. So the packet after a silence says which of the two causes it was:

| Across the ≥30 s silence | Meaning | Fix |
|---|---|---|
| sequence is the **next** number (nothing lost) | the handset sent nothing — silence suppression (VAD), a muted mic, or the DECT link | if VAD: nothing, the call no longer dies; mute/DECT: the handset side |
| sequence **jumps** by N | N packets were sent and never arrived — the path dropped them | the path: switch port, Wi-Fi, VLAN, DECT base uplink |
| the stream never resumed | the audio path itself broke | the handset / DECT link |

`scripts/rtp_probe.py` computes exactly this per stream (`verdict.cause` =
`sender-silent` / `packet-loss` / `continuous`, plus `lost_in_gap` and
`resumed`). Two flags print the sentences the watcher logs — `--stall-line` only
when something stalled, and `--verdict-line` for **every** analysed call, because
"the handset kept sending throughout" is the answer to this question and a log
that only records failures can never state it:

```
STALL: 31.4s of silence on 192.168.1.10:52172 -> 192.168.1.52:16142
ssrc=0x… pt=0 — nothing was lost across the 31.4s silence — the handset
stopped sending (silence suppression / muted mic), and it came back
```

`deploy/rtp-stall-watch.sh` (cron, 1 min) captures the next call on
101/102/301/302, analyses it, and writes that line to
`/var/log/rtp-watch/watch.log`; the Control Center turns a line from the last
24 h into the `al-voice-rtp-stall` alert, so the next occurrence is visible on
the Alerts page as well as greppable.

## Current verdict: settled — the handset answered and never stopped sending

**Established 2026-11-25 10:10Z.** Two defects sat between the probe and an
answer, and both were in the probe rather than the phone:

1. **The call was never placed.** The variants are `call-info` / `alert-info`, but
   the dialplan contexts are `capstone-handset-probe-callinfo` /
   `…-alertinfo`. `channel originate Local/101@capstone-handset-probe-call-info`
   logged `No such extension/context … while calling Local channel`, so no INVITE
   ever left the box — and the probe printed the empty capture as though the phone
   had refused. The mapping now lives in one `ctx_name` function.
2. **Real media was discarded.** `tcpdump -i any` captures a published RTP port
   twice (physical interface, then the bridge/DNAT leg), so every packet is in the
   file twice and half the sequence steps are zero. `plausible_rtp()` read that as
   "not advancing" and dropped the stream — which is how 12,900 real packets became
   `VERDICT: no-media`. A repeat of the last sequence number is now one packet.

With both fixed, `handset-probe.sh 101` on the **Call-Info** variant produced:

| Evidence | Value |
|---|---|
| INVITE | `INVITE sip:101@192.168.1.10:5060 SIP/2.0` |
| auto-answer header | `Call-Info: <sip:probe@localhost>;answer-after=0`, on the INVITE |
| phone's answer | `100 Trying`, `180 Ringing`, then **`200 OK`** — the channel went `Up` |
| media | 6,450 packets `192.168.1.10:11858 → :10178` over **129 s**, 0 lost, **longest silence 0.0 s** |
| verdict | `continuous — kept sending throughout` |

So **the handset does not suppress silence.** It auto-answers —— Features →
General → "Allow Auto Answer by Call-Info" is enabled on the T54W —— and it sends
RTP for the whole call, including while nothing is played into it. The two 30 s
notices were therefore not the phone choosing to be quiet, and with `rtp_timeout=0`
a silent leg no longer ends a call.

What remains unproven is narrower than before: the original stalls happened during
a real conversation with an agent talking, which this probe does not reproduce (it
holds a silent call). A future `sender-silent` verdict over a ≥30 s silence on a
live call is the remaining case — and the watcher now states that, or states
`continuous`, for every call it captures.

## What the earlier attempts captured

| When | Call | What the capture held | Why |
|---|---|---|---|
| 05:14 | first `PJSIP/101` ring | 8163 packets, 0 RTP | nobody answered |
| 06:49 | auto-answer probe to 101 | 15662 packets, 0 RTP | rang 25 s, never answered |
| 06:50 | auto-answer probe to 301 | 0 RTP | rang 20 s, never answered |
| 07:1x | probe 101, both header conventions | INVITE ×8 to `192.168.1.10:5060`, then `100 Trying`, `180 Ringing`, our `487` | the phone rang and never sent `200 OK` |
| 10:10 | probe 101, **Call-Info** | INVITE with `answer-after=0`, `200 OK`, 6,450 RTP packets, no gap | **answered — the answer** |

The probes are the point: waiting for a human to pick up a desk phone at 03:00
was the thing that kept this open, so `deploy/handset-probe.sh` rings the handset
itself — first with `Call-Info: <sip:x>;answer-after=0` (the intercom
convention), then with `Alert-Info: …info=alert-autoanswer` — and reports what
came back.

The setting lives on the phone, in its own web UI (`https://192.168.1.10/`, admin
login): **Features → General → "Allow Auto Answer by Call-Info" → Enabled**. It is
device-level, so it covers both of the phone's accounts (101 and 102). Nothing on
the PBX needs to change — the pre-dial handler adds the header, and the probe
prints whether it actually reached the INVITE.

```bash
handset-probe.sh 101          # rings, holds 130 s, prints the verdict
```

What would still confirm VAD on a live call: a `sender-silent` verdict where the
silence sits where nobody is speaking and the stream resumes. What refutes it:
`packet-loss`, or `sender-silent` with `resumed: false` (the audio path broke
rather than the phone choosing to be quiet). The 10:10 call was neither — it sent
continuously.

Either way the call no longer drops: with `rtp_timeout=0` a silent leg is not a
reason to hang up, and `rtp_keepalive=15` keeps the estate's side of the media
flowing. If the verdict is VAD, the residual cost is that Asterisk sees no
inbound audio while the caller is silent — which is when nothing is listening to
them anyway.

**Nobody has to read the log to get that answer.** Each capture's `VERDICT:`
line is parsed by the Control Center: `GET /voice` reports `media.question` as
`pending` or `settled`, alongside the cause and a plain-language conclusion, and
the Health page prints it ("Settled: continuous — the handset sent media
throughout…"). The first answered call closes the question without anyone
opening a shell.

## Reading the record

```bash
# what the watcher has seen
tail -40 /var/log/rtp-watch/watch.log
# what each captured call did, healthy or not
grep '^.*VERDICT:' /var/log/rtp-watch/watch.log
# every stall, with its cause
grep '^.*STALL:' /var/log/rtp-watch/watch.log
# re-read any kept capture
python3 /usr/local/bin/rtp-probe.py --pcap /var/log/rtp-watch/call-*.pcap --gap 2.0
# what the Control Center concluded
grep '"question"' <(curl -s localhost:8095/voice | python3 -m json.tool)
```
