#!/usr/bin/env python3
"""Tests for the Termux SMS bridge — including a real round-trip through
Capstone's own `scripts/opensms_client.py`.

The phone is not needed: a stub `termux-sms-send` on PATH stands in for the
modem, so the contract (routes, auth, stat/error shape) is testable anywhere.

    python3 phone-node/test_bridge.py
"""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from test_sip_message import FakeAsterisk

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
BRIDGE = HERE / "opensms_termux_bridge.py"
KEY = "test-key-0123456789abcdef"

spec = importlib.util.spec_from_file_location("bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class StubPhone:
    """A stand-in for `termux-sms-send` that records argv and can be made to fail.

    Wired in through the bridge's documented TERMUX_SMS_SEND override so the
    same test runs on the phone, on Linux, and on a Windows dev box.
    """

    def __init__(self, tmpdir, exit_code=0, stderr=""):
        self.dir = pathlib.Path(tmpdir) / "stub-bin"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.record = pathlib.Path(tmpdir) / f"sent-{exit_code}.jsonl"
        self.script = self.dir / f"stub-sms-{exit_code}.py"
        self.script.write_text(
            "import json, sys\n"
            f"with open({str(self.record)!r}, 'a') as fh:\n"
            "    fh.write(json.dumps(sys.argv[1:]) + chr(10))\n"
            f"sys.stderr.write({stderr!r})\n"
            f"sys.exit({exit_code})\n"
        )

    def install(self):
        os.environ["TERMUX_SMS_SEND"] = json.dumps([sys.executable, str(self.script)])

    def sent(self):
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines() if line]


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="phone-node-")
        self.stub = StubPhone(self.tmp)
        self.stub.install()
        self.orig_path = os.environ["PATH"]
        self.orig_override = os.environ.get("TERMUX_SMS_SEND")
        self.srv = bridge.build_server("127.0.0.1", 0, KEY)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        os.environ["PATH"] = self.orig_path
        if self.orig_override is None:
            os.environ.pop("TERMUX_SMS_SEND", None)
        else:
            os.environ["TERMUX_SMS_SEND"] = self.orig_override
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers ---------------------------------------------------------
    def get(self, path):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=5) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def post(self, path, body, key=KEY):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(body).encode(),
            method="POST",
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    # -- tests -----------------------------------------------------------
    def test_health_is_ready_when_the_binary_exists(self):
        code, body = self.get("/health")
        self.assertEqual(code, 200)
        self.assertTrue(body["ready"])
        self.assertEqual(body["backend"], "termux")

    def test_health_is_503_without_the_binary(self):
        os.environ.pop("TERMUX_SMS_SEND", None)  # pretend this is a bare phone
        os.environ["PATH"] = os.path.join(self.tmp, "empty")
        code, body = self.get("/health")
        self.assertEqual(code, 503)
        self.assertFalse(body["ready"])
        self.assertIn("termux-sms-send", body["detail"])

    def test_send_requires_a_bearer_key(self):
        code, body = self.post("/sms/", {"number": "+15551234567", "text": "hi"}, key=None)
        self.assertEqual(code, 401)
        self.assertEqual(body["detail"], "Invalid or expired API key")
        self.assertEqual(self.stub.sent(), [])

    def test_wrong_key_is_rejected(self):
        code, _ = self.post("/sms/", {"number": "+1555", "text": "hi"}, key="nope")
        self.assertEqual(code, 401)
        self.assertEqual(self.stub.sent(), [])

    def test_send_reaches_the_phone_with_both_route_spellings(self):
        for path in ("/sms/", "/sms"):
            code, body = self.post(path, {"number": "+15551234567", "text": "hello from capstone"})
            self.assertEqual(code, 200)
            self.assertIs(body["stat"], True)
            self.assertEqual(body["transport"], "phone")
        sent = self.stub.sent()
        self.assertEqual(len(sent), 2)
        # -n <number> <text>: the body is positional, so it cannot become a flag
        self.assertEqual(sent[0], ["-n", "+15551234567", "hello from capstone"])

    def test_text_starting_with_a_dash_stays_data(self):
        code, body = self.post("/sms/", {"number": "+1555", "text": "--force delete"})
        self.assertIs(body["stat"], True)
        self.assertEqual(self.stub.sent()[0][-1], "--force delete")

    def test_a_refused_send_reports_stat_false_with_the_reason(self):
        failing = StubPhone(self.tmp, exit_code=1, stderr="SMS permission denied")
        failing.install()
        code, body = self.post("/sms/", {"number": "+1555", "text": "hi"})
        self.assertEqual(code, 200)  # OpenSMS answers 200 even on failure
        self.assertFalse(body["stat"])
        self.assertIn("SMS permission denied", body["error"])

    def test_malformed_bodies_are_rejected(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/sms/",
            data=b"not json",
            method="POST",
            headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 400)
        self.assertFalse(json.loads(ctx.exception.read())["stat"])

    def test_health_needs_no_auth(self):
        # Capstone's Settings card probes /health before any key is entered.
        code, _ = self.get("/health")
        self.assertEqual(code, 200)


