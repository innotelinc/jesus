"""The switch bootstrap, tested against a stand-in control API.

No sockets and no docker: the point is that the document in `pbx/cantus/` is
what the switch ends up holding, and that a second run changes nothing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bootstrap_cantus as boot  # noqa: E402


class FakeSwitch:
    def __init__(self, routes=None, lines=None):
        self.routes = routes or {"version": 1, "default": {"reject": 3}, "routes": []}
        self.lines = lines or []
        self.calls = []

    def call(self, path, method="GET", body=None):
        self.calls.append((method, path))
        if path == "/v1/routes":
            if method == "POST":
                self.routes = body
                return {"ok": True}
            return self.routes
        if path == "/v1/lines":
            if method == "POST":
                self.lines = [line for line in self.lines if line.get("ext") != body.get("ext")] + [body]
                return {"ok": True}
            return {"lines": self.lines}
        if path == "/v1/trunks":
            return {"ok": True}
        raise AssertionError(f"unexpected call {method} {path}")


def test_routes_document_is_valid_json_with_the_expected_shape():
    document = boot.load("routes.json")
    assert document["version"] == 1
    names = [route["name"] for route in document["routes"]]
    assert "agent-dids" in names
    for route in document["routes"]:
        assert route["then"], f"{route['name']} has no actions"
        for action in route["then"]:
            assert len(action) == 1, f"{route['name']}: actions are single-key objects"
    dids = next(route for route in document["routes"] if route["name"] == "agent-dids")
    assert dids["then"][-1]["ari"]["app"], "a DID route that hands off must name an application"


def test_inventory_lines_are_unique_and_dialable():
    inventory = boot.load("lines.json")
    exts = [line["ext"] for line in inventory["lines"]]
    assert len(exts) == len(set(exts)), "duplicate extensions would make one line unreachable"
    assert all(ext.isdigit() for ext in exts)


def test_first_run_applies_and_second_run_changes_nothing():
    switch = FakeSwitch()
    assert boot.apply_routes(switch, boot.load("routes.json")) == "applied"
    assert boot.apply_routes(switch, boot.load("routes.json")) == "unchanged"

    assert boot.apply_lines(switch, boot.load("lines.json")).startswith("8 created")
    assert boot.apply_lines(switch, boot.load("lines.json")) == "unchanged"


def test_a_diverged_display_name_is_updated():
    inventory = boot.load("lines.json")
    stale = [dict(inventory["lines"][0], displayName="Old name")]
    switch = FakeSwitch(lines=stale)
    assert boot.apply_lines(switch, inventory) == "7 created, 1 updated"
    assert switch.lines[0]["displayName"] == inventory["lines"][0]["displayName"]
