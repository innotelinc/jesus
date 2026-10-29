"""Merging dograh's numbers into the routing document."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sync_agent_numbers as sync  # noqa: E402


def document():
    return {
        "version": 1,
        "default": {"reject": 3},
        "routes": [
            {"name": "agent-dids", "when": {"to": "800*@*"}, "then": [{"answer": {}}, {"ari": {"app": "dograh"}}]},
            {"name": "agent-number-8001", "when": {"to": "8001@*"}, "then": [{"answer": {}}, {"ari": {"app": "dograh"}}]},
        ],
    }


def test_human_routes_survive_and_owned_routes_are_rewritten():
    merged, created, removed = sync.merge(document(), ["8001", "8005"], "dograh")
    names = [route["name"] for route in merged["routes"]]
    assert names[0] == "agent-dids", "a hand-written route must keep its place"
    assert "agent-number-8001" in names and "agent-number-8005" in names
    assert created == ["8005"] and removed == [], (created, removed)


def test_a_number_dograh_stopped_advertising_is_removed():
    merged, created, removed = sync.merge(document(), [], "dograh")
    assert created == [] and removed == ["agent-number-8001"]
    assert [route["name"] for route in merged["routes"]] == ["agent-dids"]


def test_the_owned_route_names_the_configured_application():
    merged, _, _ = sync.merge(document(), ["9000"], "pipecat")
    route = next(entry for entry in merged["routes"] if entry["name"] == "agent-number-9000")
    assert route["then"][-1] == {"ari": {"app": "pipecat"}}
    assert route["when"] == {"to": "9000@*"}