class CapstoneClientRoundTrip(unittest.TestCase):
    """The repo's own client must accept this gateway unchanged."""

    def test_opensms_client_sends_through_the_bridge(self):
        tmp = tempfile.mkdtemp(prefix="phone-node-")
        try:
            StubPhone(tmp).install()
            srv = bridge.build_server("127.0.0.1", 0, KEY)
            port = srv.server_address[1]
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            env = {
                **os.environ,
                "OPENSMS_URL": f"http://127.0.0.1:{port}",
                "OPENSMS_API_KEY": KEY,
                "SMS_PROVIDER": "opensms",
            }
            # Nothing in the repo's scripts needs a .env file present when the
            # variables are already in the environment.
            check = subprocess.run(
                [sys.executable, str(REPO / "scripts" / "opensms_client.py"), "--check"],
                capture_output=True, text=True, env=env, cwd=REPO,
            )
            self.assertEqual(check.returncode, 0, check.stderr)
            resolved = json.loads(check.stdout)
            self.assertEqual(resolved["provider"], "opensms")
            self.assertTrue(resolved["configured"])
            self.assertTrue(resolved["endpoint"].endswith("/sms/"))

            sent = subprocess.run(
                [sys.executable, str(REPO / "scripts" / "opensms_client.py"),
                 "--to", "+15551234567", "--body", "round trip"],
                capture_output=True, text=True, env=env, cwd=REPO,
            )
            # A refusal must reach the client as its documented error, not a crash.
            self.assertEqual(sent.returncode, 0, sent.stderr + sent.stdout)
            self.assertIs(json.loads(sent.stdout)["stat"], True)
            srv.shutdown()
            srv.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class FallbackTest(unittest.TestCase):
    """A dead modem must fall through to the PJSIP MESSAGE path."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="phone-node-fb-")
        StubPhone(self.tmp, exit_code=1, stderr="no SIM registered").install()
        self.pbx = FakeAsterisk(password="s3cret")
        self.pbx.start()
        self.env = {
            "PJSIP_SMS_HOST": "127.0.0.1",
            "PJSIP_SMS_PORT": str(self.pbx.port),
            "PJSIP_SMS_USER": "8000",
            "PJSIP_SMS_PASSWORD": "s3cret",
            "SMS_FALLBACK": "chain",
        }
        os.environ.update(self.env)
        self.srv = bridge.build_server("127.0.0.1", 0, KEY)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.pbx.stop()
        for k in list(self.env) + ["TERMUX_SMS_SEND"]:
            os.environ.pop(k, None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def post(self, body):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/sms/",
            data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())

    def test_modem_failure_falls_back_to_pjsip(self):
        body = self.post({"number": "+15551234567", "text": "via sip"})
        self.assertIs(body["stat"], True)
        self.assertEqual(body["transport"], "pjsip")
        self.assertEqual(self.pbx.requests[-1]["body"], "via sip")
        self.assertTrue(self.pbx.requests[-1]["auth"])

    def test_fallback_can_be_disabled(self):
        os.environ["SMS_FALLBACK"] = "none"
        body = self.post({"number": "+1555", "text": "should fail"})
        self.assertIs(body["stat"], False)
        self.assertIn("no transport", body["error"])
        self.assertEqual(self.pbx.requests, [])


class InboundTest(unittest.TestCase):
    """Poll the inbox, forward each reply once, retry what failed."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="phone-node-in-"))
        self.messages = self.tmp / "inbox.json"
        self.state = self.tmp / "inbound-state.json"
        stub = self.tmp / "stub-sms-list.py"
        stub.write_text(
            "import sys\n"
            f"sys.stdout.write(open({str(self.messages)!r}).read())\n"
        )
        os.environ["TERMUX_SMS_LIST"] = json.dumps([sys.executable, str(stub)])
        self.set_inbox([self.msg("hello there", "10:00:00")])
        self.sent = []

    def tearDown(self):
        os.environ.pop("TERMUX_SMS_LIST", None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def msg(body, date, kind="inbox", number="+15551234567"):
        return {"type": kind, "number": number, "date": f"2026-10-20 {date}",
                "body": body, "sim_slot": 0}

    def set_inbox(self, rows):
        self.messages.write_text(json.dumps(rows))

    def sink_ok(self):
        def sink(url, payload, token):
            self.sent.append((url, payload, token))
            return 200
        return sink

    def poll(self, sink=None):
        return bridge.poll_once(forward_url="http://capstone.test/sms-inbound",
                                token="tok_123", state_file=str(self.state),
                                sink=sink or self.sink_ok())

    def test_first_poll_records_a_baseline_and_forwards_nothing(self):
        summary = self.poll()
        self.assertEqual(summary["forwarded"], 0)
        self.assertIn("baseline", summary["error"])
        self.assertEqual(self.sent, [])

    def test_a_new_reply_is_forwarded_exactly_once(self):
        self.poll()  # baseline
        self.set_inbox([self.msg("hello there", "10:00:00"),
                        self.msg("yes please book it", "10:02:00")])
        summary = self.poll()
        self.assertEqual(summary["forwarded"], 1)
        url, payload, token = self.sent[0]
        self.assertEqual(url, "http://capstone.test/sms-inbound")
        self.assertEqual(payload["body"], "yes please book it")
        self.assertEqual(payload["from"], "+15551234567")
        self.assertTrue(payload["id"])
        self.assertEqual(token, "tok_123")

        again = self.poll()
        self.assertEqual(again["forwarded"], 0, "a re-poll must not duplicate the reply")
        self.assertEqual(len(self.sent), 1)

    def test_a_failed_forward_is_retried(self):
        self.poll()
        self.set_inbox([self.msg("hello there", "10:00:00"),
                        self.msg("retry me", "10:03:00")])

        def broken(url, payload, token):
            raise OSError("capstone unreachable")

        first = self.poll(sink=broken)
        self.assertEqual(first["forwarded"], 0)
        self.assertEqual(first["failed"], 1)
        self.assertIn("capstone unreachable", first["error"])

        second = self.poll()
        self.assertEqual(second["forwarded"], 1, "the failed reply must be retried next cycle")
        self.assertEqual(self.sent[0][1]["body"], "retry me")

    def test_outbound_messages_are_not_forwarded_as_replies(self):
        self.poll()
        self.set_inbox([self.msg("sent by us", "10:05:00", kind="sent")])
        summary = self.poll()
        self.assertEqual(summary["forwarded"], 0)
        self.assertEqual(self.sent, [])

    def test_missing_forward_url_is_reported_not_raised(self):
        summary = bridge.poll_once(forward_url="", state_file=str(self.state), sink=self.sink_ok())
        self.assertIn("no forward URL", summary["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
