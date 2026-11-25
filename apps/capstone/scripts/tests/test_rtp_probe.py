"""Tests for the pcap/RTP reader in scripts/rtp_probe.py.

The tool exists to answer a question Asterisk cannot: when a call's audio died,
which leg stopped sending, for how long, and did it come back. So the tests
build pcaps with a known answer — a steady leg and a leg that goes silent for
exactly 30 s — and check the tool reports that rather than a plausible number.

The link-type cases are not decoration: `tcpdump -i any` writes Linux cooked
capture (SLL), not Ethernet, and reading a live capture with an Ethernet-only
parser reports "0 RTP streams" for a busy call.
"""

import socket
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rtp_probe  # noqa: E402


def _ip_udp(src, dst, sport, dport, payload):
    udp = struct.pack("!HHHH", sport, dport, 8 + len(payload), 0) + payload
    ip = struct.pack(
        "!BBHHHBBH4s4s", 0x45, 0, 20 + len(udp), 1, 0, 64, 17, 0,
        socket.inet_aton(src), socket.inet_aton(dst),
    )
    return ip + udp


def _rtp(ssrc, seq, payload_len=160):
    return (
        bytes([0x80, 0x00])
        + struct.pack("!HII", seq % 65536, seq * payload_len, ssrc)
        + b"\x11" * payload_len
    )


def _ethernet(packet):
    return b"\x02" * 6 + b"\x04" * 6 + struct.pack("!H", 0x0800) + packet


def _sll(packet, sll2=False):
    """A Linux cooked-capture frame, the shape `tcpdump -i any` writes."""
    if sll2:
        return struct.pack("!HH", 0x0800, 0) + b"\x00" * 16 + packet
    return struct.pack("!HHH", 0, 1, 6) + b"\x02" * 6 + b"\x00\x00" + struct.pack("!H", 0x0800) + packet


def _pcap(path, packets, dlt=rtp_probe.DLT_EN10MB):
    chunks = []
    for when, frame in packets:
        sec = int(when)
        usec = int(round((when - sec) * 1e6))
        chunks.append(struct.pack("<IIII", sec, usec, len(frame), len(frame)) + frame)
    path.write_bytes(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, dlt) + b"".join(chunks))


class PcapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "capture.pcap"
        # Leg A: talkative for 40 s. Leg B: silent from 10 s to 40 s, then back.
        packets = []
        for i in range(800):
            packets.append((i * 0.05, _ethernet(_ip_udp(
                "192.168.1.77", "192.168.1.52", 11700, 10002, _rtp(0xAABBCCDD, i)))))
        for i in range(200):
            packets.append((i * 0.05, _ethernet(_ip_udp(
                "192.168.1.52", "192.168.1.77", 10004, 11800, _rtp(0x11223344, i)))))
        for i in range(200):
            packets.append((40 + i * 0.05, _ethernet(_ip_udp(
                "192.168.1.52", "192.168.1.77", 10004, 11800, _rtp(0x11223344, 200 + i)))))
        _pcap(self.path, packets)

    def tearDown(self):
        self.tmp.cleanup()

    def streams(self):
        dlt, frames = rtp_probe.read_pcap(self.path)
        return rtp_probe.rtp_streams(frames, dlt)

    def test_both_legs_are_found_and_separated_by_ssrc(self):
        self.assertEqual(len(self.streams()), 2)

    def test_the_steady_leg_reports_no_silence(self):
        steady = [s for s in self.streams().values() if s.ssrc == 0xAABBCCDD][0]
        self.assertEqual(steady.gaps(2.0), [])

    def test_the_stalling_leg_reports_its_30_second_silence(self):
        stalling = [s for s in self.streams().values() if s.ssrc == 0x11223344][0]
        gaps = stalling.gaps(2.0)
        self.assertEqual(len(gaps), 1)
        self.assertAlmostEqual(gaps[0][2], 30.0, delta=0.2)

    def test_a_silent_leg_counts_as_a_stall_in_the_exit_code(self):
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):
            code = rtp_probe.main(["--pcap", str(self.path), "--gap", "2.0"])
        self.assertEqual(code, 2, "a 30 s silence must not read as healthy")

    def test_the_stalling_leg_says_the_handset_stopped_not_the_network(self):
        """Leg B's sequence numbers are contiguous across the gap.

        That is the whole point of the verdict: nothing was lost while the leg
        was quiet, so the phone sent nothing — silence suppression — rather than
        talking into a path that dropped its packets.
        """
        stalling = [s for s in self.streams().values() if s.ssrc == 0x11223344][0]
        verdict = stalling.verdict(2.0)
        self.assertEqual(verdict["cause"], "sender-silent")
        self.assertEqual(verdict["lost_in_gap"], 0)
        self.assertEqual(verdict["seq_step"], 1)
        self.assertTrue(verdict["resumed"], "the leg came back at 40s")
        self.assertAlmostEqual(verdict["max_gap_s"], 30.0, delta=0.2)

    def test_a_steady_stream_is_continuous(self):
        steady = [s for s in self.streams().values() if s.ssrc == 0xAABBCCDD][0]
        self.assertEqual(steady.verdict(2.0)["cause"], "continuous")

    def test_a_sequence_jump_across_the_silence_reads_as_packet_loss(self):
        """The phone kept talking; the path ate 200 packets in between."""
        lossy = Path(self.tmp.name) / "lossy.pcap"
        packets = [
            (i * 0.05, _ethernet(_ip_udp(
                "192.168.1.77", "192.168.1.52", 11700, 10002, _rtp(0x51515151, i))))
            for i in range(100)
        ]
        packets += [
            (35 + i * 0.05, _ethernet(_ip_udp(
                "192.168.1.77", "192.168.1.52", 11700, 10002, _rtp(0x51515151, 300 + i))))
            for i in range(100)
        ]
        _pcap(lossy, packets)
        dlt, frames = rtp_probe.read_pcap(lossy)
        stream = list(rtp_probe.rtp_streams(frames, dlt).values())[0]
        verdict = stream.verdict(2.0)
        self.assertEqual(verdict["cause"], "packet-loss")
        self.assertEqual(verdict["seq_step"], 201)   # 99 -> 300
        self.assertEqual(verdict["lost_in_gap"], 200)

    def test_the_stall_line_is_one_line_that_names_the_cause(self):
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = rtp_probe.main(["--pcap", str(self.path), "--stall-line"])
        self.assertEqual(code, 2)
        lines = [ln for ln in buffer.getvalue().splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, lines)
        self.assertTrue(lines[0].startswith("STALL: "), lines[0])
        self.assertIn("handset stopped sending", lines[0])

    def test_a_capture_without_a_stall_prints_no_line(self):
        import contextlib
        import io

        steady = Path(self.tmp.name) / "steady.pcap"
        _pcap(steady, [
            (i * 0.02, _ethernet(_ip_udp("192.168.1.77", "192.168.1.52", 11700, 10002, _rtp(9, i))))
            for i in range(100)
        ])
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = rtp_probe.main(["--pcap", str(steady), "--stall-line"])
        self.assertEqual(code, 0)
        self.assertEqual(buffer.getvalue().strip(), "")

    def test_the_verdict_line_says_a_healthy_handset_kept_sending(self):
        """A healthy call still leaves a line — "no silence" is an answer too.

        Without this the panel could only ever show failures, and the question
        "does the phone suppress silence" could not be closed by a good call.
        """
        import contextlib
        import io

        steady = Path(self.tmp.name) / "steady-verdict.pcap"
        _pcap(steady, [
            (i * 0.02, _ethernet(_ip_udp("192.168.1.77", "192.168.1.52", 11700, 10002, _rtp(9, i))))
            for i in range(100)
        ])
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = rtp_probe.main(["--pcap", str(steady), "--verdict-line"])
        self.assertEqual(code, 0, "a healthy call is not an error")
        line = buffer.getvalue().strip()
        self.assertTrue(line.startswith("VERDICT: continuous — "), line)
        self.assertIn("kept sending throughout", line)
        self.assertIn("100 packet(s)", line)

    def test_the_verdict_line_on_a_stalled_capture_names_sender_silent(self):
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = rtp_probe.main(["--pcap", str(self.path), "--verdict-line"])
        self.assertEqual(code, 0, "--verdict-line reports, it does not fail the run")
        line = buffer.getvalue().strip()
        self.assertTrue(line.startswith("VERDICT: sender-silent — "), line)
        self.assertIn("handset stopped sending", line)
        self.assertIn("worst silence", line)

    def test_a_capture_with_no_rtp_says_it_settles_nothing(self):
        import contextlib
        import io

        empty = Path(self.tmp.name) / "empty.pcap"
        _pcap(empty, [(0.0, _ethernet(_ip_udp(
            "192.168.1.1", "192.168.1.2", 5000, 5001, b"\x00" * 20))) for _ in range(3)])
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rtp_probe.main(["--pcap", str(empty), "--verdict-line"])
        self.assertIn("VERDICT: no-media", buffer.getvalue())

    def test_linux_cooked_capture_is_read_the_same_as_ethernet(self):
        cooked = Path(self.tmp.name) / "any.pcap"
        packets = [
            (i * 0.02, _sll(_ip_udp("10.0.4.9", "10.0.4.1", 16000, 10020, _rtp(0xDEADBEEF, i))))
            for i in range(50)
        ]
        _pcap(cooked, packets, dlt=rtp_probe.DLT_LINUX_SLL)
        dlt, frames = rtp_probe.read_pcap(cooked)
        streams = rtp_probe.rtp_streams(frames, dlt)
        self.assertEqual(len(streams), 1, "a live `-i any` capture must not read as empty")
        self.assertEqual(list(streams.values())[0].ssrc, 0xDEADBEEF)

    def test_sll2_capture_is_also_read(self):
        # The header layout that libpcap writes for `-i any`, and enough packets
        # to be a media stream rather than a lookalike.
        cooked = Path(self.tmp.name) / "any2.pcap"
        _pcap(
            cooked,
            [
                (i * 0.02, _sll(_ip_udp("10.0.4.9", "10.0.4.1", 16000, 10020, _rtp(7, i)), sll2=True))
                for i in range(10)
            ],
            dlt=rtp_probe.DLT_LINUX_SLL2,
        )
        dlt, frames = rtp_probe.read_pcap(cooked)
        self.assertEqual(len(rtp_probe.rtp_streams(frames, dlt)), 1)

    def test_a_two_packet_lookalike_is_below_the_threshold(self):
        """Docker's embedded DNS (127.0.0.11) passes the version test twice."""
        dns = Path(self.tmp.name) / "dns.pcap"
        payload = bytes([0x80, 0x32]) + struct.pack("!HII", 1, 0, 1) + b"\x00" * 20
        packets = [(i * 0.001, _ethernet(_ip_udp(
            "127.0.0.1", "127.0.0.11", 49191, 44775, payload))) for i in range(2)]
        _pcap(dns, packets)
        dlt, frames = rtp_probe.read_pcap(dns)
        self.assertEqual(rtp_probe.rtp_streams(frames, dlt), {})

    def test_a_pcapng_file_is_refused_rather_than_half_read(self):
        bogus = Path(self.tmp.name) / "x.pcapng"
        bogus.write_bytes(b"\x0a\x0d\x0d\x0a" + b"\x00" * 40)
        with self.assertRaises(ValueError):
            rtp_probe.read_pcap(bogus)

    def test_netbios_on_137_is_not_mistaken_for_a_stalled_leg(self):
        """A LAN broadcast passed the version test and read as a 20 s silence."""
        noisy = Path(self.tmp.name) / "netbios.pcap"
        packets = [(i * 7.0, _ethernet(_ip_udp(
            "192.168.1.1", "192.168.1.56", 56515, 137, b"\x80\x20" + b"\x00" * 30))) for i in range(4)]
        _pcap(noisy, packets)
        dlt, frames = rtp_probe.read_pcap(noisy)
        self.assertEqual(rtp_probe.rtp_streams(frames, dlt), {})

    def test_iax2_on_4569_is_not_mistaken_for_media(self):
        iax = _ip_udp("10.0.3.10", "208.100.60.66", 4569, 4569,
                      bytes([0x80, 0x55]) + b"\x06\x0d" + b"\x00" * 40)
        path = Path(self.tmp.name) / "iax.pcap"
        _pcap(path, [(0.0, _ethernet(iax)), (0.03, _ethernet(iax))])
        dlt, frames = rtp_probe.read_pcap(path)
        self.assertEqual(rtp_probe.rtp_streams(frames, dlt), {})

    def test_real_rtp_survives_the_strict_filter(self):
        dlt, frames = rtp_probe.read_pcap(self.path)
        self.assertEqual(len(rtp_probe.rtp_streams(frames, dlt)), 2)

    def test_non_rtp_udp_is_ignored(self):
        quiet = Path(self.tmp.name) / "junk.pcap"
        _pcap(quiet, [(1.0, _ethernet(_ip_udp(
            "192.168.1.77", "192.168.1.52", 11800, 10004, b"\x00" * 172)))])
        dlt, frames = rtp_probe.read_pcap(quiet)
        self.assertEqual(rtp_probe.rtp_streams(frames, dlt), {})


if __name__ == "__main__":
    unittest.main()
