#!/usr/bin/env python3
"""Unit tests for dashboard-backend/app/voice.py — the Control Center's voice state.

Why it matters: this is what turns two host-side watchers into something an
operator sees. A page that says "in sync" while the timer has been dead for a
day is worse than no page, and an alert for a host that never had the watchers
installed is noise nobody asked for. So the tests pin the three states apart —
fresh, stale, and not installed — and check that a 30 s silence becomes an alert
only while it is recent.

The tests run against a temporary host root: no Docker, no FastAPI, no files
outside the fixture.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import voice  # noqa: E402


def _iso(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat(timespec="seconds")


class VoiceStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.previous_root = voice.HOST_ROOT
        voice.HOST_ROOT = str(self.root)
        (self.root / "var/lib/capstone-prewarm").mkdir(parents=True)
        (self.root / "var/log/rtp-watch").mkdir(parents=True)
        self.status = self.root / "var/lib/capstone-prewarm/status.json"
        self.listing = self.root / "var/lib/capstone-prewarm/prewarm.txt"
        self.log = self.root / "var/log/rtp-watch/watch.log"

    def tearDown(self):
        voice.HOST_ROOT = self.previous_root
        self.tmp.cleanup()

    def write_status(self, **overrides):
        payload = {
            "checkedAt": _iso(1), "inSync": True, "greetings": 2,
            "drift": None, "applied": False, "error": None,
        }
        payload.update(overrides)
        self.status.write_text(json.dumps(payload))

    def write_listing(self, *greetings):
        self.listing.write_text(
            "# Greetings the shim synthesizes at startup.\n" + "\n".join(greetings) + "\n"
        )

    def write_log(self, *lines):
        self.log.write_text("\n".join(lines) + "\n")

    def alerts(self):
        return {a["id"]: a for a in voice.build_voice_alerts()}

    # ── the prewarm list ────────────────────────────────────────────────────

    def test_a_fresh_check_reports_the_installed_greetings(self):
        self.write_status()
        self.write_listing("Hi there, this is Jordan.", "Hi there, this is Robin.")
        state = voice.build_voice_status()["prewarm"]
        self.assertTrue(state["installed"])
        self.assertTrue(state["inSync"])
        self.assertFalse(state["stale"])
        self.assertEqual(state["greetings"], 2)
        self.assertEqual(len(state["lines"]), 2)
        self.assertEqual(self.alerts(), {})

    def test_comments_are_not_greetings(self):
        self.write_status(greetings=1)
        self.write_listing("Hi there, this is Jordan.")
        self.assertEqual(voice.build_voice_status()["prewarm"]["greetings"], 1)

    def test_a_check_older_than_the_watchdog_window_is_stale_and_alerts(self):
        self.write_status(checkedAt=_iso(45))
        self.write_listing("Hi there, this is Jordan.")
        state = voice.build_voice_status()["prewarm"]
        self.assertTrue(state["stale"])
        self.assertGreater(state["ageSeconds"], 20 * 60)
        alert = self.alerts()["al-voice-prewarm-stale"]
        self.assertEqual(alert["severity"], "warning")
        self.assertIn("5 min", alert["message"])

    def test_a_drifted_list_alerts_with_the_drift(self):
        self.write_status(inSync=False, drift="missing: Hi Dana, this is Jordan from our company.")
        self.write_listing("Hi there, this is Jordan.")
        alert = self.alerts()["al-voice-prewarm-drift"]
        self.assertIn("does not match", alert["message"])
        self.assertIn("Hi Dana", alert["message"])

    def test_a_repair_is_in_sync_and_says_it_was_applied(self):
        self.write_status(inSync=True, applied=True, drift="stale: Hi Dana, …")
        self.write_listing("Hi there, this is Jordan.")
        state = voice.build_voice_status()["prewarm"]
        self.assertTrue(state["applied"])
        self.assertTrue(state["inSync"])
        self.assertEqual(self.alerts(), {})

    def test_a_host_without_the_watcher_is_quiet(self):
        self.status.unlink(missing_ok=True)
        self.listing.unlink(missing_ok=True)
        state = voice.build_voice_status()
        self.assertFalse(state["prewarm"]["installed"])
        self.assertFalse(state["media"]["watcherSeen"])
        self.assertEqual(self.alerts(), {}, "an uninstalled watcher must not page anyone")

    def test_an_unreadable_status_is_reported_not_silently_in_sync(self):
        self.status.write_text("{ this is not json")
        self.write_listing("Hi there, this is Jordan.")
        state = voice.build_voice_status()["prewarm"]
        self.assertTrue(state["stale"])
        self.assertIn("unreadable", state["error"])
        self.assertIn("al-voice-prewarm-error", self.alerts())

    def test_a_status_without_a_usable_timestamp_is_stale(self):
        self.write_status(checkedAt="not-a-date")
        self.write_listing("Hi there, this is Jordan.")
        self.assertTrue(voice.build_voice_status()["prewarm"]["stale"])

    # ── handset media ───────────────────────────────────────────────────────

    def test_a_capture_verdict_settles_the_silence_question(self):
        """The page should *answer* the VAD question, not just log a sentence.

        A handset that kept sending through an answered call is a handset that
        does not suppress silence; the panel says so, in the API's words.
        """
        self.write_status()
        self.write_listing("Hi there, this is Jordan.")
        self.write_log(
            f"{_iso(6)} VERDICT: continuous — kept sending throughout — the audio was there, "
            "so look past the media (1 stream(s), 41 packet(s), longest silence 0.2s on "
            "192.168.1.10:52172 -> 192.168.1.52:16142 ssrc=0x0000beef pt=0) — "
            "/var/log/rtp-watch/call-20261125T062010Z.pcap",
        )
        media = voice.build_voice_status()["media"]
        self.assertEqual(media["question"], "settled")
        self.assertEqual(media["lastVerdict"]["cause"], "continuous")
        self.assertEqual(media["lastVerdict"]["capture"], "call-20261125T062010Z.pcap")
        self.assertIn("does not suppress silence", media["lastVerdict"]["conclusion"])
        self.assertEqual(self.alerts(), {}, "a healthy call is not an alert")

    def test_a_sender_silent_verdict_reads_as_vad_and_keeps_the_stall(self):
        self.write_status()
        self.write_listing("Hi there, this is Jordan.")
        self.write_log(
            f"{_iso(9)} STALL: 31.4s of silence on 192.168.1.10:52172 -> 192.168.1.52:16142 "
            "ssrc=0x0000beef pt=0 — nothing was lost across the 31.4s silence — the handset "
            "stopped sending (silence suppression / muted mic), and it came back",
            f"{_iso(9)} VERDICT: sender-silent — nothing was lost across the 31.4s silence — "
            "the handset stopped sending (silence suppression / muted mic), and it came back "
            "(1 stream(s), 612 packet(s), worst silence 31.4s on 192.168.1.10:52172) — "
            "/var/log/rtp-watch/call-c.pcap",
        )
        media = voice.build_voice_status()["media"]
        self.assertEqual(media["question"], "settled")
        self.assertEqual(media["lastVerdict"]["cause"], "sender-silent")
        self.assertIn("silence suppression", media["lastVerdict"]["conclusion"])
        self.assertIn("al-voice-rtp-stall", self.alerts())

    def test_a_call_without_media_leaves_the_question_pending(self):
        self.write_status()
        self.write_listing("Hi there, this is Jordan.")
        self.write_log(
            f"{_iso(6)} VERDICT: no-media — no RTP was captured, so this call settles nothing "
            "(nothing was answered, or the capture missed the media) — "
            "/var/log/rtp-watch/call-d.pcap",
        )
        media = voice.build_voice_status()["media"]
        self.assertEqual(media["question"], "pending")
        self.assertIn("settles nothing", media["lastVerdict"]["conclusion"])

    def test_a_stall_without_a_verdict_leaves_the_question_pending(self):
        self.write_status()
        self.write_listing("Hi there, this is Jordan.")
        self.write_log(f"{_iso(4)} STALL: 30.2s of silence on PJSIP/101 — the handset stopped sending")
        self.assertEqual(voice.build_voice_status()["media"]["question"], "pending")

    def test_the_push_state_is_reported_and_off_until_it_is_configured(self):
        push = voice.build_voice_status()["push"]
        self.assertEqual(push["gateway"], "opensms")
        self.assertIn(push["provider"], ("zeus", "opensms", "auto"))
        self.assertEqual(push["to"], "", "no recipient configured means no number to leak")
        self.assertFalse(push["configured"])

    def test_a_recent_stall_becomes_an_alert_that_names_the_cause(self):
        self.write_status()
        self.write_listing("Hi there, this is Jordan.")
        self.write_log(
            f"{_iso(30)} capture started for 1 handset channel(s) → /var/log/rtp-watch/call-a.pcap",
            f"{_iso(28)} call ended; analysing /var/log/rtp-watch/call-a.pcap",
            f"{_iso(28)} STALL: 31.4s of silence on 192.168.1.10:52172 -> "
            "192.168.1.52:16142 ssrc=0x0000beef pt=0 — nothing was lost across the 31.4s "
            "silence — the handset stopped sending (silence suppression / muted mic), and it came back",
        )
        media = voice.build_voice_status()["media"]
        self.assertEqual(media["captures"], 1)
        self.assertEqual(media["stalls"], 1)
        self.assertEqual(media["stallsInWindow"], 1)
        self.assertIsNotNone(media["lastStallRecent"])
        alert = self.alerts()["al-voice-rtp-stall"]
        self.assertEqual(alert["service"], "FreePBX")
        self.assertIn("handset stopped sending", alert["message"])

    def test_an_old_stall_is_history_not_an_alert(self):
        self.write_status()
        self.write_listing("Hi there, this is Jordan.")
        self.write_log(f"{_iso(60 * 72)} STALL: 30.2s of silence on PJSIP/101 — the handset stopped sending")
        media = voice.build_voice_status()["media"]
        self.assertEqual(media["stalls"], 1)
        self.assertEqual(media["stallsInWindow"], 0)
        self.assertIsNotNone(media["lastStall"], "the history stays visible")
        self.assertNotIn("al-voice-rtp-stall", self.alerts())

    def test_a_capture_with_no_media_is_not_a_stall(self):
        self.write_status()
        self.write_listing("Hi there, this is Jordan.")
        self.write_log(
            f"{_iso(5)} capture started for 1 handset channel(s) → /var/log/rtp-watch/call-b.pcap",
            f"{_iso(4)} call ended; analysing /var/log/rtp-watch/call-b.pcap",
            "no RTP found — either nothing was talking, or the capture point does not see the media",
        )
        media = voice.build_voice_status()["media"]
        self.assertEqual(media["captures"], 1)
        self.assertEqual(media["stalls"], 0)
        self.assertEqual(self.alerts(), {})

    def test_kept_captures_are_listed_newest_first(self):
        self.write_status()
        self.write_listing("Hi there, this is Jordan.")
        for name, size in (("call-20261125T051444Z.pcap", 10), ("call-20261125T060000Z.pcap", 20)):
            (self.root / "var/log/rtp-watch" / name).write_bytes(b"\x00" * size)
            os.utime(self.root / "var/log/rtp-watch" / name, (1_700_000_000 + size, 1_700_000_000 + size))
        media = voice.build_voice_status()["media"]
        self.assertEqual(media["capturesKept"], 2)
        self.assertEqual(media["lastCapture"]["name"], "call-20261125T060000Z.pcap")
        self.assertEqual(media["lastCapture"]["sizeBytes"], 20)

    def test_status_is_json_serialisable_for_the_endpoint(self):
        self.write_status(checkedAt=_iso(60 * 24 * 3), inSync=False, drift="missing: one")
        self.write_listing("Hi there, this is Jordan.")
        json.dumps(voice.build_voice_status())
        json.dumps(voice.build_voice_alerts())


class AlertShapeTest(unittest.TestCase):
    """Alerts have to keep the shape the dashboard's Alert type (and page) wants."""

    ALERT_KEYS = {"id", "time", "service", "severity", "message", "status", "assignedTo", "tags"}

    def test_alerts_carry_every_key_the_dashboard_alert_type_has(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "var/log/rtp-watch").mkdir(parents=True)
            (root / "var/log/rtp-watch/watch.log").write_text(
                f"{_iso(1)} STALL: 30.5s of silence on PJSIP/101 — the handset stopped sending\n"
            )
            (root / "var/lib/capstone-prewarm").mkdir(parents=True)
            (root / "var/lib/capstone-prewarm/prewarm.txt").write_text("Hi there.\n")
            (root / "var/lib/capstone-prewarm/status.json").write_text(json.dumps({
                "checkedAt": _iso(60), "inSync": True, "greetings": 1,
                "drift": None, "applied": False, "error": None,
            }))
            previous = voice.HOST_ROOT
            voice.HOST_ROOT = tmp
            try:
                alerts = voice.build_voice_alerts()
            finally:
                voice.HOST_ROOT = previous
        self.assertEqual({a["id"] for a in alerts},
                         {"al-voice-prewarm-stale", "al-voice-rtp-stall"})
        for alert in alerts:
            self.assertEqual(set(alert), self.ALERT_KEYS, alert["id"])
            self.assertIn(alert["severity"], ("critical", "warning", "info"))


if __name__ == "__main__":
    unittest.main()
