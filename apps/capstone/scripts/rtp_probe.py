#!/usr/bin/env python3
"""rtp_probe.py — capture and read RTP so a media stall is evidence, not a guess.

On 2026-11-25 two calls to 201 were torn down after the handset stopped sending
RTP for 30 s (`res_pjsip_sdp_rtp: lack of audio RTP activity in 30 seconds`).
The teardown was fixed (rtp_timeout=0, rtp_keepalive=15), but *why* the phone
went silent was never established: Asterisk only says that it did. This reads a
pcap and says, per media stream, how long the gaps actually were and whether the
stream resumed, which separates these three cases:

  * the leg stopped and never resumed  -> the phone stopped sending
  * the leg stopped, then resumed      -> a burst loss / Wi-Fi roam, not a hangup
  * both legs kept sending throughout  -> the audio was there; look elsewhere

A silence on its own does not say *why* the leg went quiet, because a phone that
suppresses silence (VAD) and a phone whose packets a lossy path swallowed look
identical from Asterisk's side. RTP's sequence number separates them: nothing
lost across the gap means the sender sent nothing (VAD / muted mic), while a
jump means those packets were sent and never arrived (the path). Every stream
carries that verdict, and `--stall-line` prints just the one line the watcher
logs.

Capture and analysis are separate on purpose: take the pcap during the event,
analyse it afterwards, and keep it as the record.

  # take a capture on the PBX host for 5 minutes (RTP range only)
  python3 scripts/rtp_probe.py --capture 300 --iface br0 -o /var/tmp/rtp.pcap
  # what happened on each stream
  python3 scripts/rtp_probe.py --pcap /var/tmp/rtp.pcap --gap 2.0

Only classic pcap (what `tcpdump -w` writes by default) is parsed; pcapng is
refused rather than half-read. Ethernet, Linux cooked capture (`-i any`), SLL2
and raw-IP frames are all understood — `-i any` is the obvious interface to use
on a host with bridges, and it does not write Ethernet headers.

Expect no RTP for the dograh leg on this stack: it is a `WebSocket/dograh/…`
channel over ARI, so only the handset legs (the `PJSIP/<ext>-…` channels) carry
RTP at all. That is consistent with the two inactivity notices ever logged —
both named `PJSIP/101-…`. Capturing the stall therefore needs a real call from a
physical phone; nothing on the dograh side will appear either way.
"""

from __future__ import annotations

import argparse
import json
import socket
import struct
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Link types as written in the pcap global header.
DLT_EN10MB = 1          # ethernet
DLT_RAW = 101           # raw IP (Linux `-i any` on some builds, `-y RAW`)
DLT_LINUX_SLL = 113     # `tcpdump -i any`
DLT_IPV4 = 228          # raw IPv4
DLT_LINUX_SLL2 = 276    # `tcpdump -i any` on newer libpcaps


