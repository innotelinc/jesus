#!/usr/bin/env python3
"""Unit tests for app/sms_inbound.py and its two routes.

The phone posts replies with a shared secret, not a session, so these tests pin
the parts that make that safe: the route is closed when no secret is
configured, a wrong secret is rejected, a retry is deduplicated by id, and the
secret never appears in a response.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import sms_inbound  # noqa: E402

try:  # pragma: no cover - depends on the environment
    from fastapi.testclient import TestClient

    from app import main

    _HAVE_DEPS = True
except Exception:  # noqa: BLE001 - any import failure means the deps are absent
    _HAVE_DEPS = False


TOKEN = "inbound-secret-0123456789abcdef"


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "sms-inbound.jsonl")
        patcher = mock.patch.dict(os.environ, {sms_inbound.STATE_ENV: self.state})
        patcher.start()
        self.addCleanup(patcher.stop)

    def msg(self, body="yes, book it", mid="abc123"):
        return {"id": mid, "from": "+15551234567", "body": body,
                "received_at": "2026-10-20 10:02:00", "sim": 0}

    def test_store_then_read_back(self):
        result = sms_inbound.store(self.msg())
        self.assertTrue(result["stored"])
        rows = sms_inbound.recent(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["body"], "yes, book it")
        self.assertEqual(rows[0]["from"], "+15551234567")

    def test_retry_is_deduplicated_by_id(self):
        first = sms_inbound.store(self.msg())
        second = sms_inbound.store(self.msg())
        self.assertTrue(first["stored"])
        self.assertFalse(second["stored"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(len(sms_inbound.recent(10)), 1)

    def test_message_without_body_or_sender_is_refused(self):
        with self.assertRaises(ValueError):
            sms_inbound.store({"id": "x", "from": "+1555"})
        with self.assertRaises(ValueError):
            sms_inbound.store({"id": "x", "body": "hi"})

    def test_long_body_is_truncated_not_rejected(self):
        sms_inbound.store(self.msg(body="x" * 9000))
        self.assertEqual(len(sms_inbound.recent(1)[0]["body"]), sms_inbound.MAX_BODY_CHARS)

    def test_enabled_requires_a_token(self):
        with mock.patch.dict(os.environ, {sms_inbound.TOKEN_ENV: ""}):
            self.assertFalse(sms_inbound.enabled())
            self.assertFalse(sms_inbound.authorised(""))
        with mock.patch.dict(os.environ, {sms_inbound.TOKEN_ENV: TOKEN}):
            self.assertTrue(sms_inbound.enabled())
            self.assertTrue(sms_inbound.authorised(TOKEN))
            self.assertFalse(sms_inbound.authorised("wrong"))


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed")
class RouteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        state = os.path.join(self.tmp.name, "sms-inbound.jsonl")
        self.env = mock.patch.dict(os.environ, {sms_inbound.STATE_ENV: state,
                                                sms_inbound.TOKEN_ENV: TOKEN})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(main.app)
        self.payload = {"id": "m1", "from": "+15551234567",
                        "body": "yes please", "received_at": "2026-10-20 10:02:00"}

    def post(self, token=TOKEN, **kwargs):
        headers = {"X-Capstone-SMS-Token": token} if token else {}
        return self.client.post("/sms-inbound", json=kwargs.get("payload", self.payload),
                                headers=headers)

    def test_post_stores_and_retry_is_idempotent(self):
        first = self.post()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["stored"])
        again = self.post()
        self.assertEqual(again.status_code, 200)
        self.assertFalse(again.json()["stored"])

    def test_wrong_token_is_401(self):
        self.assertEqual(self.post(token="nope").status_code, 401)
        self.assertEqual(self.post(token=None).status_code, 401)

    def test_a_bearer_token_is_also_accepted(self):
        res = self.client.post("/sms-inbound", json=self.payload,
                               headers={"Authorization": f"Bearer {TOKEN}"})
        self.assertEqual(res.status_code, 200, res.text)

    def test_route_is_closed_when_no_secret_is_configured(self):
        with mock.patch.dict(os.environ, {sms_inbound.TOKEN_ENV: ""}):
            self.assertEqual(self.post().status_code, 503)

    def test_incomplete_message_is_422(self):
        self.assertEqual(self.post(payload={"id": "x"}).status_code, 422)

    def test_get_lists_replies_without_leaking_the_token(self):
        self.post()
        res = self.client.get("/sms-inbound?limit=10")
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertTrue(body["token_set"])
        self.assertNotIn(TOKEN, res.text)
        self.assertEqual(body["messages"][-1]["body"], "yes please")


if __name__ == "__main__":
    unittest.main(verbosity=2)
