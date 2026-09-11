#!/usr/bin/env python3
"""Unit tests for dashboard-backend/app/hosts.py — the request-aware host
resolution behind /turnconfig (softphone STUN/TURN + WSS endpoint).

Why it matters: the aggregator hands its own address back to the browser, so a
wrong host means an unreachable STUN server (no ICE candidate) or a WSS URL
that doesn't carry the certificate the browser trusts.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import hosts  # noqa: E402


class SplitHostTest(unittest.TestCase):
    def test_strips_port(self):
        self.assertEqual(hosts.split_host("dashboard.capstone.innotel.us:8096"), "dashboard.capstone.innotel.us")

    def test_plain_host_and_ip(self):
        self.assertEqual(hosts.split_host("192.168.1.46"), "192.168.1.46")
        self.assertEqual(hosts.split_host("  example.com  "), "example.com")

    def test_first_of_proxy_chain(self):
        self.assertEqual(hosts.split_host("a.example.com, b.internal"), "a.example.com")

    def test_ipv6_literal(self):
        self.assertEqual(hosts.split_host("[::1]:8096"), "::1")

    def test_empty(self):
        self.assertEqual(hosts.split_host(""), "")
        self.assertEqual(hosts.split_host("   "), "")


class IsHttpsTest(unittest.TestCase):
    def test_forwarded_proto_wins(self):
        self.assertTrue(hosts.is_https("https", "http"))
        self.assertFalse(hosts.is_https("http", "https"))

    def test_falls_back_to_scheme(self):
        self.assertTrue(hosts.is_https("", "https"))
        self.assertFalse(hosts.is_https("", "http"))

    def test_first_of_proxy_chain_and_case(self):
        self.assertTrue(hosts.is_https("HTTPS, http", ""))

    def test_nothing_known_is_not_https(self):
        self.assertFalse(hosts.is_https("", ""))


class BrowserHostTest(unittest.TestCase):
    def test_prefers_forwarded_host(self):
        self.assertEqual(
            hosts.browser_host("dashboard.capstone.innotel.us", "dashboard:80", "fallback"),
            "dashboard.capstone.innotel.us",
        )

    def test_falls_back_to_host_then_default(self):
        self.assertEqual(hosts.browser_host("", "192.168.1.46:8096", "fallback"), "192.168.1.46")
        self.assertEqual(hosts.browser_host("", "", "192.168.1.46"), "192.168.1.46")


class WssEndpointTest(unittest.TestCase):
    def test_same_origin_when_https_host_known(self):
        self.assertEqual(
            hosts.wss_endpoint("dashboard.capstone.innotel.us", ""),
            "wss://dashboard.capstone.innotel.us/ws",
        )

    def test_npm_domain_fallback(self):
        self.assertEqual(
            hosts.wss_endpoint("", "capstone.innotel.us"),
            "wss://voice.capstone.innotel.us/ws",
        )
        self.assertEqual(
            hosts.wss_endpoint("", "capstone.innotel.us", subdomain="pbx"),
            "wss://pbx.capstone.innotel.us/ws",
        )

    def test_http_page_has_no_advertised_endpoint(self):
        # No host (plain-HTTP page) and no proxy domain → "" so the client keeps
        # its own page-origin / direct-PBX defaults.
        self.assertEqual(hosts.wss_endpoint("", ""), "")

    def test_host_beats_npm_domain(self):
        self.assertEqual(
            hosts.wss_endpoint("dashboard.capstone.innotel.us", "capstone.innotel.us"),
            "wss://dashboard.capstone.innotel.us/ws",
        )


if __name__ == "__main__":
    unittest.main()
