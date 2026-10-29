#!/usr/bin/env python3
"""Unit tests for scripts/zeus_agent_tools.py — dograh tools over the Zeus API.

Run:  python3 -m unittest discover -s scripts/tests -v

Everything is mocked at the zeus_client boundary — no network, no Zeus, no .env.
"""

import io
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import zeus_agent_tools as zat  # noqa: E402
import opensms_client  # noqa: E402


class ToolArgValidation(unittest.TestCase):
    def test_sms_requires_all_fields(self):
        for payload in ({}, {"to": "15551234567"}, {"to": "15551234567", "did_id": "1"}):
            result = zat.tool_send_sms(payload)
            self.assertIn("error", result)

    def test_fax_requires_to_and_did(self):
        result = zat.tool_send_fax({"to": "15551234567"})
        self.assertIn("error", result)

    def test_resolve_requires_query(self):
        result = zat.tool_resolve({})
        self.assertIn("error", result)


class ToolCalls(unittest.TestCase):
    def test_resolve_passes_transfer_context_through(self):
        zeus_response = {"transfer_context": {"destination": "PJSIP/101", "custom_message": "hi"}}
        with mock.patch.object(zat, "_client") as client:
            client.return_value.resolve.return_value = (200, zeus_response)
            result = zat.tool_resolve({"query": "alice"})
        self.assertEqual(result, zeus_response)

    def test_resolve_maps_zeus_error_to_fallback(self):
        import zeus_client
        with mock.patch.object(zat, "_client") as client:
            client.return_value.resolve.side_effect = zeus_client.ZeusError("HTTP 404: {}")
            result = zat.tool_resolve({"query": "nobody"})
        self.assertIn("error", result)
        self.assertIn("could not resolve", result["error"])

    def test_sms_reports_sent(self):
        with mock.patch.object(zat, "_client") as client:
            client.return_value.send_sms.return_value = (201, {"id": 7})
            result = zat.tool_send_sms({"to": "15551234567", "did_id": "12", "body": "hi"})
        self.assertTrue(result["sent"])
        self.assertEqual(result["response"], {"id": 7})

    def test_fax_reports_sent(self):
        with mock.patch.object(zat, "_client") as client:
            client.return_value.send_fax.return_value = (200, {"fax_id": 3})
            result = zat.tool_send_fax({"to": "15551234567", "did_id": "12", "subject": "s"})
        self.assertTrue(result["sent"])

    def test_voicemails_passthrough(self):
        with mock.patch.object(zat, "_client") as client:
            client.return_value.voicemails.return_value = (200, [{"id": 1}])
            result = zat.tool_voicemails({"limit": 5})
        self.assertEqual(result["voicemails"], [{"id": 1}])

    def test_voicemails_with_summaries_best_effort(self):
        with mock.patch.object(zat, "_client") as client:
            client.return_value.voicemails.return_value = (200, [{"id": 1}, {"id": 2}])
            import zeus_client
            client.return_value.voicemail_summary.side_effect = [
                (200, {"summary": "called about invoice"}),
                zeus_client.ZeusError("HTTP 500"),
            ]
            result = zat.tool_voicemails({"summarize": True})
        self.assertEqual(result["voicemails"][0]["summary"], {"summary": "called about invoice"})
        self.assertIsNone(result["voicemails"][1]["summary"])


