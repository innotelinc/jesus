#!/usr/bin/env python3
"""End-to-end: a new SMS on the phone appears in Capstone, and is answered.

This starts the real dashboard API (uvicorn, app.main) on a loopback port,
points the phone's poller at its /sms-inbound route, and asserts the reply
survives the trip — auth, dedupe, and storage included. The outbound half is
proven the same way: the Control Center's /sms-outbound is asked to answer, a
stub gateway on loopback plays the phone, and both halves must end up in one
thread. Neither side needs a modem.

    python3 phone-node/test_e2e_inbound.py

Skips (exit 0) when uvicorn is not installed.
"""

import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
TOKEN = "e2e-inbound-token-0123456789abcdef"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class StubGateway:
    """The phone node's `/sms/` contract, served on loopback."""

    def __init__(self):
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - http.server's name
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else ""
                stub.requests.append({"path": self.path,
                                      "auth": self.headers.get("Authorization"),
                                      "body": json.loads(raw) if raw else None})
                encoded = b'{"stat": true, "transport": "modem"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


def wait_for_http(url, timeout=45):
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                return r.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except (urllib.error.URLError, OSError) as exc:
            last = str(exc)
        time.sleep(0.4)
    raise RuntimeError(f"API did not answer at {url}: {last}")


class InboundEndToEnd(unittest.TestCase):
    def setUp(self):
        try:
            import uvicorn  # noqa: F401
        except ImportError:
            self.skipTest("uvicorn not installed")

        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="capstone-e2e-"))
        self.state = self.tmp / "sms-inbound.jsonl"
        self.inbox = self.tmp / "inbox.json"
        self.port = free_port()

        stub = self.tmp / "stub-sms-list.py"
        stub.write_text(
            "import sys\n"
            f"sys.stdout.write(open({str(self.inbox)!r}).read())\n"
        )
        self.gateway = StubGateway().__enter__()
        self.addCleanup(self.gateway.__exit__)
        self.env = {
            **os.environ,
            "CAPSTONE_SMS_INBOUND_STATE": str(self.state),
            "CAPSTONE_SMS_INBOUND_TOKEN": TOKEN,
            "TERMUX_SMS_LIST": json.dumps([sys.executable, str(stub)]),
            "INBOUND_STATE": str(self.tmp / "inbound-state.json"),
            "OPENSMS_URL": self.gateway.url,
            "OPENSMS_API_KEY": "e2e-gateway-key-0123456789",
        }
        self.write_inbox([self.msg("hello there", "10:00:00")])
        # poll_once runs in-process, so the stub must be in os.environ too.
        patcher = mock.patch.dict(os.environ, {
            "TERMUX_SMS_LIST": self.env["TERMUX_SMS_LIST"],
            "INBOUND_STATE": self.env["INBOUND_STATE"],
        })
        patcher.start()
        self.addCleanup(patcher.stop)
        self.api = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app",
             "--host", "127.0.0.1", "--port", str(self.port), "--log-level", "warning"],
            cwd=str(REPO / "dashboard-backend"), env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        wait_for_http(f"http://127.0.0.1:{self.port}/openapi.json")

    def tearDown(self):
        proc = getattr(self, "api", None)
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def msg(body, date, kind="inbox", number="+15551234567"):
        return {"type": kind, "number": number, "date": f"2026-10-20 {date}",
                "body": body, "sim_slot": 0}

    def write_inbox(self, rows):
        self.inbox.write_text(json.dumps(rows))

    def poll(self):
        # Import here so the stub env is already in place.
        sys.path.insert(0, str(HERE))
        import opensms_termux_bridge as bridge
        return bridge.poll_once(
            forward_url=f"http://127.0.0.1:{self.port}/sms-inbound",
            token=TOKEN,
            state_file=self.env["INBOUND_STATE"],
        )

    def replies(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/sms-inbound?limit=10", timeout=5) as r:
            return json.loads(r.read())

    def test_a_new_reply_reaches_capstone_once(self):
        first = self.poll()  # baseline: existing inbox is adopted, not forwarded
        self.assertEqual(first["forwarded"], 0)
        self.assertIn("baseline", first["error"])

        self.write_inbox([self.msg("hello there", "10:00:00"),
                          self.msg("yes, Tuesday works", "10:02:00")])
        second = self.poll()
        self.assertEqual(second["forwarded"], 1, second)

        stored = self.replies()
        self.assertEqual(stored["messages"][-1]["body"], "yes, Tuesday works")
        self.assertEqual(stored["messages"][-1]["from"], "+15551234567")

        third = self.poll()
        self.assertEqual(third["forwarded"], 0, "a re-poll must not duplicate the reply")
        self.assertEqual(len(self.replies()["messages"]), 1)

    def reply(self, to, body):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/sms-outbound",
            data=json.dumps({"to": to, "body": body}).encode(),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def test_an_inbound_reply_can_be_answered_through_the_phone(self):
        self.poll()  # baseline
        self.write_inbox([self.msg("can I book Thursday?", "10:00:00")])
        self.assertEqual(self.poll()["forwarded"], 1)

        result = self.reply("+15551234567", "yes, 3pm Thursday")
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["recorded"], result)

        # The stub is the phone: it must have been asked for the right number,
        # with the gateway's own payload shape, on the route the app serves.
        self.assertEqual(len(self.gateway.requests), 1)
        sent = self.gateway.requests[0]
        self.assertEqual(sent["path"], "/sms/")
        self.assertEqual(sent["body"], {"number": "+15551234567", "text": "yes, 3pm Thursday"})

        messages = self.replies()["messages"]
        self.assertEqual([m["direction"] for m in messages], ["in", "out"])
        self.assertEqual(messages[0]["body"], "can I book Thursday?")
        self.assertEqual(messages[1]["body"], "yes, 3pm Thursday")

    def test_wrong_token_is_rejected_by_the_live_route(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/sms-inbound",
            data=json.dumps(self.msg("x", "10:00:00")).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-Capstone-SMS-Token": "wrong"},
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
