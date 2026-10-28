#!/usr/bin/env python3
"""Tests for the PJSIP MESSAGE fallback, against a fake Asterisk.

The fake speaks just enough SIP to be dangerous: it answers the first MESSAGE
with a 401 Digest challenge, recomputes the expected response with its own
copy of the password, and only then answers 200. That is what makes this a
test of the auth math rather than of our own assumptions.

    python3 phone-node/test_sip_message.py
"""

import socket
import threading
import unittest

import sip_message
from sip_message import SipError, SipMessageClient, client_from_env, parse_challenge


class FakeAsterisk(threading.Thread):
    """UDP SIP endpoint that challenges once, then verifies the digest."""

    def __init__(self, password="s3cret", realm="asterisk", nonce="nonce-abc-123"):
        super().__init__(daemon=True)
        self.password = password
        self.realm = realm
        self.nonce = nonce
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.requests = []
        self._stop = threading.Event()

    def challenge(self):
        return (f'Digest realm="{self.realm}", nonce="{self.nonce}", '
                f'algorithm=MD5, qop="auth"')

    def verify(self, auth_header, uri):
        params = parse_challenge(auth_header)
        expected = sip_message.digest_response(
            "8000", self.password, "MESSAGE", uri,
            {"realm": params["realm"], "nonce": params["nonce"],
             "algorithm": params.get("algorithm", "MD5"),
             "qop": params.get("qop", "")},
            nc=params.get("nc", "00000001"), cnonce=params.get("cnonce", ""),
        )
        return parse_challenge(expected)["response"] == params.get("response")

    def run(self):
        while not self._stop.is_set():
            try:
                data, addr = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                return
            text = data.decode("latin-1", "replace")
            head, _, body = text.partition("\r\n\r\n")
            lines = head.split("\r\n")
            request_uri = lines[0].split(" ")[1] if " " in lines[0] else ""

            def header(name):
                for line in lines:
                    if line.lower().startswith(name.lower() + ":"):
                        return line.split(":", 1)[1].strip()
                return ""

            auth = header("Authorization") or header("Proxy-Authorization")
            self.requests.append({"uri": request_uri, "body": body, "auth": bool(auth)})

            if not auth:
                reply = (
                    "SIP/2.0 401 Unauthorized\r\n"
                    f"WWW-Authenticate: {self.challenge()}\r\n"
                    "Content-Length: 0\r\n\r\n"
                )
            elif self.verify(auth, request_uri):
                reply = "SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"
            else:
                reply = "SIP/2.0 403 Forbidden\r\nContent-Length: 0\r\n\r\n"
            self.sock.sendto(reply.encode(), addr)

    def stop(self):
        self._stop.set()
        self.sock.close()


class SipMessageTest(unittest.TestCase):
    def setUp(self):
        self.srv = FakeAsterisk()
        self.srv.start()
        self.client = SipMessageClient(
            host="127.0.0.1", port=self.srv.port, username="8000",
            password="s3cret", from_uri="sip:8000@127.0.0.1", timeout=2,
        )

    def tearDown(self):
        self.srv.stop()

    def test_challenge_is_answered_and_message_is_accepted(self):
        status = self.client.send("sip:+15551234567@127.0.0.1", "backup path works")
        self.assertEqual(status, 200)
        self.assertEqual(len(self.srv.requests), 2)
        self.assertFalse(self.srv.requests[0]["auth"], "first request must be unauthenticated")
        self.assertTrue(self.srv.requests[1]["auth"], "retry must carry the digest")
        self.assertEqual(self.srv.requests[1]["body"], "backup path works")

    def test_wrong_password_is_reported_as_an_error(self):
        bad = SipMessageClient(host="127.0.0.1", port=self.srv.port, username="8000",
                               password="wrong", from_uri="sip:8000@127.0.0.1", timeout=2)
        with self.assertRaises(SipError) as ctx:
            bad.send("sip:+15551234567@127.0.0.1", "nope")
        self.assertIn("403", str(ctx.exception))

    def test_no_responder_times_out_with_a_clear_message(self):
        # Nothing listening on this port; one retransmit, then give up.
        dead = SipMessageClient(host="127.0.0.1", port=9, username="8000",
                                password="x", from_uri="sip:8000@127.0.0.1", timeout=0.2)
        with self.assertRaises(SipError) as ctx:
            dead.send("sip:1@127.0.0.1", "hello")
        self.assertIn("no response", str(ctx.exception))

    def test_empty_body_is_refused(self):
        with self.assertRaises(SipError):
            self.client.send("sip:1@127.0.0.1", "   ")

    def test_env_configuration(self):
        self.assertIsNone(client_from_env({}))
        self.assertIsNone(client_from_env({"PJSIP_SMS_HOST": "h", "PJSIP_SMS_USER": "u"}))
        client = client_from_env({
            "PJSIP_SMS_HOST": "10.0.0.5", "PJSIP_SMS_USER": "8000",
            "PJSIP_SMS_PASSWORD": "pw", "PJSIP_SMS_PORT": "5070",
        })
        self.assertEqual((client.host, client.port, client.username), ("10.0.0.5", 5070, "8000"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
