#!/usr/bin/env python3
"""Unit tests for app/sms_transport.py and its two routes.

The Settings card writes a host state file; scripts/opensms_client.py reads the
same file. These tests pin the precedence that makes that safe (real env >
saved choice > .env seed), the 0600 write, and the fact that the OpenSMS key
never reaches the browser.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import io
import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import sms_transport  # noqa: E402

try:  # pragma: no cover - depends on the environment
    from fastapi.testclient import TestClient

    from app import main

    _HAVE_DEPS = True
except Exception:  # noqa: BLE001 - any import failure means the deps are absent
    _HAVE_DEPS = False


class TransportTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        sms_transport._health_cache.clear()
        self.addCleanup(sms_transport._health_cache.clear)
        self.env_file = os.path.join(self.tmp.name, ".env")
        self.state_file = os.path.join(self.tmp.name, "sms-transport")
        self.write_env("OPENSMS_URL=http://192.168.1.50:9292\nOPENSMS_API_KEY=osms_secret\n"
                       "ZEUS_API_URL=https://api.zeus.test\nZEUS_SESSION_TOKEN=tok\n")
        patcher = mock.patch.dict(
            os.environ,
            {
                "CAPSTONE_SMS_TRANSPORT_STATE": self.state_file,
                "CAPSTONE_ENV_FILE": self.env_file,
            },
            clear=True,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_env(self, text):
        with open(self.env_file, "w", encoding="utf-8") as fh:
            fh.write(text)

    def write_state(self, text):
        with open(self.state_file, "w", encoding="utf-8") as fh:
            fh.write(text)


class NormalizeTest(unittest.TestCase):
    def test_operator_vocabulary_and_native_names(self):
        self.assertEqual(sms_transport.normalize("provider"), "zeus")
        self.assertEqual(sms_transport.normalize("local"), "opensms")
        self.assertEqual(sms_transport.normalize("AUTO"), "auto")
        self.assertEqual(sms_transport.normalize("opensms"), "opensms")
        self.assertEqual(sms_transport.normalize("zeus"), "zeus")

    def test_unknown_is_empty(self):
        for value in ("", None, "carrier-pigeon", 7):
            self.assertEqual(sms_transport.normalize(value), "")


class StateTest(TransportTestBase):
    def test_save_writes_the_native_name_privately(self):
        saved = sms_transport.save("local")
        self.assertEqual(saved["transport"], "opensms")
        self.assertEqual(saved["source"], "state")
        self.assertTrue(saved["saved"])
        with open(self.state_file, encoding="utf-8") as fh:
            self.assertEqual(fh.read().strip(), "opensms")
        mode = stat.S_IMODE(os.stat(self.state_file).st_mode)
        self.assertEqual(mode, 0o600)

    def test_save_rejects_anything_else(self):
        with self.assertRaises(ValueError):
            sms_transport.save("trunk")

    def test_snapshot_never_contains_the_key(self):
        payload = json.dumps(sms_transport.snapshot())
        self.assertNotIn("osms_secret", payload)
        self.assertIn("http://192.168.1.50:9292", payload)

    def test_availability_reads_env_file(self):
        state = sms_transport.snapshot()
        self.assertTrue(state["opensms"]["configured"])
        self.assertTrue(state["zeus"]["configured"])
        self.write_env("OPENSMS_URL=http://192.168.1.50:9292\n")
        state = sms_transport.snapshot()
        self.assertFalse(state["opensms"]["configured"])

    def test_state_file_is_ignored_when_unreadable_or_invalid(self):
        self.write_state("carrier-pigeon\n")
        self.assertEqual(sms_transport.stored(), "")


class FakeHealthResponse:
    def __init__(self, body: bytes, status: int = 200):
        self.body = body
        self.status = status

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class GatewayHealthTest(TransportTestBase):
    @mock.patch.object(sms_transport.urllib.request, "urlopen")
    def test_ready_modem_is_reported(self, m_url):
        m_url.return_value = FakeHealthResponse(
            b'{"ok": true, "backend": "modemmanager", "signal": 63, "operator": "FakeTel"}')
        health = sms_transport.gateway_health()
        self.assertTrue(health["ok"])
        self.assertEqual(health["backend"], "modemmanager")
        self.assertEqual(health["signal"], 63)
        self.assertEqual(m_url.call_args[0][0], "http://192.168.1.50:9292/health")

    @mock.patch.object(sms_transport.urllib.request, "urlopen")
    def test_503_reason_is_carried(self, m_url):
        m_url.side_effect = urllib.error.HTTPError(
            "http://192.168.1.50:9292/health", 503, "Service Unavailable", {},
            io.BytesIO(b'{"ok": false, "detail": "no SMS modem found"}'))
        health = sms_transport.gateway_health()
        self.assertFalse(health["ok"])
        self.assertIn("no SMS modem found", health["detail"])

    @mock.patch.object(sms_transport.urllib.request, "urlopen")
    def test_unreachable_gateway_is_reported(self, m_url):
        m_url.side_effect = urllib.error.URLError("Connection refused")
        health = sms_transport.gateway_health()
        self.assertFalse(health["ok"])
        self.assertIn("unreachable", health["detail"])

    def test_missing_url_is_a_reason_not_an_exception(self):
        self.write_env("")
        self.assertIn("OPENSMS_URL", sms_transport.gateway_health()["detail"])

    @mock.patch.object(sms_transport.urllib.request, "urlopen")
    def test_answer_is_cached_briefly(self, m_url):
        m_url.return_value = FakeHealthResponse(b'{"ok": true}')
        sms_transport.gateway_health()
        sms_transport.gateway_health()
        self.assertEqual(m_url.call_count, 1)
        # A forced refresh (ttl=0) goes back to the gateway.
        sms_transport.gateway_health(ttl=0)
        self.assertEqual(m_url.call_count, 2)


class PrecedenceTest(TransportTestBase):
    def test_dotenv_seeds_when_nothing_is_saved(self):
        self.write_env("SMS_PROVIDER=local\n")
        self.assertEqual(sms_transport.effective(), ("opensms", "dotenv"))

    def test_saved_choice_beats_the_dotenv_seed(self):
        self.write_env("SMS_PROVIDER=local\n")
        self.write_state("zeus\n")
        self.assertEqual(sms_transport.effective(), ("zeus", "state"))

    def test_real_environment_beats_the_saved_choice(self):
        self.write_state("zeus\n")
        os.environ["SMS_PROVIDER"] = "auto"
        self.assertEqual(sms_transport.effective(), ("auto", "env"))

    def test_default_is_provider(self):
        self.assertEqual(sms_transport.effective(), ("zeus", "default"))


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed — skipping route tests")
class RoutesTest(TransportTestBase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.dict(
            main.app.dependency_overrides,
            {main.require_session: lambda: {"email": "ops@test", "role": "admin"}},
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(main.app)

    def test_get_reports_the_choice_and_availability(self):
        response = self.client.get("/sms-transport")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["transport"], "zeus")
        self.assertEqual(body["source"], "default")
        self.assertTrue(body["opensms"]["configured"])

    def test_post_records_and_returns_the_new_state(self):
        response = self.client.post("/sms-transport", json={"transport": "local"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["transport"], "opensms")
        self.assertEqual(response.json()["source"], "state")
        self.assertEqual(self.client.get("/sms-transport").json()["transport"], "opensms")

    def test_post_rejects_an_unknown_transport(self):
        response = self.client.post("/sms-transport", json={"transport": "smoke-signal"})
        self.assertEqual(response.status_code, 422)

    def test_gateway_route_returns_health(self):
        with mock.patch.object(
            sms_transport, "gateway_health",
            return_value={"ok": True, "backend": "serial", "detail": ""},
        ):
            body = self.client.get("/sms-gateway").json()
        self.assertTrue(body["configured"])
        self.assertEqual(body["url"], "http://192.168.1.50:9292")
        self.assertTrue(body["health"]["ok"])

    def test_gateway_route_without_a_url(self):
        self.write_env("OPENSMS_API_KEY=osms_secret\n")
        body = self.client.get("/sms-gateway").json()
        self.assertFalse(body["configured"])
        self.assertIn("OPENSMS_URL", body["health"]["detail"])


if __name__ == "__main__":
    unittest.main()