class SmsTransportTest(unittest.TestCase):
    def test_opensms_provider_sends_directly(self):
        with mock.patch.object(zat.opensms_client, "provider", return_value="opensms"), \
             mock.patch.object(zat.opensms_client, "configured", return_value=True), \
             mock.patch.object(
                 zat.opensms_client, "send_sms", return_value={"stat": True}
             ) as direct, \
             mock.patch.object(zat, "_client") as client:
            result = zat.tool_send_sms({"to": "+15551234567", "body": "hi"})

        self.assertTrue(result["sent"])
        self.assertEqual(result["transport"], "opensms")
        direct.assert_called_once_with("+15551234567", "hi")
        client.assert_not_called()

    def test_auto_falls_back_to_zeus(self):
        with mock.patch.object(zat.opensms_client, "provider", return_value="auto"), \
             mock.patch.object(zat.opensms_client, "configured", return_value=True), \
             mock.patch.object(
                 zat.opensms_client, "send_sms",
                 side_effect=opensms_client.OpenSMSError("gateway down"),
             ), \
             mock.patch.object(zat, "_client") as client:
            client.return_value.send_sms.return_value = (201, {"id": 7})
            result = zat.tool_send_sms(
                {"to": "15551234567", "did_id": "12", "body": "hi"})

        self.assertTrue(result["sent"])
        self.assertEqual(result["transport"], "zeus")
        client.return_value.send_sms.assert_called_once_with("15551234567", "12", "hi")

    def test_opensms_failure_does_not_fall_back(self):
        with mock.patch.object(zat.opensms_client, "provider", return_value="opensms"), \
             mock.patch.object(zat.opensms_client, "configured", return_value=True), \
             mock.patch.object(
                 zat.opensms_client, "send_sms",
                 side_effect=opensms_client.OpenSMSError("gateway down"),
             ), \
             mock.patch.object(zat, "_client") as client:
            result = zat.tool_send_sms(
                {"to": "15551234567", "did_id": "12", "body": "hi"})

        self.assertIn("error", result)
        self.assertIn("OpenSMS", result["error"])
        client.assert_not_called()

    def test_transport_field_picks_local_over_the_saved_default(self):
        with mock.patch.object(zat.opensms_client, "provider", return_value="zeus"), \
             mock.patch.object(zat.opensms_client, "configured", return_value=True), \
             mock.patch.object(
                 zat.opensms_client, "send_sms", return_value={"stat": True}
             ) as direct, \
             mock.patch.object(zat, "_client") as client:
            result = zat.tool_send_sms(
                {"to": "+15551234567", "body": "hi", "transport": "local"})

        self.assertTrue(result["sent"])
        self.assertEqual(result["transport"], "opensms")
        direct.assert_called_once_with("+15551234567", "hi")
        client.assert_not_called()

    def test_unknown_transport_is_rejected(self):
        with mock.patch.object(zat.opensms_client, "provider", return_value="zeus"):
            result = zat.tool_send_sms(
                {"to": "15551234567", "did_id": "12", "body": "hi",
                 "transport": "smoke-signal"})
        self.assertIn("transport must be", result["error"])

    def test_opensms_without_config_errors(self):
        with mock.patch.object(zat.opensms_client, "provider", return_value="opensms"), \
             mock.patch.object(zat.opensms_client, "configured", return_value=False), \
             mock.patch.object(zat, "_client") as client:
            result = zat.tool_send_sms(
                {"to": "15551234567", "did_id": "12", "body": "hi"})

        self.assertIn("OPENSMS_URL", result["error"])
        client.assert_not_called()


class HttpSurface(unittest.TestCase):
    """The dograh-facing HTTP surface: POST /<tool> and GET /health."""

    def _request(self, method, path, body=None):
        # Real handler instance; only the socket-writing methods are stubbed.
        handler = zat.ToolHandler.__new__(zat.ToolHandler)
        handler.path = path
        handler.headers = {"Content-Length": str(len(body or b""))}
        handler.rfile = io.BytesIO(body or b"")
        handler.wfile = io.BytesIO()
        status_box = {}
        def send_response(status, message=None):
            status_box["status"] = status
        handler.send_response = send_response
        handler.send_header = lambda *a, **k: None
        handler.end_headers = lambda: None
        if method == "GET":
            zat.ToolHandler.do_GET(handler)
        else:
            zat.ToolHandler.do_POST(handler)
        handler.wfile.seek(0)
        return status_box["status"], json.loads(handler.wfile.read())

    def test_unknown_tool_404(self):
        status, payload = self._request("POST", "/nope", b"{}")
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_health(self):
        status, payload = self._request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_sms_endpoint_roundtrip(self):
        with mock.patch.object(zat, "_client") as client:
            client.return_value.send_sms.return_value = (201, {"id": 7})
            status, payload = self._request(
                "POST", "/sms",
                json.dumps({"to": "15551234567", "did_id": "12", "body": "hi"}).encode(),
            )
        self.assertEqual(status, 200)
        self.assertTrue(payload["sent"])

    def test_tool_error_maps_to_400(self):
        status, payload = self._request("POST", "/sms", b"{}")
        self.assertEqual(status, 400)
        self.assertIn("error", payload)


if __name__ == "__main__":
    unittest.main()
