#!/usr/bin/env python3
"""Unit tests for dashboard-backend/app/workflows.py — the dograh workflow
authoring helpers behind the Control Center Workflows page and the inline
create/edit flow in the Agents modals.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v

The graph builders are pure dicts and the LLM call is mocked at
urllib.request.urlopen — no network, no OmniRoute, no .env required.
"""

import json
import os
import sys
import unittest
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import workflows  # noqa: E402


class FakeResponse:
    def __init__(self, body=b"{}"):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TriggerSlugTest(unittest.TestCase):
    def test_slugifies(self):
        self.assertEqual(workflows.trigger_slug("Appointment Reminders"), "appointment-reminders")

    def test_collapses_punctuation(self):
        self.assertEqual(workflows.trigger_slug("IT Help Desk (Tier 1)!"), "it-help-desk-tier-1")

    def test_empty_falls_back(self):
        self.assertEqual(workflows.trigger_slug(""), "custom-agent")


class BuildWorkflowTest(unittest.TestCase):
    def _build(self):
        return workflows.build_workflow(
            name="Dental",
            trigger_path="dental",
            persona_prompt="You are a dental receptionist.",
            greeting="Hello!",
            script_prompt="Confirm the appointment.",
            close_prompt="Thank them.",
        )

    def test_graph_shape(self):
        wf = self._build()
        self.assertEqual(wf["name"], "Dental")
        types = [n["type"] for n in wf["nodes"]]
        self.assertEqual(types, ["globalNode", "trigger", "startCall", "agentNode", "endCall"])
        self.assertEqual(len(wf["edges"]), 2)
        by_id = {n["id"]: n for n in wf["nodes"]}
        self.assertEqual(by_id["node-global"]["data"]["prompt"], "You are a dental receptionist.")
        self.assertEqual(by_id["node-start"]["data"]["greeting"], "Hello!")
        self.assertEqual(by_id["node-script"]["data"]["prompt"], "Confirm the appointment.")
        self.assertEqual(by_id["node-close"]["data"]["prompt"], "Thank them.")
        self.assertEqual(by_id["node-trigger"]["data"]["trigger_path"], "dental")

    def test_edges_connect_start_script_close(self):
        wf = self._build()
        edges = {(e["source"], e["target"]) for e in wf["edges"]}
        self.assertEqual(edges, {("node-start", "node-script"), ("node-script", "node-close")})


class GuidedPiecesTest(unittest.TestCase):
    def test_inbound_greeting_is_static(self):
        pieces = workflows.guided_pieces("Dental", "inbound", "a receptionist", "book visits", "x")
        self.assertIn("Dental", pieces["greeting"])
        self.assertIn("a receptionist", pieces["persona"])
        self.assertIn("x", pieces["script"])

    def test_outbound_greeting_uses_contact_placeholder(self):
        pieces = workflows.guided_pieces("Sales", "outbound", "a sales rep", "book demos", "x")
        self.assertIn("initial_context.contact_name", pieces["greeting"])