@dataclass
class Stream:
    """One RTP stream, identified the way RTP itself identifies it."""

    src: str
    sport: int
    dst: str
    dport: int
    ssrc: int
    payload_type: int
    times: list[float] = field(default_factory=list)
    seqs: list[int] = field(default_factory=list)

    @property
    def label(self) -> str:
        return (
            f"{self.src}:{self.sport} -> {self.dst}:{self.dport} "
            f"ssrc=0x{self.ssrc:08x} pt={self.payload_type}"
        )

    def gaps(self, threshold: float) -> list[tuple[float, float, float]]:
        """(start, end, seconds) for every silence at least ``threshold`` long."""
        return [
            (t0, t1, t1 - t0)
            for t0, t1 in zip(self.times, self.times[1:])
            if t1 - t0 >= threshold
        ]

    def lost(self) -> int:
        """Sequence numbers that never arrived (RTP seq wraps at 2**16)."""
        lost = 0
        for a, b in zip(self.seqs, self.seqs[1:]):
            step = (b - a) % 65536
            if 1 < step < 1000:  # a reorder or duplicate is not a loss burst
                lost += step - 1
        return lost

    def verdict(self, threshold: float) -> dict:
        """Why the longest silence happened: the sender stopped, or the path dropped.

        RTP's own sequence number answers this. If the packet after a silence is
        the *next* sequence number, nothing was lost while the stream was quiet —
        the sender sent nothing, which is what silence suppression (VAD) or a
        muted microphone on the handset looks like. If the sequence jumped, that
        many packets were sent and never arrived: the network dropped them and
        the phone was talking into a hole. The two have opposite fixes, and the
        `lack of audio RTP activity` notice cannot tell them apart.
        """
        if len(self.times) < 2:
            return {"cause": "single-packet", "max_gap_s": 0.0,
                    "lost_in_gap": 0, "resumed": False, "seq_step": None}
        steps = [(b - a) % 65536 for a, b in zip(self.seqs, self.seqs[1:])]
        deltas = [
            (t1 - t0, i)
            for i, (t0, t1) in enumerate(zip(self.times, self.times[1:]))
            if t1 - t0 >= threshold
        ]
        if not deltas:
            return {"cause": "continuous", "max_gap_s": 0.0,
                    "lost_in_gap": 0, "resumed": True, "seq_step": None}
        longest, i = max(deltas)
        step = steps[i]
        lost = step - 1 if 1 < step < 1000 else 0
        return {
            "cause": "packet-loss" if lost else "sender-silent",
            "max_gap_s": round(longest, 3),
            "lost_in_gap": lost,
            # Packets after the gap's second packet: the stream came back.
            "resumed": i + 2 < len(self.times),
            "seq_step": step,
        }

    def summary(self, threshold: float) -> dict:
        duration = (self.times[-1] - self.times[0]) if len(self.times) > 1 else 0.0
        gaps = self.gaps(threshold)
        return {
            "stream": self.label,
            "packets": len(self.times),
            "seconds": round(duration, 3),
            "max_gap_s": round(max((g[2] for g in gaps), default=0.0), 3),
            "gaps_over_threshold": [
                {"at_s": round(g[0] - self.times[0], 2), "for_s": round(g[2], 2)}
                for g in gaps[:20]
            ],
            "seq_lost": self.lost(),
            "verdict": self.verdict(threshold),
        }


def _ipv4_at(raw: bytes, off: int) -> bytes | None:
    """The IPv4 packet starting at ``off``, recognised by its version nibble.

    The link headers that precede it differ not just by link type but by libpcap
    version (SLL2's protocol field is not even in a fixed byte order across
    writers), so the offset is *searched* for a plausible IPv4 header instead of
    trusted. A wrong guess here reads a busy live capture as "0 RTP streams",
    which is worse than an error: it looks like evidence that nothing was sent.
    """
    if off < 0 or len(raw) <= off + 20:
        return None
    if raw[off] >> 4 != 4:
        return None
    ihl = (raw[off] & 0x0F) * 4
    total = struct.unpack("!H", raw[off + 2:off + 4])[0]
    if ihl < 20 or total < ihl:
        return None
    return raw[off:off + min(total, len(raw) - off)]


def _ip_packet(raw: bytes, dlt: int) -> bytes | None:
    """The IP packet inside a captured frame, or None if it is not IPv4."""
    if dlt == DLT_EN10MB:
        if len(raw) < 14:
            return None
        ethertype = struct.unpack("!H", raw[12:14])[0]
        off = 14
        while ethertype in (0x8100, 0x88A8):  # VLAN / QinQ
            if len(raw) < off + 4:
                return None
            ethertype = struct.unpack("!H", raw[off + 2:off + 4])[0]
            off += 4
        return _ipv4_at(raw, off) if ethertype == 0x0800 else None
    if dlt == DLT_LINUX_SLL:
        for off in (16, 0):
            ip = _ipv4_at(raw, off)
            if ip is not None:
                return ip
        return None
    if dlt == DLT_LINUX_SLL2:
        # 20-byte header per the current spec, 16 in older writers.
        for off in (20, 16, 0):
            ip = _ipv4_at(raw, off)
            if ip is not None:
                return ip
        return None
    if dlt in (DLT_RAW, DLT_IPV4):
        return _ipv4_at(raw, 0)
    return None


