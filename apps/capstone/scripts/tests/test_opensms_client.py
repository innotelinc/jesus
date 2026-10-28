#!/usr/bin/env python3
"""Unit tests for scripts/opensms_client.py — the OpenSMS gateway client.

Run:  python3 -m unittest discover -s scripts/tests -v

Everything is mocked at urllib.request.urlopen — no network, no phone, no .env.
"""

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import opensms_client  # noqa: E402

BASE = "http://192.168.1.50:9292"


class FakeResponse:
    def __init__(self, status=200, body=b"{}"):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def make_client(**kwargs):
    kwargs.setdefault("api_key", "osms_test_key")
    return opensms_client.OpenSMSClient(BASE, **kwargs)


def header(req, name):
    """Case-insensitive request-header lookup (urllib lowercases stored keys)."""
    return {k.lower(): v for k, v in req.headers.items()}.get(name.lower())


def captured_request(mock_urlopen):
    mock_urlopen.assert_called_once()
    return mock_urlopen.call_args[0][0]


class EndpointTest(unittest.TestCase):
    def test_root_gets_the_sms_route(self):
        for base in (BASE, BASE + "/"):
            self.assertEqual(opensms_client.endpoint(base), BASE + "/sms/")

    def test_sms_suffix_is_not_doubled(self):
        for base in (BASE + "/sms", BASE + "/sms/"):
            self.assertEqual(opensms_client.endpoint(base), BASE + "/sms/")

    def test_non_http_url_is_refused(self):
        with self.assertRaises(opensms_client.OpenSMSError):
            opensms_client.endpoint("192.168.1.50:9292")


class SendTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_bearer_and_json_payload(self, m_url):
        m_url.return_value = FakeResponse(200, b'{"stat": true}')
        payload = make_client().send_sms("+15551234567", "hello")

        req = captured_request(m_url)
        self.assertEqual(req.full_url, BASE + "/sms/")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(header(req, "Authorization"), "Bearer osms_test_key")
        self.assertEqual(header(req, "Content-Type"), "application/json")
        self.assertEqual(json.loads(req.data), {"number": "+15551234567", "text": "hello"})
        self.assertEqual(payload, {"stat": True})

    @mock.patch.object(urllib.request, "urlopen")
    def test_stat_false_is_a_failed_send(self, m_url):
        m_url.return_value = FakeResponse(200, b'{"stat": false}')
        with self.assertRaises(opensms_client.OpenSMSError) as ctx:
            make_client().send_sms("+15551234567", "hello")
        self.assertIn("not sent", str(ctx.exception))

    @mock.patch.object(urllib.request, "urlopen")
    def test_gateway_error_reason_is_surfaced(self, m_url):
        # The Linux gateway names the modem's reason; the client must show it
        # instead of the generic "check the phone" text.
        m_url.return_value = FakeResponse(
            200, b'{"stat": false, "error": "no SIM in the modem"}')
        with self.assertRaises(opensms_client.OpenSMSError) as ctx:
            make_client().send_sms("+15551234567", "hello")
        self.assertIn("no SIM in the modem", str(ctx.exception))

    @mock.patch.object(urllib.request, "urlopen")
    def test_401_names_the_key(self, m_url):
        m_url.side_effect = urllib.error.HTTPError(
            BASE + "/sms/", 401, "Unauthorized", {},
            io.BytesIO(b'{"detail":"Invalid or expired API key"}'))
        with self.assertRaises(opensms_client.OpenSMSError) as ctx:
            make_client().send_sms("+15551234567", "hello")
        self.assertIn("401", str(ctx.exception))
        self.assertIn("OPENSMS_API_KEY", str(ctx.exception))

    @mock.patch.object(urllib.request, "urlopen")
    def test_unreachable_gateway_is_reported(self, m_url):
        m_url.side_effect = urllib.error.URLError("Connection refused")
        with self.assertRaises(opensms_client.OpenSMSError) as ctx:
            make_client().send_sms("+15551234567", "hello")
        self.assertIn("unreachable", str(ctx.exception))

    def test_missing_config_is_refused(self):
        with mock.patch.object(opensms_client, "_ENV", {}):
            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(opensms_client.OpenSMSError):
                    opensms_client.OpenSMSClient()

    def test_timeout_defaults_and_overrides(self):
        self.assertEqual(make_client().timeout, 15.0)
        self.assertEqual(make_client(timeout_ms=500).timeout, 0.5)
        with mock.patch.object(opensms_client, "_ENV", {}):
            with mock.patch.dict(os.environ, {"OPENSMS_TIMEOUT_MS": "nonsense"}, clear=True):
                self.assertEqual(make_client().timeout, 15.0)


