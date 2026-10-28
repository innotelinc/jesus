#!/usr/bin/env python3
"""Unit tests for scripts/npm-smoke-test.py's 5xx classification.

A proxy host that returns 502 does not say why. When the upstream address is
known (NPM_UPSTREAM_HOST / PJSIP_MEDIA_ADDRESS) the smoke test can tell the two
apart: a listening upstream that still errors is a service fault, nothing
listening is the stopped/unreachable upstream a profile-gated PBX produces.
These tests pin that wording so a stopped PBX never reads as a broken host.

Run with:  python3 -m unittest discover -s scripts/tests -v
"""

import importlib.util
import os
import socket
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_SMOKE_PATH = os.path.abspath(os.path.join(_HERE, "..", "npm-smoke-test.py"))
_spec = importlib.util.spec_from_file_location("npm_smoke_test", _SMOKE_PATH)
npm_smoke_test = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(npm_smoke_test)


class Classify5xxTest(unittest.TestCase):
    def test_stopped_upstream_is_named_as_such(self):
        note = npm_smoke_test.classify_5xx(502, ("192.168.1.46", 8089), False)
        self.assertIn("nothing listening on 192.168.1.46:8089", note)
        self.assertIn("stopped or unreachable", note)
        self.assertIn("not a host fault", note)

    def test_listening_upstream_points_at_the_service(self):
        note = npm_smoke_test.classify_5xx(502, ("192.168.1.46", 8089), True)
        self.assertIn("is listening", note)
        self.assertIn("service itself is failing", note)

    def test_unknown_upstream_stays_generic(self):
        self.assertEqual(npm_smoke_test.classify_5xx(502, None, None), "upstream error 502")
        # Address known but the probe was skipped — still generic.
        self.assertEqual(
            npm_smoke_test.classify_5xx(504, ("host", 80), None), "upstream error 504")


class UpstreamReachableTest(unittest.TestCase):
    def test_missing_upstream_is_unknown(self):
        self.assertIsNone(npm_smoke_test.upstream_reachable("", 0, 5))

    def test_refused_connection_is_false(self):
        # A listener bound then closed: connecting must fail, not hang.
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        self.assertFalse(npm_smoke_test.upstream_reachable("127.0.0.1", port, 2))

    def test_open_listener_is_true(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        try:
            self.assertTrue(npm_smoke_test.upstream_reachable("127.0.0.1", s.getsockname()[1], 2))
        finally:
            s.close()

    def test_oserror_is_false(self):
        with mock.patch.object(socket, "create_connection", side_effect=OSError("nope")):
            self.assertFalse(npm_smoke_test.upstream_reachable("10.0.0.1", 8089, 2))


if __name__ == "__main__":
    unittest.main()
