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

## Current verdict: one answered call short

**Not yet established.** Three calls have now been captured and all three had no
media to judge:

| When | Call | What the capture held | Why |
|---|---|---|---|
| 05:14 | first `PJSIP/101` ring | 8163 packets, 0 RTP | nobody answered |
| 06:49 | auto-answer probe to 101 | 15662 packets, 0 RTP | rang 25 s, never answered |
| 06:50 | auto-answer probe to 301 | 0 RTP | rang 20 s, never answered |
| 07:1x | probe 101, both header conventions | INVITE ×8 to `192.168.1.10:5060`, then `100 Trying`, `180 Ringing`, our `487` | the phone rang and never sent `200 OK` |

The probes are the point: waiting for a human to pick up a desk phone at 03:00
was the thing that kept this open, so `deploy/handset-probe.sh` rings the handset
itself — first with `Call-Info: <sip:x>;answer-after=0` (the intercom
convention), then with `Alert-Info: …info=alert-autoanswer` — and reports what
came back.

**What the wire shows.** The INVITE is delivered to `192.168.1.10:5060` and the
handset answers `100 Trying` then `180 Ringing`: it rings, and then never sends
`200 OK`; our side cancels with `487` when the ring timeout expires. So the
header is not being honoured. There is a second, smaller finding in the same
capture that has to be fixed before that can honestly be called a refusal — the
INVITE carries **no `Call-Info:` line at all**: the value's `;` is consumed as a
dialplan comment even escaped, so the pre-dial handler produces no header. That
is why the probe now prints `auto-answer header: NOT PRESENT … proves nothing`
instead of guessing, and why this section still says *pending*:

```bash
# the honest state of the two sub-questions:
#   is the phone being asked?   no  — the header is missing from the INVITE
#   does the phone suppress silence?  unknown — no answered call has media yet
```

The switch is on the phone, in its own web UI (`https://192.168.1.10/`, admin login):
**Features → General → "Allow Auto Answer by Call-Info" → Enabled**, then Save. It
is a device-level setting, so it covers both of the phone's accounts (101 and 102)
and both header conventions the probe tries. Nothing on the PBX needs to change —
the pre-dial handler already adds the header, and the probe prints whether it
actually reached the INVITE.

```bash
# once the phone allows Call-Info auto-answer, one command:
handset-probe.sh 101          # rings, holds 130 s, prints the verdict
```

What would confirm VAD: an answered call where the verdict is `sender-silent`,
the silence sits where the caller is not speaking, and the stream resumes. What
would refute it: `packet-loss`, or `sender-silent` with `resumed: false` (the
audio path broke rather than the phone choosing to be quiet).

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