def _udp_payload(raw: bytes, dlt: int) -> tuple[str, str, int, int, bytes] | None:
    """(src, dst, sport, dport, payload) for a UDP datagram, else None."""
    ip = _ip_packet(raw, dlt)
    if ip is None or len(ip) < 20:
        return None
    if ip[0] >> 4 != 4 or ip[9] != 17:  # IPv4, protocol UDP
        return None
    ihl = (ip[0] & 0x0F) * 4
    if len(ip) < ihl + 8:
        return None
    src = socket.inet_ntoa(ip[12:16])
    dst = socket.inet_ntoa(ip[16:20])
    sport, dport, length = struct.unpack("!HHH", ip[ihl:ihl + 6])
    payload = ip[ihl + 8:ihl + max(8, length)]
    return src, dst, sport, dport, payload


def rtp_header(payload: bytes) -> tuple[int, int, int] | None:
    """(payload_type, seq, ssrc) when this datagram is RTP, else None."""
    if len(payload) < 12 or payload[0] >> 6 != 2:  # RTP version
        return None
    return payload[1] & 0x7F, struct.unpack("!H", payload[2:4])[0], struct.unpack("!I", payload[8:12])[0]


def read_pcap(path: Path) -> tuple[int, list[tuple[float, bytes]]]:
    """(link type, [(timestamp, frame)]) for a classic pcap file."""
    data = path.read_bytes()
    if len(data) < 24:
        raise ValueError(f"{path} is too short to be a pcap")
    magic = data[:4]
    if magic == b"\x0a\x0d\x0d\x0a":
        raise ValueError(f"{path} is pcapng; re-save it with `tcpdump -w` (classic pcap)")
    if magic in (b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1"):
        endian, divisor = "<", 1e6
    elif magic in (b"\xa1\xb2\xc3\xd4", b"\xa1\xb2\x3c\x4d"):
        endian, divisor = ">", 1e6
    else:
        raise ValueError(f"{path}: unrecognised pcap magic {magic!r}")
    dlt = struct.unpack(endian + "I", data[20:24])[0]
    frames: list[tuple[float, bytes]] = []
    off = 24
    while off + 16 <= len(data):
        sec, frac, incl, _orig = struct.unpack(endian + "IIII", data[off:off + 16])
        off += 16
        frame = data[off:off + incl]
        if len(frame) < incl:
            break
        off += incl
        frames.append((sec + frac / divisor, frame))
    return dlt, frames


# Ports owned by other UDP protocols. NetBIOS and IAX2 payloads pass the RTP
# version test often enough to matter: a LAN broadcast on 137 with ssrc=0 and a
# 20 s gap between four packets otherwise reads as "this leg went silent", which
# is the opposite of the truth when the question is whether audio died.
NON_RTP_PORTS = {53, 67, 68, 69, 123, 137, 138, 139, 161, 162, 500, 514, 520, 1900, 4500, 4569, 5353}


def plausible_rtp(stream: Stream) -> bool:
    """Whether this is real RTP and not a lookalike that happens to pass bit 0-1.

    Three independent checks, because any one of them alone lets a lookalike
    through: a live SSRC, a port no other protocol owns, and sequence numbers
    that actually advance the way a media stream's do.
    """
    if stream.ssrc == 0:
        return False
    if stream.sport in NON_RTP_PORTS or stream.dport in NON_RTP_PORTS:
        return False
    # Fewer than five packets cannot show a silence worth acting on, and a
    # two-packet lookalike (Docker's embedded DNS on 127.0.0.11 answers with a
    # payload that passes the version test) is the kind of thing that turns a
    # quiet capture into a fake "stall".
    if len(stream.seqs) < 5:
        return False
    if len(stream.seqs) >= 5:
        steps = [(b - a) % 65536 for a, b in zip(stream.seqs, stream.seqs[1:])]
        advancing = sum(1 for step in steps if step in (1, 2))  # 2 = one lost packet
        if advancing / len(steps) < 0.8:
            return False
    return True


def rtp_streams(
    frames: list[tuple[float, bytes]], dlt: int = DLT_EN10MB, strict: bool = True
) -> dict[tuple, Stream]:
    """RTP streams in the capture; ``strict`` drops lookalikes (see plausible_rtp)."""
    streams: dict[tuple, Stream] = {}
    for ts, frame in frames:
        udp = _udp_payload(frame, dlt)
        if not udp:
            continue
        src, dst, sport, dport, payload = udp
        rtp = rtp_header(payload)
        if not rtp:
            continue
        pt, seq, ssrc = rtp
        key = (src, sport, dst, dport, ssrc)
        stream = streams.get(key)
        if stream is None:
            stream = streams[key] = Stream(src, sport, dst, dport, ssrc, pt)
        if stream.seqs and stream.seqs[-1] == seq:
            # The same packet, captured twice: `-i any` sees the frame on the
            # physical interface and again on the bridge/DNAT leg, so every
            # packet of a published RTP port arrives in this file twice. Those
            # repeats are one media packet, not two — counting them doubles the
            # packet total and, worse, makes half the sequence steps zero, which
            # plausible_rtp() reads as "not a media stream". That is how a real
            # 12,900-packet call was reported as `VERDICT: no-media`.
            continue
        stream.times.append(ts)
        stream.seqs.append(seq)
    if strict:
        return {k: v for k, v in streams.items() if plausible_rtp(v)}
    return streams


# The silence Asterisk counted before it tore the call down (rtp_timeout, now 0).
STALL_SECONDS = 30


def describe_verdict(verdict: dict) -> str:
    """One sentence an operator — or the watcher's log — can act on."""
    cause = verdict.get("cause")
    if cause == "continuous":
        return "kept sending throughout — the audio was there, so look past the media"
    if cause == "single-packet":
        return "one packet only — nothing to conclude"
    gap = verdict.get("max_gap_s", 0.0)
    tail = "and it came back" if verdict.get("resumed") else "and it never came back"
    if cause == "packet-loss":
        return (
            f"{verdict.get('lost_in_gap', 0)} packet(s) were sent and never arrived "
            f"across the {gap}s silence — the path dropped them, the phone was still "
            f"talking ({tail})"
        )
    return (
        f"nothing was lost across the {gap}s silence — the handset stopped sending "
        f"(silence suppression / muted mic), {tail}"
    )


def stall_row(rows: list[dict]) -> dict | None:
    """The worst stream whose silence reached the threshold Asterisk noticed."""
    stalled = [r for r in rows if r["max_gap_s"] >= STALL_SECONDS]
    return max(stalled, key=lambda r: r["max_gap_s"]) if stalled else None


def stall_line(row: dict) -> str:
    return (
        f"STALL: {row['max_gap_s']}s of silence on {row['stream']} — "
        f"{describe_verdict(row['verdict'])}"
    )


def verdict_line(rows: list[dict]) -> str:
    """The one line every analysed call leaves behind, stall or not.

    A `STALL:` line only exists when something went wrong, which leaves the
    opposite answer — "this call was fine, and here is what the media looked
    like" — nowhere to be read. That answer is worth as much: it is what closes
    the silence-suppression question, because a handset that kept sending for a
    whole answered call is a handset that does not suppress silence.
    """
    if not rows:
        return (
            "VERDICT: no-media — no RTP was captured, so this call settles nothing "
            "(nothing was answered, or the capture missed the media)"
        )
    head = f"{len(rows)} stream(s), {sum(r['packets'] for r in rows)} packet(s)"
    stalled = stall_row(rows)
    worst = stalled or max(rows, key=lambda r: r["max_gap_s"])
    if stalled is None:
        return (
            f"VERDICT: {worst['verdict']['cause']} — {describe_verdict(worst['verdict'])} "
            f"({head}, longest silence {worst['max_gap_s']}s on {worst['stream']})"
        )
    return (
        f"VERDICT: {worst['verdict']['cause']} — {describe_verdict(worst['verdict'])} "
        f"({head}, worst silence {worst['max_gap_s']}s on {worst['stream']})"
    )


def capture(seconds: int, iface: str, out: Path) -> Path:
    """`tcpdump -w` for ``seconds``, RTP port range only."""
    cmd = [
        "tcpdump", "-i", iface, "-n", "-s", "0", "-w", str(out),
        "udp", "and", "portrange", "10000-20000",
    ]
    print(f"capturing {seconds}s on {iface} → {out}", file=sys.stderr)
    proc = subprocess.run(["timeout", str(seconds)] + cmd, capture_output=True, text=True)
    # timeout(1) exits 124 when it stops tcpdump, which is the normal end here.
    if proc.returncode not in (0, 124):
        print(proc.stderr.strip() or f"tcpdump exited {proc.returncode}", file=sys.stderr)
        raise SystemExit(1)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcap", type=Path, help="classic pcap to analyse")
    ap.add_argument("--capture", type=int, metavar="SECONDS", help="capture first, then analyse")
    ap.add_argument("--iface", default="any", help="capture interface (default: any)")
    ap.add_argument("-o", "--out", type=Path, default=Path("/var/tmp/rtp-probe.pcap"))
    ap.add_argument("--gap", type=float, default=2.0, help="report silence at least this long (default 2.0 s)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument(
        "--stall-line", action="store_true",
        help="print only the one-line STALL summary (exit 2 when a leg stalled)",
    )
    ap.add_argument(
        "--verdict-line", action="store_true",
        help="print only one line saying what the media did, stall or not (always exit 0)",
    )
    args = ap.parse_args(argv)

    if not args.pcap and not args.capture:
        ap.error("give --pcap or --capture")
    path = args.pcap or capture(args.capture, args.iface, args.out)
    dlt, frames = read_pcap(path)
    candidates = rtp_streams(frames, dlt, strict=False)
    streams = {k: v for k, v in candidates.items() if plausible_rtp(v)}
    rejected = len(candidates) - len(streams)
    rows = sorted((s.summary(args.gap) for s in streams.values()), key=lambda r: -r["packets"])
    stall = stall_row(rows)

    if args.stall_line:
        if stall is None:
            return 0
        print(stall_line(stall))
        return 2

    if args.verdict_line:
        print(verdict_line(rows))
        return 0

    if args.json:
        print(json.dumps({
            "pcap": str(path), "linktype": dlt, "packets": len(frames),
            "streams": rows, "rejected_lookalikes": rejected,
            "stall": stall_line(stall) if stall else None,
            "verdict": verdict_line(rows),
        }, indent=2))
        return 0

    print(f"{path}: {len(frames)} packets, linktype {dlt}, {len(rows)} RTP streams")
    if rejected:
        print(f"  ({rejected} lookalike flow(s) dropped: non-zero SSRC, real RTP port, advancing sequence)")
    if not rows:
        print("no RTP found — either nothing was talking, or the capture point does not see the media")
        return 0
    for row in rows:
        print(
            f"\n{row['stream']}\n"
            f"  {row['packets']} packets over {row['seconds']}s, "
            f"{row['seq_lost']} seq lost, longest silence {row['max_gap_s']}s"
        )
        print(f"  verdict: {describe_verdict(row['verdict'])}")
        for gap in row["gaps_over_threshold"]:
            print(f"    silence {gap['for_s']}s starting {gap['at_s']}s into the stream")
    if stall is not None:
        print(f"\n{stall_line(stall)}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
