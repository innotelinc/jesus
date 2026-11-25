#!/usr/bin/env python3
"""Tests for dashboard-backend/app/voice_notify.py — the SMS nudge.

Why it matters: this is the only part of the voice work that reaches a human
away from a screen, so it has to be safe in both directions. It must not page
someone every minute about one open condition (that is how alerting gets muted),
and it must not lose the fact that it could not send (that is how a dead gateway
looks healthy). Both are pinned here against a fake OpenSMS gateway on a real
socket, so the request shape and the `stat` handling are exercised for real.

The gateway is local and ephemeral; nothing leaves the machine.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import voice_notify  # noqa: E402

ENV_KEYS = (
    "OPENSMS_URL", "OPENSMS_API_KEY", "OPENSMS_TIMEOUT_MS",
    "VOICE_ALERT_SMS_TO", "VOICE_ALERT_PUSH_STATE",
    "CAPSTONE_SMS_INBOUND_STATE", "CAPSTONE_SMS_TRANSPORT_STATE", "SMS_PROVIDER",
)


class _Gateway(BaseHTTPRequestHandler):
    """The smallest OpenSMS: Bearer auth, `{number,text}`, `{"stat": true}`."""

    def do_POST(self):  # noqa: N802 - http.server's spelling
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) or b"{}"
        self.server.received.append({
            "auth": self.headers.get("Authorization"),
            "body": json.loads(raw),
        })
        if self.server.fail:
            payload = b'{"stat": false, "detail": "modem refused"}'
            self.send_response(500)
        else:
            payload = b'{"stat": true, "transport": "test-gateway"}'
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # silence the server's stderr noise
        pass


class VoiceNotifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = HTTPServer(("127.0.0.1", 0), _Gateway)
        self.server.received = []
        self.server.fail = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

        self.saved = {key: os.environ.get(key) for key in ENV_KEYS}
        os.environ.pop("SMS_PROVIDER", None)
        os.environ["OPENSMS_URL"] = f"http://127.0.0.1:{self.server.server_port}"
        os.environ["OPENSMS_API_KEY"] = "test-key"
        os.environ["VOICE_ALERT_SMS_TO"] = "+15551234567"
        os.environ["VOICE_ALERT_PUSH_STATE"] = str(Path(self.tmp.name) / "push.json")
        os.environ["CAPSTONE_SMS_INBOUND_STATE"] = str(Path(self.tmp.name) / "inbound.jsonl")
        os.environ["CAPSTONE_SMS_TRANSPORT_STATE"] = str(Path(self.tmp.name) / "transport")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def alert(self, message="A handset leg went silent for 30 s or more: sender-silent",
              alert_id="al-voice-rtp-stall", severity="warning"):
        return {
            "id": alert_id,
            "severity": severity,
            "service": "FreePBX",
            "message": message,
        }

    def dispatch(self, *alerts, now=None):
        return voice_notify.dispatch(list(alerts), now=now)

    def test_a_new_voice_alert_is_sent_as_one_sms(self):
        result = self.dispatch(self.alert())
        self.assertEqual(result["sent"], ["al-voice-rtp-stall"])
        self.assertIsNone(result["error"])
        self.assertEqual(len(self.server.received), 1)
        sent = self.server.received[0]
        self.assertEqual(sent["auth"], "Bearer test-key")
        self.assertEqual(sent["body"]["number"], "+15551234567")
        self.assertIn("FreePBX", sent["body"]["text"])
        self.assertIn("sender-silent", sent["body"]["text"])

    def test_the_same_open_alert_is_not_sent_again(self):
        first = voice_notify.dispatch([self.alert()])
        second = voice_notify.dispatch([self.alert()])
        self.assertEqual(first["sent"], ["al-voice-rtp-stall"])
        self.assertEqual(second["sent"], [])
        self.assertEqual(second["skipped"], ["al-voice-rtp-stall"])
        self.assertEqual(len(self.server.received), 1, "one condition, one SMS")

        book = json.loads(Path(os.environ["VOICE_ALERT_PUSH_STATE"]).read_text())
        self.assertIn("al-voice-rtp-stall", book["alerts"])
        self.assertIsNotNone(book["lastSentAt"])

    def test_a_changed_message_is_sent_again(self):
        voice_notify.dispatch([self.alert()])
        again = voice_notify.dispatch([self.alert(message="A second handset leg went silent")])
        self.assertEqual(again["sent"], ["al-voice-rtp-stall"])
        self.assertEqual(len(self.server.received), 2, "a new fact is a new SMS")

    def test_a_different_alert_id_is_its_own_message(self):
        result = self.dispatch(
            self.alert(),
            self.alert(alert_id="al-voice-prewarm-drift", message="The prewarmed list drifted"),
        )
        self.assertEqual(sorted(result["sent"]),
                         ["al-voice-prewarm-drift", "al-voice-rtp-stall"])
        self.assertEqual(len(self.server.received), 2)

    def test_non_voice_alerts_are_never_pushed(self):
        result = self.dispatch({
            "id": "al-freepbx", "severity": "critical", "service": "FreePBX",
            "message": "FreePBX is restarting",
        })
        self.assertEqual(result["considered"], 0)
        self.assertEqual(result["sent"], [])
        self.assertEqual(self.server.received, [])

    def test_no_recipient_sends_nothing_and_says_why(self):
        os.environ.pop("VOICE_ALERT_SMS_TO", None)
        result = self.dispatch(self.alert())
        self.assertEqual(result["sent"], [])
        self.assertIn("VOICE_ALERT_SMS_TO", result["error"])
        self.assertEqual(self.server.received, [])
        self.assertFalse(voice_notify.state()["configured"])

    def test_a_gateway_failure_is_recorded_not_raised(self):
        self.server.fail = True
        result = self.dispatch(self.alert())
        self.assertEqual(result["sent"], [])
        self.assertIn("500", result["error"])
        state = voice_notify.state()
        self.assertIn("modem refused", state["lastError"])
        # It *is* configured — recipient and key are there; the gateway is what failed.
        self.assertTrue(state["configured"])
        self.assertEqual(state["to"], "…4567")

    def test_a_failed_send_is_retried_on_the_next_tick(self):
        self.server.fail = True
        voice_notify.dispatch([self.alert()])
        self.server.fail = False
        result = voice_notify.dispatch([self.alert()])
        self.assertEqual(result["sent"], ["al-voice-rtp-stall"])

    def test_the_number_is_masked_everywhere_it_is_reported(self):
        voice_notify.dispatch([self.alert()])
        state = voice_notify.state()
        self.assertEqual(state["to"], "…4567")
        self.assertNotIn("15551234567", json.dumps(state))


if __name__ == "__main__":
    unittest.main()