class ConfigTest(unittest.TestCase):
    def test_configured_requires_url_and_key(self):
        with mock.patch.object(opensms_client, "_ENV", {}):
            with mock.patch.dict(os.environ, {"OPENSMS_URL": BASE}, clear=True):
                self.assertFalse(opensms_client.configured())
            with mock.patch.dict(
                os.environ, {"OPENSMS_URL": BASE, "OPENSMS_API_KEY": "k"}, clear=True
            ):
                self.assertTrue(opensms_client.configured())

    def test_provider_defaults_to_zeus(self):
        with mock.patch.object(opensms_client, "_ENV", {}):
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(opensms_client.provider(), "zeus")
            for name in opensms_client.PROVIDERS:
                with mock.patch.dict(os.environ, {"SMS_PROVIDER": name.upper()}, clear=True):
                    self.assertEqual(opensms_client.provider(), name)

    def test_unknown_provider_falls_back_with_a_warning(self):
        stderr = io.StringIO()
        with mock.patch.object(opensms_client, "_ENV", {}):
            with mock.patch.dict(os.environ, {"SMS_PROVIDER": "carrier-pigeon"}, clear=True):
                with mock.patch("sys.stderr", new=stderr):
                    self.assertEqual(opensms_client.provider(), "zeus")
        self.assertIn("unknown SMS_PROVIDER", stderr.getvalue())


class SavedChoiceTest(unittest.TestCase):
    """The Control Center's saved choice sits between the real env and .env."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_file = os.path.join(self.tmp.name, "sms-transport")

    def save(self, value):
        with open(self.state_file, "w") as fh:
            fh.write(value + "\n")

    def env(self, **values):
        return mock.patch.dict(
            os.environ,
            {"CAPSTONE_SMS_TRANSPORT_STATE": self.state_file, **values},
            clear=True,
        )

    def test_aliases_map_the_operator_vocabulary(self):
        self.assertEqual(opensms_client.normalize_choice("local"), "opensms")
        self.assertEqual(opensms_client.normalize_choice("provider"), "zeus")
        self.assertEqual(opensms_client.normalize_choice("AUTO"), "auto")
        self.assertEqual(opensms_client.normalize_choice("smoke-signal"), "")

    def test_saved_choice_is_used_when_the_environment_is_silent(self):
        self.save("opensms")
        with mock.patch.object(opensms_client, "_ENV", {}), self.env():
            self.assertEqual(opensms_client.provider(), "opensms")

    def test_real_environment_beats_the_saved_choice(self):
        self.save("opensms")
        with mock.patch.object(opensms_client, "_ENV", {}), self.env(SMS_PROVIDER="zeus"):
            self.assertEqual(opensms_client.provider(), "zeus")

    def test_dotenv_seeds_when_nothing_is_saved(self):
        with mock.patch.object(opensms_client, "_ENV", {"SMS_PROVIDER": "local"}), self.env():
            self.assertEqual(opensms_client.provider(), "opensms")

    def test_saved_choice_beats_the_dotenv_seed(self):
        self.save("zeus")
        with mock.patch.object(opensms_client, "_ENV", {"SMS_PROVIDER": "local"}), self.env():
            self.assertEqual(opensms_client.provider(), "zeus")

    def test_invalid_state_file_falls_back_to_the_seed(self):
        self.save("carrier-pigeon")
        with mock.patch.object(opensms_client, "_ENV", {"SMS_PROVIDER": "opensms"}), self.env():
            self.assertEqual(opensms_client.stored_provider(), "")
            self.assertEqual(opensms_client.provider(), "opensms")


if __name__ == "__main__":
    unittest.main()
