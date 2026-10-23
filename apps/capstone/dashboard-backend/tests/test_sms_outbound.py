#!/usr/bin/env python3
"""Tests for app/sms_outbound.py and its route.

A reply is the one SMS path a person drives, so these pin the whole exchange:
the gateway's own contract (Bearer key, `{"stat": true}`), the failure shapes
the phone produces (HTTP 401, `stat: false`, unreachable), and the fact that a
sent answer lands in the same log as the reply it answers.

The gateway is a local HTTP stub — no phone, no modem, no Docker.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import sms_inbound, sms_outbound  # noqa: E402

try:  # pragma: no cover - depends on the environment
    from fastapi.testclient import TestClient

    from app import main

    _HAVE_DEPS = True
except Exception:  # noqa: BLE001 - any import failure means the deps are absent
    _HAVE_DEPS = False


KEY = "gateway-key-0123456789"


class StubGateway:
    """A phone node that records what it was asked to send."""

    def __init__(self, *, status=200, payload=None):
        self.requests = []
        self.status = status
        self.payload = {"stat": True, "transport": "modem"} if payload is None else payload
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - http.server's name
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else ""
                stub.requests.append({
                    "path": self.path,
                    "auth": self.headers.get("Authorization"),
                    "body": json.loads(raw) if raw else None,
                })
                encoded = json.dumps(stub.payload).encode("utf-8")
                self.send_response(stub.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *args):  # keep the test output clean
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


class EndpointTest(unittest.TestCase):
    def test_root_and_sms_suffix_both_reach_the_route(self):
        self.assertEqual(sms_outbound.endpoint("http://phone:9292"), "http://phone:9292/sms/")
        self.assertEqual(sms_outbound.endpoint("http://phone:9292/"), "http://phone:9292/sms/")
        self.assertEqual(sms_outbound.endpoint("http://phone:9292/sms"), "http://phone:9292/sms/")
        with self.assertRaises(sms_outbound.SmsNotConfigured):
            sms_outbound.endpoint("phone:9292")

    def test_numbers_are_normalised_and_rejected(self):
        self.assertEqual(sms_outbound.normalise_number("+1 (555) 123-4567"), "+15551234567")
        self.assertEqual(sms_outbound.normalise_number("15551234567"), "+15551234567")
        for bad in ("", "123", "not a number", "+0 555 123 4567"):
            with self.assertRaises(ValueError):
                sms_outbound.normalise_number(bad)


class SendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "sms-inbound.jsonl")
        self.env = mock.patch.dict(os.environ, {
            sms_inbound.STATE_ENV: self.state,
            "OPENSMS_API_KEY": KEY,
            "OPENSMS_TIMEOUT_MS": "3000",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def point_at(self, url):
        patcher = mock.patch.dict(os.environ, {"OPENSMS_URL": url})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_send_posts_the_contract_and_is_recorded(self):
        with StubGateway() as gateway:
            self.point_at(gateway.url)
            result = sms_outbound.send("+1 555 123 4567", "  see you at 3  ")

        self.assertTrue(result["ok"])
        self.assertEqual(result["to"], "+15551234567")
        self.assertEqual(result["transport"], "modem")
        self.assertEqual(len(gateway.requests), 1)
        sent = gateway.requests[0]
        self.assertEqual(sent["path"], "/sms/")
        self.assertEqual(sent["auth"], f"Bearer {KEY}")
        self.assertEqual(sent["body"], {"number": "+15551234567", "text": "see you at 3"})

        rows = sms_inbound.recent(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["direction"], "out")
        self.assertEqual(rows[0]["to"], "+15551234567")
        self.assertEqual(rows[0]["body"], "see you at 3")
        self.assertEqual(rows[0]["transport"], "modem")
        self.assertEqual(sms_inbound.peer(rows[0]), "+15551234567")

    def test_stat_false_is_a_failure_with_the_phones_reason(self):
        with StubGateway(payload={"stat": False, "error": "no SIM in the modem"}) as gateway:
            self.point_at(gateway.url)
            with self.assertRaises(sms_outbound.SmsSendError) as caught:
                sms_outbound.send("+15551234567", "hello")
        self.assertIn("no SIM in the modem", str(caught.exception))
        self.assertEqual(sms_inbound.recent(10), [])

    def test_http_error_carries_the_status_and_a_key_hint(self):
        with StubGateway(status=401, payload={"detail": "bad key"}) as gateway:
            self.point_at(gateway.url)
            with self.assertRaises(sms_outbound.SmsSendError) as caught:
                sms_outbound.send("+15551234567", "hello")
        message = str(caught.exception)
        self.assertIn("HTTP 401", message)
        self.assertIn("OPENSMS_API_KEY", message)
        self.assertIn("bad key", message)

    def test_unreachable_gateway_says_so(self):
        self.point_at("http://127.0.0.1:9")  # discard port: nothing listens
        with self.assertRaises(sms_outbound.SmsSendError) as caught:
            sms_outbound.send("+15551234567", "hello")
        self.assertIn("unreachable", str(caught.exception))

    def test_unconfigured_gateway_is_refused_before_the_network(self):
        with mock.patch.dict(os.environ, {"OPENSMS_URL": "", "OPENSMS_API_KEY": ""}):
            with self.assertRaises(sms_outbound.SmsNotConfigured):
                sms_outbound.send("+15551234567", "hello")

    def test_empty_and_oversized_bodies_are_refused(self):
        with StubGateway() as gateway:
            self.point_at(gateway.url)
            with self.assertRaises(ValueError):
                sms_outbound.send("+15551234567", "   ")
            with self.assertRaises(ValueError):
                sms_outbound.send("+15551234567", "x" * (sms_outbound.MAX_BODY_CHARS + 1))
            self.assertEqual(gateway.requests, [])

    def test_a_read_only_state_does_not_fail_a_delivered_reply(self):
        with StubGateway() as gateway:
            self.point_at(gateway.url)
            with mock.patch.object(sms_inbound, "_append", side_effect=OSError("read-only")):
                self.assertIsNone(sms_inbound.record_outbound("+15551234567", "hello"))
            self.assertTrue(sms_outbound.send("+15551234567", "hello")["ok"])


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed")
class RouteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        state = os.path.join(self.tmp.name, "sms-inbound.jsonl")
        self.env = mock.patch.dict(os.environ, {
            sms_inbound.STATE_ENV: state,
            sms_inbound.TOKEN_ENV: "phone-secret",
            "OPENSMS_API_KEY": KEY,
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(main.app)

    def point_at(self, url):
        patcher = mock.patch.dict(os.environ, {"OPENSMS_URL": url})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_reply_lands_in_the_same_thread_as_the_message_it_answers(self):
        self.client.post("/sms-inbound",
                         json={"id": "m1", "from": "+15551234567", "body": "can I book?",
                               "received_at": "2026-10-20 10:02:00"},
                         headers={"X-Capstone-SMS-Token": "phone-secret"})
        with StubGateway() as gateway:
            self.point_at(gateway.url)
            res = self.client.post("/sms-outbound",
                                   json={"to": "+15551234567", "body": "yes, 3pm works"})

        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(res.json()["ok"])
        self.assertTrue(res.json()["recorded"])

        inbox = self.client.get("/sms-inbound?limit=10").json()
        self.assertEqual([m["direction"] for m in inbox["messages"]], ["in", "out"])
        self.assertEqual(inbox["messages"][1]["body"], "yes, 3pm works")

    def test_a_failed_send_is_502_and_records_nothing(self):
        with StubGateway(payload={"stat": False, "error": "no credit"}) as gateway:
            self.point_at(gateway.url)
            res = self.client.post("/sms-outbound",
                                   json={"to": "+15551234567", "body": "hello"})
        self.assertEqual(res.status_code, 502, res.text)
        self.assertIn("no credit", res.json()["detail"])
        self.assertEqual(self.client.get("/sms-inbound").json()["messages"], [])

    def test_unconfigured_gateway_is_503(self):
        with mock.patch.dict(os.environ, {"OPENSMS_URL": "", "OPENSMS_API_KEY": ""}):
            res = self.client.post("/sms-outbound",
                                   json={"to": "+15551234567", "body": "hello"})
        self.assertEqual(res.status_code, 503, res.text)

    def test_bad_number_and_empty_body_are_422(self):
        with StubGateway() as gateway:
            self.point_at(gateway.url)
            bad_to = self.client.post("/sms-outbound", json={"to": "123", "body": "hi"})
            empty = self.client.post("/sms-outbound",
                                     json={"to": "+15551234567", "body": " "})
            too_long = self.client.post("/sms-outbound",
                                        json={"to": "+15551234567",
                                              "body": "x" * (sms_outbound.MAX_BODY_CHARS + 1)})
        for res in (bad_to, empty, too_long):
            self.assertEqual(res.status_code, 422, res.text)

    def test_the_route_never_returns_the_gateway_key(self):
        with StubGateway() as gateway:
            self.point_at(gateway.url)
            res = self.client.post("/sms-outbound",
                                   json={"to": "+15551234567", "body": "hello"})
        self.assertNotIn(KEY, res.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
