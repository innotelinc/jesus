#!/usr/bin/env python3
"""Unit tests for scripts/zeus_client.py — the Zeus portal API client.

Run:  python3 -m unittest discover -s scripts/tests -v

Everything is mocked at urllib.request.urlopen — no network, no Zeus, no .env.
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
import zeus_client  # noqa: E402

BASE = "https://api.zeus.innotel.us"


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
    kwargs.setdefault("session_token", "TOK")
    return zeus_client.ZeusClient(BASE, **kwargs)


def header(req, name):
    """Case-insensitive request-header lookup (urllib lowercases stored keys)."""
    lowered = {k.lower(): v for k, v in req.headers.items()}
    return lowered.get(name.lower())


def captured_request(mock_urlopen):
    """Return the urllib Request that the mocked urlopen received."""
    mock_urlopen.assert_called_once()
    return mock_urlopen.call_args[0][0]


class SendSmsTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_cookie_and_json_payload(self, m_url):
        m_url.return_value = FakeResponse(
            201, json.dumps({"message": {"id": "m1"}, "conversation": {"id": "c1"}}).encode())
        client = make_client()
        status, payload = client.send_sms("+13025551002", "did-1", "hello")

        req = captured_request(m_url)
        self.assertEqual(req.full_url, f"{BASE}/api/messages/send")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(header(req, "Cookie"), "pbx_session=TOK")
        self.assertEqual(
            json.loads(req.data),
            {"to_number": "+13025551002", "from_did_id": "did-1", "body": "hello"},
        )
        self.assertEqual(status, 201)
        self.assertEqual(payload["message"]["id"], "m1")


class ErrorTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_non_2xx_raises_zeus_error(self, m_url):
        m_url.side_effect = urllib.error.HTTPError(
            f"{BASE}/api/voicemail", 401, "Unauthorized", {},
            io.BytesIO(b'{"error":"Unauthorized"}'))
        client = make_client()
        with self.assertRaises(zeus_client.ZeusError) as ctx:
            client.voicemails()
        self.assertIn("401", str(ctx.exception))


class VoicemailTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_list_sends_pagination_query(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps({"voicemails": [], "total": 0, "hasMore": False}).encode())
        client = make_client()
        status, payload = client.voicemails(limit=10, offset=5)

        req = captured_request(m_url)
        self.assertIn("/api/voicemail?limit=10&offset=5", req.full_url)
        self.assertEqual(header(req, "Cookie"), "pbx_session=TOK")
        self.assertEqual(status, 200)
        self.assertEqual(payload["total"], 0)

    @mock.patch.object(urllib.request, "urlopen")
    def test_summary_posts_voicemail_id(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps({"success": True, "summary": "Ada called."}).encode())
        client = make_client()
        status, payload = client.voicemail_summary("vm-9")

        req = captured_request(m_url)
        self.assertEqual(req.full_url, f"{BASE}/api/voicemail/summary")
        self.assertEqual(json.loads(req.data), {"voicemail_id": "vm-9"})
        self.assertEqual(payload["summary"], "Ada called.")
        self.assertEqual(status, 200)


class FaxTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_multipart_contains_pdf_and_fields(self, m_url):
        pdf = b"%PDF-1.4 fake fax body"
        m_url.return_value = FakeResponse(
            201, json.dumps({"fax": {"id": "f1"}, "sent": True}).encode())
        client = make_client()
        with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
            tmp.write(pdf)
            tmp.flush()
            status, payload = client.send_fax(
                "+13025551002", "did-9", subject="Cover", pdf_path=tmp.name)

        req = captured_request(m_url)
        ctype = header(req, "Content-Type") or ""
        self.assertTrue(ctype.startswith("multipart/form-data; boundary="))
        boundary = ctype.split("boundary=", 1)[1]
        body = req.data
        self.assertIn(b'name="to_number"', body)
        self.assertIn(b'name="from_did_id"', body)
        self.assertIn(b'name="subject"', body)
        self.assertIn(b'filename="fax.pdf"', body)
        self.assertIn(b"application/pdf", body)
        self.assertIn(pdf, body)
        self.assertTrue(body.startswith(b"--" + boundary.encode()))
        self.assertTrue(body.rstrip().endswith(b"--" + boundary.encode() + b"--"))
        self.assertEqual(status, 201)
        self.assertTrue(payload["sent"])

    @mock.patch.object(urllib.request, "urlopen")
    def test_text_body_fax_when_no_file(self, m_url):
        m_url.return_value = FakeResponse(201, b"{}")
        client = make_client()
        client.send_fax("+1", "did-9", body="text-only fax")
        req = captured_request(m_url)
        self.assertIn(b'name="body"', req.data)
        self.assertIn(b"text-only fax", req.data)

    def test_requires_file_or_body(self):
        client = make_client()
        with self.assertRaises(ValueError):
            client.send_fax("+1", "did-9")

    @mock.patch.object(urllib.request, "urlopen")
    def test_download_returns_raw_pdf_bytes(self, m_url):
        pdf = b"%PDF-1.4 the fax"
        m_url.return_value = FakeResponse(200, pdf)
        client = make_client()
        status, payload = client.fax_download("f1")

        req = captured_request(m_url)
        self.assertEqual(req.full_url, f"{BASE}/api/fax/download?id=f1")
        self.assertEqual(status, 200)
        self.assertEqual(payload, pdf)


class ResolveTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_cookie_auth_by_default(self, m_url):
        m_url.return_value = FakeResponse(200, b"{}")
        client = make_client()  # session token only, no bearer
        client.resolve("Ada")

        req = captured_request(m_url)
        self.assertEqual(header(req, "Cookie"), "pbx_session=TOK")
        self.assertIsNone(header(req, "Authorization"))
        self.assertEqual(req.full_url, f"{BASE}/api/agent/transfer-resolve")
        self.assertEqual(json.loads(req.data), {"query": "Ada"})

    @mock.patch.object(urllib.request, "urlopen")
    def test_bearer_overrides_cookie(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps({"transfer_context": {"destination": "+13025551001"}}).encode())
        client = make_client()
        status, payload = client.resolve("Ada", bearer="BTOK")

        req = captured_request(m_url)
        self.assertEqual(header(req, "Authorization"), "Bearer BTOK")
        self.assertIsNone(header(req, "Cookie"))
        self.assertEqual(payload["transfer_context"]["destination"], "+13025551001")
        self.assertEqual(status, 200)


class ThreadTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_conversation_id_is_escaped(self, m_url):
        m_url.return_value = FakeResponse(200, b"{}")
        client = make_client()
        client.thread("ab/c")
        req = captured_request(m_url)
        self.assertTrue(req.full_url.endswith("/api/messages/ab%2Fc"))


if __name__ == "__main__":
    unittest.main()

# ── send_sms.py (SMS helper over zeus_client) ──────────────────────────────


class SendSmsNormalisation(unittest.TestCase):
    """Phone-number normalisation in scripts/send_sms."""

    def test_strips_punctuation(self):
        from send_sms import normalise_number

        self.assertEqual(normalise_number("+1 (222) 333-4444"), "+12223334444")
        self.assertEqual(normalise_number("1-222-333-4444"), "+12223334444")
        self.assertEqual(normalise_number("+44 20 7946 0958"), "+442079460958")

    def test_rejects_broken_input(self):
        from send_sms import normalise_number

        for bad in ("", "abc", "222", "+", "+++", "12345"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    normalise_number(bad)

    def test_leans_on_e164_prefix(self):
        from send_sms import normalise_number

        # The validator is deliberately permissive on punctuation and will
        # happily normalise a bare regional number like "20 7946 0958" into
        # "+2079460958". We don't try to be a full ITU validator here — Zeus
        # does its own reachability check — but we do enforce a minimum length
        # so garbage like "7" is rejected early.
        self.assertEqual(normalise_number("20 7946 0958"), "+2079460958")

        # A single digit is not a phone number.
        with self.assertRaises(ValueError):
            normalise_number("7")


class SendSmsNumberListNormalisation(unittest.TestCase):
    """_normalise_number_list reconciles Zeus API shapes."""

    def test_coalesces_quirky_keys(self):
        from send_sms import _normalise_number_list

        raw = [
            {"number": "12223334444", "did_id": 7, "label": "Main line"},
            {"phone": "+13025551002", "id": 12, "status": "active"},
            {"phone_number": "0012223335555", "did": 99},  # looks like a number but isn't E.164
            {"junk": "skip-me"},
            {},
        ]
        normed = _normalise_number_list(raw)
        # Only the two entries with a real leading country code survive.
        self.assertEqual(len(normed), 2)
        self.assertEqual(normed[0]["number"], "+12223334444")
        self.assertEqual(normed[0]["did_id"], "7")
        self.assertEqual(normed[1]["number"], "+13025551002")
        self.assertEqual(normed[1]["did_id"], "12")


class SendSmsCliParsing(unittest.TestCase):
    """smoke-test the argparse surface without touching the network."""

    def test_help_text_is_sensible(self):
        import subprocess
        import sys

        proc = subprocess.run(
            [sys.executable, "scripts/send_sms.py", "--help"],
            capture_output=True,
            text=True,
            cwd="scripts/..",
        )
        self.assertEqual(proc.returncode, 0)
        self.assertIn("Send an SMS", proc.stdout)
        self.assertIn("--list", proc.stdout)
        self.assertIn("--json", proc.stdout)

    def test_missing_args_exits_non_zero(self):
        import subprocess
        import sys

        proc = subprocess.run(
            [sys.executable, "scripts/send_sms.py"],
            capture_output=True,
            text=True,
            cwd="scripts/..",
        )
        self.assertNotEqual(proc.returncode, 0)
