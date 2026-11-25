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
