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

        # The AMI half of the check reads the container's config volume, which the
        # daemon reads too — so the fixture builds the same tree, on loopback.
        self.asterisk = self.root / (
            "var/lib/docker/volumes/qvifit87vftfxd9ejsch2vxy_asterisk-config/_data"
        )
        self.asterisk.mkdir(parents=True)
        self.write_manager()
        self.write_custom()

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

    def write_manager(self, bindaddr="127.0.0.1"):
        (self.asterisk / "manager.conf").write_text(
            "; manager.conf\n[general]\nenabled = yes\nport = 5038\n"
            f"bindaddr = {bindaddr}\nhook = manager_event_status\n\n"
            "[336166155b52dd5cdf32d0990c8c622a]\nsecret = <generated>\n"
            "deny=0.0.0.0/0.0.0.0\npermit=127.0.0.1/255.255.255.0\n"
        )

    def write_custom(self, extra=""):
        (self.asterisk / "manager_custom.conf").write_text(
            "[pbxportal]\nsecret = <generated>\n"
            "deny = 0.0.0.0/0.0.0.0\npermit = 127.0.0.1/255.255.255.255\n"
            "read = system,call\nwrite = call\n\n"
            "[ucp_events]\nsecret = <generated>\n"
            "deny = 0.0.0.0/0.0.0.0\npermit = 127.0.0.1/255.255.255.255\n" + extra
        )

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

    def test_a_pbx_host_that_lost_its_watchers_still_says_nothing_installed(self):
        for rel in (
            "usr/local/sbin/rtp-stall-watch.sh", "etc/cron.d/rtp-stall-watch",
            "usr/local/sbin/prewarm-watch.sh", "etc/cron.d/prewarm-watch",
            "var/lib/capstone-prewarm/status.json",
        ):
            (self.root / rel).unlink()
        code, out = self.run_check()
        self.assertEqual(code, 2, out)
        self.assertIn("nothing installed", out)
        self.assertIn("AMI bound to loopback", out, "the AMI checks still run and report")

    def test_a_broken_ami_outranks_nothing_installed(self):
        for rel in (
            "usr/local/sbin/rtp-stall-watch.sh", "etc/cron.d/rtp-stall-watch",
            "usr/local/sbin/prewarm-watch.sh", "etc/cron.d/prewarm-watch",
            "var/lib/capstone-prewarm/status.json",
        ):
            (self.root / rel).unlink()
        self.write_manager(bindaddr="0.0.0.0")
        code, out = self.run_check()
        self.assertEqual(code, 1, out)

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

    # ── AMI stays on loopback, and didtest stays gone ───────────────────────

    def test_ami_on_loopback_passes(self):
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn("AMI bound to loopback", out)
        self.assertIn("3 account(s), all on 127.0.0.1", out)

    def test_ami_with_a_lan_bindaddr_fails(self):
        self.write_manager(bindaddr="0.0.0.0")
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("bindaddr = 0.0.0.0", out)

    def test_a_retired_account_that_came_back_fails(self):
        self.write_custom("\n[didtest]\nsecret = <generated>\n"
                          "read = system,call\npermit = 192.168.1.113/255.255.255.255\n")
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("[didtest] is back in manager_custom.conf", out)

    def test_an_account_that_permits_the_lan_fails(self):
        self.write_custom("\n[didharness]\nsecret = <generated>\n"
                          "deny = 0.0.0.0/0.0.0.0\npermit = 192.168.1.113/255.255.255.255\n")
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("[didharness] in manager_custom.conf permits 192.168.1.113", out)

    def test_an_account_without_a_permit_line_fails(self):
        self.write_custom("\n[openami]\nsecret = <generated>\n")
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("[openami] in manager_custom.conf has no permit line", out)

    def test_a_host_without_the_pbx_volume_skips_the_ami_checks(self):
        import shutil

        shutil.rmtree(self.root / "var/lib/docker")
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn("no asterisk-config volume on this host", out)


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