class GenerateDefinitionTest(unittest.TestCase):
    def test_blank_mode_builds_edit_ready_graph(self):
        wf = workflows.generate_definition("My Agent", "blank", {})
        node_ids = {n["id"] for n in wf["nodes"]}
        self.assertIn("node-start", node_ids)
        self.assertEqual(wf["name"], "My Agent")

    def test_guided_mode_uses_payload(self):
        wf = workflows.generate_definition(
            "Helpdesk", "guided",
            {"role": "an IT helper", "goal": "fix tickets", "prompt": "diagnose"},
        )
        persona = next(n for n in wf["nodes"] if n["id"] == "node-global")
        self.assertIn("an IT helper", persona["data"]["prompt"])

    def test_unknown_mode_raises(self):
        with self.assertRaises(workflows.WorkflowError):
            workflows.generate_definition("X", "nope", {})

    def test_ai_mode_requires_description(self):
        with self.assertRaises(workflows.WorkflowError):
            workflows.generate_definition("X", "ai", {})

    @mock.patch.object(urllib.request, "urlopen")
    def test_ai_mode_parses_gateway_json(self, m_url):
        content = json.dumps({
            "persona": "You are friendly.",
            "greeting": "Hi there!",
            "script": "Ask questions.",
            "close": "Bye.",
        })
        m_url.return_value = FakeResponse(
            json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        )
        wf = workflows.generate_definition("AI Agent", "ai", {"description": "a friendly caller"})
        req = m_url.call_args[0][0]
        self.assertTrue(req.full_url.endswith("/v1/chat/completions"))
        persona = next(n for n in wf["nodes"] if n["id"] == "node-global")
        self.assertEqual(persona["data"]["prompt"], "You are friendly.")

    @mock.patch.object(urllib.request, "urlopen")
    def test_ai_mode_strips_markdown_fences(self, m_url):
        inner = json.dumps({"persona": "p", "greeting": "g", "script": "s", "close": "c"})
        content = f"```json\n{inner}\n```"
        m_url.return_value = FakeResponse(
            json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        )
        wf = workflows.generate_definition("AI Agent", "ai", {"description": "x"})
        self.assertEqual(wf["name"], "AI Agent")

    @mock.patch.object(urllib.request, "urlopen")
    def test_ai_mode_non_json_raises(self, m_url):
        m_url.return_value = FakeResponse(
            json.dumps({"choices": [{"message": {"content": "not json"}}]}).encode()
        )
        with self.assertRaises(workflows.WorkflowError):
            workflows.generate_definition("X", "ai", {"description": "x"})


class EditableNodesTest(unittest.TestCase):
    def _definition(self):
        return workflows.generate_definition("Dental", "guided", {
            "role": "a receptionist", "goal": "book visits", "prompt": "confirm",
        })

    def test_extracts_prompt_nodes_only(self):
        nodes = workflows.editable_nodes(self._definition())
        ids = [n["id"] for n in nodes]
        self.assertEqual(ids, ["node-global", "node-start", "node-script", "node-close"])
        start = next(n for n in nodes if n["id"] == "node-start")
        self.assertIn("greeting", start)
        self.assertIn("prompt", start)

    def test_empty_definition(self):
        self.assertEqual(workflows.editable_nodes(None), [])

    def test_apply_edits_updates_prompts_and_greeting(self):
        definition = self._definition()
        merged = workflows.apply_node_edits(definition, [
            {"id": "node-global", "prompt": "NEW PERSONA"},
            {"id": "node-start", "greeting": "NEW GREETING"},
            {"id": "node-script", "prompt": "NEW SCRIPT"},
        ])
        by_id = {n["id"]: n for n in merged["nodes"]}
        self.assertEqual(by_id["node-global"]["data"]["prompt"], "NEW PERSONA")
        self.assertEqual(by_id["node-start"]["data"]["greeting"], "NEW GREETING")
        self.assertEqual(by_id["node-script"]["data"]["prompt"], "NEW SCRIPT")
        # Original definition is not mutated.
        self.assertNotEqual(
            next(n for n in definition["nodes"] if n["id"] == "node-global")["data"]["prompt"],
            "NEW PERSONA",
        )

    def test_apply_edits_ignores_unknown_and_protected_nodes(self):
        definition = self._definition()
        merged = workflows.apply_node_edits(definition, [
            {"id": "nope", "prompt": "x"},
            {"id": "node-trigger", "prompt": "should not be editable"},
        ])
        trigger = next(n for n in merged["nodes"] if n["id"] == "node-trigger")
        self.assertNotIn("prompt", trigger["data"])

    def test_apply_edits_can_rename(self):
        merged = workflows.apply_node_edits(self._definition(), [
            {"id": "node-script", "name": "Renamed"},
        ])
        node = next(n for n in merged["nodes"] if n["id"] == "node-script")
        self.assertEqual(node["data"]["name"], "Renamed")


if __name__ == "__main__":
    unittest.main()
