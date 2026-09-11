#!/usr/bin/env python3
"""Route-level tests for the dograh workflow endpoints in app/main.py.

Drives the real FastAPI app (auth dependency overridden) with a fake dograh at
the urllib transport, so the whole Control Center -> dograh path is exercised:
list, create, get, update+publish and archive (including the bound-agent guard).

Needs the dashboard-api dependencies (fastapi + httpx). It is skipped in a bare
interpreter and runs wherever `pip install -r dashboard-backend/requirements.txt`
has been done, e.g.:

    docker compose run --rm --no-deps \
      -v "$PWD/dashboard-backend/tests:/app/tests:ro" \
      dashboard-api python -m unittest discover -s tests -v

Run with:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:  # pragma: no cover - depends on the environment
    from fastapi.testclient import TestClient

    from app import main

    _HAVE_DEPS = True
except Exception:  # noqa: BLE001 - any import failure means the deps are absent
    _HAVE_DEPS = False

ENDPOINT = "http://dograh.test"


class FakeResponse:
    def __init__(self, payload, status=200):
        self._body = json.dumps(payload).encode()
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeDograh:
    """Stateful stand-in for the dograh REST API (urllib request callback)."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []
        self.workflows = {
            1: {
                "id": 1,
                "name": "Business Receptionist",
                "status": "active",
                "workflow_definition": {
                    "nodes": [
                        {"id": "node-global", "type": "globalNode",
                         "data": {"name": "Agent Persona", "prompt": "persona"}},
                        {"id": "node-start", "type": "startCall",
                         "data": {"name": "Open & Greet", "prompt": "opening",
                                  "greeting": "Hi!"}},
                        {"id": "node-close", "type": "endCall",
                         "data": {"name": "Wrap", "prompt": "bye"}},
                    ],
                    "edges": [],
                },
            },
        }
        self.next_id = 2
        self.numbers = [
            {"id": 10, "address": "8003", "label": "Reception",
             "inbound_workflow_id": 1, "is_active": True},
        ]

    def _workflow_response(self, wider: int) -> dict:
        w = self.workflows[wider]
        return {"id": wider, "name": w["name"], "status": w["status"],
                "workflow_definition": w["workflow_definition"]}

    def __call__(self, req, timeout=None):  # noqa: ARG002 - urlopen signature
        method = req.get_method()
        path = req.full_url.split(ENDPOINT, 1)[1]
        body = json.loads(req.data) if req.data else None
        self.calls.append((method, path))

        if method == "GET" and path == "/api/v1/workflow/fetch":
            return FakeResponse([
                {"id": w["id"], "name": w["name"], "status": w["status"]}
                for w in self.workflows.values()
            ])
        if method == "GET" and path.startswith("/api/v1/workflow/fetch/"):
            return FakeResponse(self._workflow_response(int(path.rsplit("/", 1)[1])))
        if method == "POST" and path == "/api/v1/workflow/create/definition":
            wid = self.next_id
            self.next_id += 1
            self.workflows[wid] = {
                "id": wid, "name": body["name"], "status": "active",
                "workflow_definition": body["workflow_definition"],
            }
            return FakeResponse(self._workflow_response(wid))
        if method == "POST" and path.endswith("/publish"):
            return FakeResponse({"status": "published"})
        if method == "PUT" and path.endswith("/status"):
            wid = int(path.split("/api/v1/workflow/", 1)[1].split("/", 1)[0])
            self.workflows[wid]["status"] = body["status"]
            return FakeResponse(self._workflow_response(wid))
        if method == "PUT" and path.startswith("/api/v1/workflow/"):
            wid = int(path.rsplit("/", 1)[1])
            w = self.workflows[wid]
            if body.get("name"):
                w["name"] = body["name"]
            if body.get("workflow_definition"):
                w["workflow_definition"] = body["workflow_definition"]
            return FakeResponse(self._workflow_response(wid))
        if method == "GET" and path == "/api/v1/organizations/telephony-configs":
            return FakeResponse({"configurations": [{"id": 7, "name": "Asterisk ARI (dograh)"}]})
        if method == "GET" and path.endswith("/phone-numbers"):
            return FakeResponse({"phone_numbers": self.numbers})
        raise AssertionError(f"unexpected dograh request: {method} {path}")

    def paths(self, method: str) -> list[str]:
        return [p for m, p in self.calls if m == method]


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed — skipping route tests")
class WorkflowRoutesTest(unittest.TestCase):
    def setUp(self):
        os.environ["DOGRAH_API_TOKEN"] = "TEST-TOKEN"
        os.environ["DOGRAH_API_ENDPOINT"] = ENDPOINT
        os.environ["DOGRAH_CONFIG_NAME"] = "Asterisk ARI (dograh)"
        self.dograh = FakeDograh()
        self.urlopen = mock.patch("urllib.request.urlopen", side_effect=self.dograh)
        self.urlopen.start()
        self.deps = mock.patch.dict(
            main.app.dependency_overrides,
            {main.require_session: lambda: {"email": "ops@test", "role": "admin"}},
        )
        self.deps.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.deps.stop()
        self.urlopen.stop()
        for key in ("DOGRAH_API_TOKEN", "DOGRAH_API_ENDPOINT", "DOGRAH_CONFIG_NAME"):
            os.environ.pop(key, None)

    def test_list_workflows(self):
        res = self.client.get("/workflows")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), [
            {"id": 1, "name": "Business Receptionist", "status": "active"},
        ])

    def test_get_workflow_returns_editable_nodes(self):
        res = self.client.get("/workflows/1")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["name"], "Business Receptionist")
        self.assertEqual([n["id"] for n in body["nodes"]],
                         ["node-global", "node-start", "node-close"])
        start = next(n for n in body["nodes"] if n["id"] == "node-start")
        self.assertEqual(start["greeting"], "Hi!")

    def test_create_workflow_guided(self):
        res = self.client.post("/workflows", json={
            "name": "Dental Reminders", "mode": "guided",
            "role": "a receptionist", "goal": "book visits", "prompt": "confirm",
        })
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["name"], "Dental Reminders")
        self.assertEqual(body["id"], 2)
        self.assertTrue(body["nodes"])
        self.assertIn("/api/v1/workflow/create/definition",
                      self.dograh.paths("POST"))

    def test_create_workflow_requires_name(self):
        res = self.client.post("/workflows", json={"name": "  ", "mode": "guided"})
        self.assertEqual(res.status_code, 422)

    def test_create_workflow_blank_mode(self):
        res = self.client.post("/workflows", json={"name": "Scratch", "mode": "blank"})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["nodes"])

    def test_update_workflow_edits_prompts_and_publishes(self):
        res = self.client.put("/workflows/1", json={
            "name": "Front Desk",
            "nodes": [
                {"id": "node-global", "prompt": "NEW PERSONA"},
                {"id": "node-start", "greeting": "NEW GREETING"},
            ],
        })
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["name"], "Front Desk")
        by_id = {n["id"]: n for n in body["nodes"]}
        self.assertEqual(by_id["node-global"]["prompt"], "NEW PERSONA")
        self.assertEqual(by_id["node-start"]["greeting"], "NEW GREETING")
        # Saved as a draft then published — dograh's own flow.
        self.assertIn("/api/v1/workflow/1", self.dograh.paths("PUT"))
        self.assertIn("/api/v1/workflow/1/publish", self.dograh.paths("POST"))

    def test_archive_blocked_while_bound_to_an_agent(self):
        res = self.client.put("/workflows/1/status", json={"status": "archived"})
        self.assertEqual(res.status_code, 409)
        self.assertIn("Reception", res.json()["detail"])
        self.assertNotIn("/api/v1/workflow/1/status", self.dograh.paths("PUT"))

    def test_archive_with_force(self):
        res = self.client.put("/workflows/1/status",
                              json={"status": "archived", "force": True})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "archived")

    def test_archive_allowed_when_unbound(self):
        self.dograh.numbers = []
        res = self.client.put("/workflows/1/status", json={"status": "archived"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "archived")

    def test_restore_does_not_need_force(self):
        self.dograh.workflows[1]["status"] = "archived"
        res = self.client.put("/workflows/1/status", json={"status": "active"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "active")

    def test_invalid_status_rejected(self):
        res = self.client.put("/workflows/1/status", json={"status": "deleted"})
        self.assertEqual(res.status_code, 422)


if __name__ == "__main__":
    unittest.main()
