#!/usr/bin/env python3
"""Unit tests for scripts/send_sms.py — transport selection and dispatch.

Run:  python3 -m unittest discover -s scripts/tests -v

The Zeus and OpenSMS boundaries are mocked; nothing leaves the process.
"""

import io
import json
import os
import sys
import unittest
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import send_sms  # noqa: E402
import opensms_client  # noqa: E402


class FakeResponse:
    def __init__(self, status=201, body=b"{}"):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class ProviderDispatchTest(unittest.TestCase):
    def _send(self, **kwargs):
        stdout = io.StringIO()
        with mock.patch("sys.stdout", new=stdout):
            with self.assertRaises(SystemExit) as ctx:
                send_sms.send_sms("+15551234567", "hello", json_out=True, **kwargs)
        return ctx.exception.code, json.loads(stdout.getvalue())

    def test_opensms_success_skips_zeus(self):
        with mock.patch.object(send_sms.opensms_client, "provider", return_value="opensms"), \
             mock.patch.object(send_sms.opensms_client, "configured", return_value=True), \
             mock.patch.object(send_sms.opensms_client, "send_sms", return_value={"stat": True}) as direct, \
             mock.patch.object(send_sms, "_zeus_base_url") as zeus_base:
            code, payload = self._send()

        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["transport"], "opensms")
        direct.assert_called_once_with("+15551234567", "hello")
        zeus_base.assert_not_called()

    @mock.patch.object(urllib.request, "urlopen")
    def test_auto_falls_back_to_zeus(self, m_url):
        m_url.return_value = FakeResponse(
            201, b'{"message":{"id":"m1"},"conversation":{"id":"c1"}}')
        with mock.patch.object(send_sms.opensms_client, "provider", return_value="auto"), \
             mock.patch.object(send_sms.opensms_client, "configured", return_value=True), \
             mock.patch.object(
                 send_sms.opensms_client, "send_sms",
                 side_effect=opensms_client.OpenSMSError("gateway down"),
             ), \
             mock.patch.object(send_sms, "_zeus_base_url", return_value="http://zeus:3000"):
            code, payload = self._send()

        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["transport"], "zeus")
        req = m_url.call_args[0][0]
        self.assertEqual(req.full_url, "http://zeus:3000/api/messages/send")
        self.assertEqual(
            json.loads(req.data),
            {"to_number": "+15551234567", "from_did_id": None, "body": "hello"},
        )

    def test_opensms_failure_does_not_fall_back(self):
        client = mock.Mock()
        with mock.patch.object(send_sms.opensms_client, "provider", return_value="opensms"), \
             mock.patch.object(send_sms.opensms_client, "configured", return_value=True), \
             mock.patch.object(
                 send_sms.opensms_client, "send_sms",
                 side_effect=opensms_client.OpenSMSError("gateway down"),
             ), \
             mock.patch.object(send_sms, "_zeus_base_url") as zeus_base, \
             mock.patch.object(send_sms.zc, "ZeusClient", return_value=client):
            code, payload = self._send()

        self.assertEqual(code, 1)
        self.assertIn("OpenSMS send failed", payload["error"])
        zeus_base.assert_not_called()
        client.send_sms.assert_not_called()

    def test_opensms_without_config_errors(self):
        with mock.patch.object(send_sms.opensms_client, "provider", return_value="opensms"), \
             mock.patch.object(send_sms.opensms_client, "configured", return_value=False), \
             mock.patch.object(send_sms, "_zeus_base_url") as zeus_base:
            code, payload = self._send()

        self.assertEqual(code, 1)
        self.assertIn("OPENSMS_URL", payload["error"])
        zeus_base.assert_not_called()

    def test_transport_flag_picks_local_for_one_send(self):
        with mock.patch.object(send_sms.opensms_client, "provider", return_value="zeus"), \
             mock.patch.object(send_sms.opensms_client, "configured", return_value=True), \
             mock.patch.object(
                 send_sms.opensms_client, "send_sms", return_value={"stat": True}
             ) as direct, \
             mock.patch.object(send_sms, "_zeus_base_url") as zeus_base:
            code, payload = self._send(transport="local")

        self.assertEqual(code, 0)
        self.assertEqual(payload["transport"], "opensms")
        direct.assert_called_once_with("+15551234567", "hello")
        zeus_base.assert_not_called()

    def test_unknown_transport_is_rejected(self):
        with mock.patch.object(send_sms.opensms_client, "provider", return_value="zeus"):
            with self.assertRaises(ValueError):
                send_sms.send_sms("+15551234567", "hello", transport="carrier-pigeon")

    @mock.patch.object(urllib.request, "urlopen")
    def test_default_provider_stays_on_zeus(self, m_url):
        m_url.return_value = FakeResponse(201, b'{"id":"m1"}')
        with mock.patch.object(send_sms.opensms_client, "provider", return_value="zeus"), \
             mock.patch.object(send_sms, "_zeus_base_url", return_value="http://zeus:3000"):
            code, payload = self._send()

        self.assertEqual(code, 0)
        self.assertEqual(payload["transport"], "zeus")
        self.assertEqual(
            m_url.call_args[0][0].full_url, "http://zeus:3000/api/messages/send"
        )


class ValidationTest(unittest.TestCase):
    def test_bad_number_is_a_validation_exit(self):
        stdout = io.StringIO()
        with mock.patch("sys.stdout", new=stdout):
            with self.assertRaises(SystemExit) as ctx:
                send_sms.main(["not-a-number", "hello", "--json"])
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
