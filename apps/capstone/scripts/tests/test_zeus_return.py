#!/usr/bin/env python3
"""Regression tests for the opt-in Dograh → Zeus interview return branch.

These tests load the strategy with tiny stand-ins for Dograh's runtime
packages, so the safety decisions (off by default, token required, and the
variable-write-before-redirect order) are checkable without a live ARI server.
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STRATEGIES = ROOT / "dograh" / "upstream" / "api" / "services" / "telephony" / "providers" / "ari" / "strategies.py"


def load_strategy():
    loguru = types.ModuleType("loguru")
    loguru.logger = types.SimpleNamespace(
        warning=lambda *a, **k: None,
        info=lambda *a, **k: None,
        error=lambda *a, **k: None,
        exception=lambda *a, **k: None,
        debug=lambda *a, **k: None,
    )
    sys.modules["loguru"] = loguru
    serializers = types.ModuleType("pipecat.serializers.call_strategies")
    serializers.HangupStrategy = object
    serializers.TransferStrategy = object
    sys.modules["pipecat"] = types.ModuleType("pipecat")
    sys.modules["pipecat.serializers"] = types.ModuleType("pipecat.serializers")
    sys.modules["pipecat.serializers.call_strategies"] = serializers
    # The helper imports aiohttp lazily; this regression test supplies only the
    # tiny BasicAuth surface it needs, so the base checkout needs no ARI client.
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.BasicAuth = lambda user, password: (user, password)
    sys.modules["aiohttp"] = aiohttp
    spec = importlib.util.spec_from_file_location("zeus_return_strategies", STRATEGIES)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, status, payload=None):
        self.status = status
        self._payload = payload or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def json(self):
        return self._payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def _record(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)

    def get(self, url, **kwargs):
        return self._record("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self._record("POST", url, **kwargs)


class ZeusReturnTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.strategies = load_strategy()

    def test_return_is_disabled_by_default(self):
        old = os.environ.pop("ZEUS_RETURN_ENABLED", None)
        try:
            self.assertFalse(self.strategies.ARIHangupStrategy._zeus_return_enabled())
        finally:
            if old is not None:
                os.environ["ZEUS_RETURN_ENABLED"] = old

    def test_return_redirects_only_a_token_bearing_channel(self):
        session = FakeSession([
            FakeResponse(200, {"value": "1758500000.42"}),
            FakeResponse(204),
            FakeResponse(204),
        ])
        result = asyncio.run(
            self.strategies.ARIHangupStrategy._redirect_to_zeus_return(
                session_factory=lambda: session,
                channel_id="channel-1",
                ari_endpoint="http://ari.test:8088",
                app_name="dograh",
                app_password="secret",
            )
        )
        self.assertTrue(result)
        self.assertEqual([call[0] for call in session.calls], ["GET", "POST", "POST"])
        self.assertEqual(
            session.calls[2][2]["params"],
            {"context": "zeus-ai-return", "extension": "s", "priority": "1"},
        )

    def test_missing_token_falls_back_without_writing_or_redirecting(self):
        session = FakeSession([FakeResponse(200, {"value": "(null)"})])
        result = asyncio.run(
            self.strategies.ARIHangupStrategy._redirect_to_zeus_return(
                session_factory=lambda: session,
                channel_id="channel-1",
                ari_endpoint="http://ari.test:8088",
                app_name="dograh",
                app_password="secret",
            )
        )
        self.assertFalse(result)
        self.assertEqual(len(session.calls), 1)

    def test_ari_variable_failure_does_not_redirect(self):
        session = FakeSession([
            FakeResponse(200, {"value": "1758500000.42"}),
            FakeResponse(500),
        ])
        result = asyncio.run(
            self.strategies.ARIHangupStrategy._redirect_to_zeus_return(
                session_factory=lambda: session,
                channel_id="channel-1",
                ari_endpoint="http://ari.test:8088",
                app_name="dograh",
                app_password="secret",
            )
        )
        self.assertFalse(result)
        self.assertEqual([call[0] for call in session.calls], ["GET", "POST"])


if __name__ == "__main__":
    unittest.main()
