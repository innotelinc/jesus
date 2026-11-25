#!/usr/bin/env python3
"""Tests for scripts/voice_check.py — the deploy/smoke gate for the voice watchers.

The whole reason this checker exists is that a dead watcher and a quiet estate
look identical. So the tests are written the same way: a fixture that is healthy
must pass, and each way of being silently broken — no cron, a stale status, an
SMS push that is configured but failing — must fail with a reason that names the
thing to fix. "Nothing installed" is its own answer (exit 2), not a failure,
because a host that never had the watchers should not page anyone.

Run:  python3 -m unittest discover -s scripts/tests -v
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import voice_check  # noqa: E402


class _VoiceApi(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - http.server's spelling
        payload = json.dumps(self.server.payload).encode()
        self.send_response(self.server.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class VoiceCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for rel in (
            "usr/local/sbin", "etc/cron.d",
            "var/log/rtp-watch", "var/lib/capstone-prewarm",
        ):
            (self.root / rel).mkdir(parents=True)

        self.watcher = self.root / "usr/local/sbin/rtp-stall-watch.sh"
        self.watcher.write_text("#!/bin/bash\n")
        (self.root / "etc/cron.d/rtp-stall-watch").write_text("*/1 * * * * root true\n")
        (self.root / "usr/local/sbin/prewarm-watch.sh").write_text("#!/bin/bash\n")
        (self.root / "etc/cron.d/prewarm-watch").write_text("*/5 * * * * root true\n")
        self.status = self.root / "var/lib/capstone-prewarm/status.json"
        self.log = self.root / "var/log/rtp-watch/watch.log"

        self.write_status()
        self.write_log(
            "2026-11-25T01:51:10-05:00 VERDICT: no-media — no RTP was captured, so this "
            "call settles nothing — /var/log/rtp-watch/call-1.pcap"
        )

        self.saved = {k: os.environ.get(k) for k in ("VOICE_ALERT_SMS_TO",)}

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    # ── fixtures ────────────────────────────────────────────────────────────

    def write_status(self, **overrides):
        from datetime import datetime, timezone

        payload = {
            "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "inSync": True, "greetings": 2, "drift": None, "applied": False, "error": None,
        }
        payload.update(overrides)
        self.status.write_text(json.dumps(payload))

    def write_log(self, *lines):
        self.log.write_text("\n".join(lines) + "\n")

    def run_check(self, api=""):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = voice_check.main(["--root", str(self.root), "--api", api])
        return code, out.getvalue()

    # ── the healthy case ────────────────────────────────────────────────────

    def test_a_healthy_host_passes(self):
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn("every installed watcher is alive", out)

    def test_the_verdict_on_record_is_reported_but_not_judged(self):
        code, out = self.run_check()
        self.assertEqual(code, 0)
        self.assertIn("1 verdict(s)", out, "a pending question is information, not a failure")

    # ── silent failures ─────────────────────────────────────────────────────

    def test_a_watcher_without_cron_fails_because_nothing_runs_it(self):
        (self.root / "etc/cron.d/rtp-stall-watch").unlink()
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("nothing runs it", out)

    def test_a_watcher_that_never_wrote_a_log_fails(self):
        self.log.unlink()
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("installed but never ran", out)

    def test_a_status_older_than_the_window_fails(self):
        from datetime import datetime, timedelta, timezone

        old = (datetime.now(timezone.utc) - timedelta(minutes=45)).isoformat(timespec="seconds")
        self.write_status(checkedAt=old)
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("prewarm check is recent", out)

    def test_a_drifted_list_fails_with_the_drift(self):
        self.write_status(inSync=False, drift="missing: Hi Dana, this is Jordan.")
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("missing: Hi Dana", out)

    def test_an_unreadable_status_fails(self):
        self.status.write_text("{not json")
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("prewarm status readable", out)

    def test_nothing_installed_is_its_own_answer(self):
        for rel in (
            "usr/local/sbin/rtp-stall-watch.sh", "etc/cron.d/rtp-stall-watch",
            "usr/local/sbin/prewarm-watch.sh", "etc/cron.d/prewarm-watch",
            "var/lib/capstone-prewarm/status.json",
        ):
            (self.root / rel).unlink()
        code, out = self.run_check()
        self.assertEqual(code, 2, f"a host without the watchers must not be a failure: {out}")
        self.assertIn("nothing installed", out)

    # ── the Control Center's own view ───────────────────────────────────────

    def serve_api(self, payload, status=200):
        server = HTTPServer(("127.0.0.1", 0), _VoiceApi)
        server.payload = payload
        server.status = status
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def api_payload(self, **overrides):
        payload = {
            "ok": True,
            "media": {"question": "pending", "lastVerdict": {"cause": "no-media"}},
            "push": {"configured": False, "to": "", "provider": "zeus", "gateway": "opensms",
                     "sent": 0, "lastError": None},
        }
        payload.update(overrides)
        return payload

    def test_the_api_reporting_no_host_access_fails(self):
        api = self.serve_api(self.api_payload(ok=False))
        code, out = self.run_check(api)
        self.assertEqual(code, 1, out)
        self.assertIn("/host mounts", out)

    def test_a_recipient_without_a_configured_push_fails(self):
        os.environ["VOICE_ALERT_SMS_TO"] = "+15551234567"
        api = self.serve_api(self.api_payload())
        code, out = self.run_check(api)
        self.assertEqual(code, 1, out)
        self.assertIn("OPENSMS_URL", out)

    def test_a_configured_push_that_is_erroring_fails(self):
        os.environ["VOICE_ALERT_SMS_TO"] = "+15551234567"
        api = self.serve_api(self.api_payload(
            push={"configured": True, "to": "…4567", "provider": "opensms",
                  "gateway": "opensms", "sent": 2, "lastError": "HTTP 500 — modem refused"}))
        code, out = self.run_check(api)
        self.assertEqual(code, 1, out)
        self.assertIn("modem refused", out)

    def test_a_working_push_passes(self):
        os.environ["VOICE_ALERT_SMS_TO"] = "+15551234567"
        api = self.serve_api(self.api_payload(
            push={"configured": True, "to": "…4567", "provider": "opensms",
                  "gateway": "opensms", "sent": 3, "lastError": None},
            media={"question": "settled", "lastVerdict": {"cause": "continuous"}}))
        code, out = self.run_check(api)
        self.assertEqual(code, 0, out)
        self.assertIn("SMS push", out)
        self.assertIn("to …4567", out)

    def test_the_api_being_unreachable_is_a_failure_not_a_pass(self):
        code, out = self.run_check("http://127.0.0.1:1")
        self.assertEqual(code, 1, out)
        self.assertIn("Control Center /voice", out)


if __name__ == "__main__":
    unittest.main()
