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

import base64
import json
import os
import re
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
        # The ARI app dograh generates per telephony config (dograh_<hex>).
        # The PBX dialplan must route into THIS, never the bare "dograh".
        self.stasis_app = "dograh_deadbeef"
        self.numbers = [
            {"id": 10, "address": "8003", "label": "Reception",
             "inbound_workflow_id": 1, "is_active": True},
        ]
        # Parked ARI config: dograh disables a config whose connection keeps
        # failing and never retries it, so the recover path must reactivate it.
        self.config_inactive = False

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
        if method == "GET" and path == "/api/v1/organizations/telephony-configs/7":
            return FakeResponse({
                "id": 7, "name": "Asterisk ARI (dograh)",
                "inactive": self.config_inactive,
                "credentials": {"stasis_app_name": self.stasis_app},
            })
        if method == "POST" and path == "/api/v1/organizations/telephony-configs/7/reactivate":
            self.config_inactive = False
            return FakeResponse({"status": "reactivated"})
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


class FakePbx:
    """Stand-in for pbx-freepbx's exec surface: a dict-backed /etc/asterisk.

    `main._pbx_exec` is patched to this callable, so `_pbx_read_conf` /
    `_pbx_write_conf` / the `rm -f` cleanup all run for real against an
    in-memory filesystem — no docker, no FreePBX.
    """

    def __init__(self, files: dict[str, str] | None = None,
                 ari_apps: tuple[str, ...] = ("dograh_deadbeef",)) -> None:
        self.files: dict[str, str] = dict(files or {})
        self.commands: list[list[str]] = []
        self.ari_apps: list[str] = list(ari_apps)

    def __call__(self, cmd, stdin_text=None):  # noqa: ARG002 - _pbx_exec signature
        self.commands.append(list(cmd))
        if cmd[:1] == ["cat"] and len(cmd) == 2:
            content = self.files.get(cmd[1])
            return (0, content) if content is not None else (1, "")
        if cmd[:2] == ["sh", "-c"]:
            # _pbx_write_conf: echo <base64> | base64 -d > '<path>'.
            # Anything else (e.g. _pbx_mysql's `... | mysql`) yields no rows.
            m = re.fullmatch(r"echo (\S+) \| base64 -d > '(.+)'", cmd[2])
            if m:
                self.files[m.group(2)] = base64.b64decode(m.group(1)).decode()
            return (0, "")
        if cmd[:2] == ["rm", "-f"]:
            self.files.pop(cmd[2], None)
            return (0, "")
        if cmd[:3] == ["asterisk", "-rx", "ari show apps"]:
            return (0, "Application Name         \n=========================\n"
                       + "\n".join(self.ari_apps) + "\n")
        return (0, "")

    def has(self, needle: str, path: str) -> bool:
        return needle in self.files.get(path, "")


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed — skipping route tests")
class PbxDynamicDialplanTest(unittest.TestCase):
    """`_pbx_sync_dynamic_dialplan` end-to-end with a live dograh client.

    Regression for the "extension 8008 rings then drops" bug: the generated
    extensions_custom_dograh.conf must call Stasis(<dograh_<hex>>) — the app
    dograh actually registers — and must discover it from dograh's telephony
    config even when DOGRAH_STASIS_APP_NAME is unset.
    """

    CONF = "/etc/asterisk/extensions_custom.conf"
    DYN = "/etc/asterisk/extensions_custom_dograh.conf"

    def setUp(self):
        os.environ["DOGRAH_API_TOKEN"] = "TEST-TOKEN"
        os.environ["DOGRAH_API_ENDPOINT"] = ENDPOINT
        os.environ["DOGRAH_CONFIG_NAME"] = "Asterisk ARI (dograh)"
        os.environ.pop("DOGRAH_STASIS_APP_NAME", None)
        self.dograh = FakeDograh()
        self.dograh.numbers.append({
            "id": 11, "address": "8008", "label": "Mock Interview - Full Stack",
            "inbound_workflow_id": 1, "is_active": True,
        })
        self.urlopen = mock.patch("urllib.request.urlopen", side_effect=self.dograh)
        self.urlopen.start()
        # The conf defines the static block for 8003 (as a converged
        # standalone entrypoint would), so the sync leaves it alone; the
        # heal-when-missing path is exercised by its own test.
        self.pbx = FakePbx({self.CONF: (
            "[dograh-inbound]\n"
            "exten => 8003,1,NoOp(Dograh voice agent inbound)\n"
            " same => n,Stasis(dograh_deadbeef)\n"
            " same => n,Hangup()\n"
            "[from-internal]\n"
            "exten => 101,1,Dial(SIP/101)\n"
        )})
        self.exec_patch = mock.patch.object(main, "_pbx_exec", side_effect=self.pbx)
        self.exec_patch.start()

    def tearDown(self):
        self.exec_patch.stop()
        self.urlopen.stop()
        for key in ("DOGRAH_API_TOKEN", "DOGRAH_API_ENDPOINT", "DOGRAH_CONFIG_NAME",
                    "DOGRAH_STASIS_APP_NAME"):
            os.environ.pop(key, None)

    def test_sync_writes_dynamic_dialplan_routing_to_the_registered_app(self):
        main._pbx_sync_dynamic_dialplan(main.agents.DograhClient())

        body = self.pbx.files[self.DYN]
        self.assertIn("exten => 8008,1,NoOp(Dograh voice agent inbound)", body)
        self.assertIn("Stasis(dograh_deadbeef)", body)  # discovered live
        self.assertIn("Goto(dograh-inbound,8008,1)", body)
        # The static block the conf already defines is never re-emitted.
        self.assertNotIn("exten => 8003,1,NoOp", body)
        # And the include is wired into extensions_custom.conf.
        self.assertIn("#include extensions_custom_dograh.conf",
                      self.pbx.files[self.CONF])

    def test_sync_is_idempotent(self):
        main._pbx_sync_dynamic_dialplan(main.agents.DograhClient())
        first = self.pbx.files[self.DYN]
        main._pbx_sync_dynamic_dialplan(main.agents.DograhClient())
        self.assertEqual(first, self.pbx.files[self.DYN])
        # The #include must not be appended twice.
        self.assertEqual(
            self.pbx.files[self.CONF].count("#include extensions_custom_dograh.conf"), 1
        )

    def test_env_override_wins_over_discovery(self):
        with mock.patch.dict(os.environ, {"DOGRAH_STASIS_APP_NAME": "dograh_from_env"}):
            main._pbx_sync_dynamic_dialplan(main.agents.DograhClient())
        self.assertIn("Stasis(dograh_from_env)", self.pbx.files[self.DYN])
        self.assertNotIn("Stasis(dograh_deadbeef)", self.pbx.files[self.DYN])

    def test_sync_removes_include_when_no_dynamic_numbers(self):
        self.pbx.files[self.DYN] = "; stale\n"
        # The static block is defined where it belongs, so the only agent here
        # (8003, static) leaves the dynamic file with nothing of its own.
        self.pbx.files[self.CONF] = (
            "[dograh-inbound]\n"
            "exten => 8003,1,NoOp(Dograh voice agent inbound)\n"
            " same => n,Stasis(dograh_deadbeef)\n"
            " same => n,Hangup()\n"
            "[from-internal]\n#include extensions_custom_dograh.conf\n"
        )
        self.dograh.numbers = [
            {"id": 10, "address": "8003", "label": "Reception",
             "inbound_workflow_id": 1, "is_active": True},
        ]
        main._pbx_sync_dynamic_dialplan(main.agents.DograhClient())
        self.assertNotIn(self.DYN, self.pbx.files)
        self.assertNotIn("#include extensions_custom_dograh.conf",
                         self.pbx.files[self.CONF])

    def test_sync_heals_a_missing_static_agent_block(self):
        # Shared-PBX regression: extensions_custom.conf lost its
        # [dograh-inbound] block, so every DID routed at dograh-inbound,80NN was
        # an invalid extension and the caller heard "busy". The sync must
        # re-supply the static lines — with the same envelope + voicemail
        # fallback as the canonical fragment — so the Agents page repair closes
        # the outage on its own.
        # The conf lost its static block — the shared-PBX failure mode.
        self.pbx.files[self.CONF] = "[from-internal]\nexten => 101,1,Dial(SIP/101)\n"
        main._pbx_sync_dynamic_dialplan(main.agents.DograhClient())
        body = self.pbx.files[self.DYN]
        self.assertIn("exten => 8003,1,NoOp(Dograh voice agent inbound)", body)
        self.assertIn("Stasis(dograh_deadbeef)", body)
        self.assertIn("Set(AI_CALL_ID=${UNIQUEID})", body)
        self.assertIn("Set(AI_CONTEXT_TOKEN=${UNIQUEID})", body)
        self.assertIn("VoiceMail(${DOGRAH_VM_MAILBOX}@default,u)", body)
        self.assertIn("Goto(dograh-inbound,8003,1)", body)
        # Healed once the conf defines it — the static block is never duplicated
        # across the two files, and the dynamic number still stays.
        self.pbx.files[self.CONF] += (
            "[dograh-inbound]\n"
            "exten => 8003,1,NoOp(Dograh voice agent inbound)\n"
        )
        main._pbx_sync_dynamic_dialplan(main.agents.DograhClient())
        healed = self.pbx.files[self.DYN]
        self.assertNotIn("exten => 8003,1,NoOp", healed)
        self.assertIn("exten => 8008,1,NoOp", healed)

    def test_sync_leaves_the_static_block_to_the_conf_that_defines_it(self):
        self.pbx.files[self.CONF] = (
            "[dograh-inbound]\n"
            "exten => 8003,1,NoOp(Dograh voice agent inbound)\n"
            " same => n,Stasis(dograh_deadbeef)\n"
            " same => n,Hangup()\n"
            "[from-internal]\n"
        )
        main._pbx_sync_dynamic_dialplan(main.agents.DograhClient())
        body = self.pbx.files[self.DYN]
        self.assertNotIn("exten => 8003,1,NoOp", body)   # not duplicated
        self.assertIn("exten => 8008,1,NoOp", body)      # the dynamic one stays

    # ── _stasis_health: the Agents page warning ────────────────────────────

    def test_stasis_health_ok_when_the_app_is_registered(self):
        health = main._stasis_health(
            main.agents.DograhClient(), [{"extension": "8008"}]
        )
        self.assertTrue(health["ok"])
        self.assertEqual(health["expected"], "dograh_deadbeef")
        self.assertEqual(health["dynamicExtensions"], ["8008"])
        self.assertEqual(health["registered"], ["dograh_deadbeef"])

    def test_stasis_health_flags_an_unregistered_app(self):
        self.pbx.ari_apps = ["some_other_app"]
        health = main._stasis_health(
            main.agents.DograhClient(), [{"extension": "8008", "id": 11}]
        )
        self.assertFalse(health["ok"])
        self.assertIn("hang up immediately", health["detail"])
        self.assertIn("dograh_deadbeef", health["detail"])

    def test_stasis_health_ignores_static_only_agents(self):
        health = main._stasis_health(
            main.agents.DograhClient(), [{"extension": "8003"}]
        )
        self.assertTrue(health["ok"])
        self.assertEqual(health["dynamicExtensions"], [])
        # Never touches the PBX when nothing is dynamic.
        self.assertEqual([c for c in self.pbx.commands if c[:1] == ["asterisk"]], [])

    def test_agents_route_reports_stasis_health(self):
        os.environ["DOGRAH_API_TOKEN"] = "TEST-TOKEN"
        os.environ["DOGRAH_API_ENDPOINT"] = ENDPOINT
        os.environ["DOGRAH_CONFIG_NAME"] = "Asterisk ARI (dograh)"
        with mock.patch.dict(main.app.dependency_overrides,
                             {main.require_session: lambda: {"email": "ops@test", "role": "admin"}}):
            client = TestClient(main.app)
            body = client.get("/agents").json()
        self.assertIn("stasis", body)
        self.assertTrue(body["stasis"]["ok"])

    # ── the Agents-page "Repair ARI" action ───────────────────────────────

    def test_stasis_recover_unparks_and_reasserts_the_app(self):
        self.dograh.config_inactive = True
        with mock.patch.dict(main.app.dependency_overrides,
                             {main.require_session: lambda: {"email": "ops@test", "role": "admin"}}):
            client = TestClient(main.app)
            res = client.post("/agents/stasis/recover")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["status"], "recovered")
        self.assertEqual(body["app"], "dograh_deadbeef")
        self.assertIn("dograh_deadbeef", body["registered"])
        # The parked config was reactivated, on dograh.
        self.assertFalse(self.dograh.config_inactive)
        self.assertIn(
            ("POST", "/api/v1/organizations/telephony-configs/7/reactivate"),
            self.dograh.calls,
        )
        # The static dialplan was re-pointed at the discovered app...
        sed = [c for c in self.pbx.commands
               if c[:2] == ["sh", "-c"] and "Stasis(dograh_deadbeef)" in c[2]]
        self.assertTrue(sed)
        # ...and the dynamic dialplan re-synced with it.
        self.assertIn("Stasis(dograh_deadbeef)", self.pbx.files[self.DYN])

    def test_stasis_recover_reports_pending_when_dograh_has_not_reconnected(self):
        # ARI is up but dograh still hasn't registered the app: report pending,
        # not an error — the caller re-polls /agents.
        self.dograh.stasis_app = "dograh_cafebabe"
        self.pbx.ari_apps = ["dograh_deadbeef"]
        with mock.patch.dict(os.environ, {"STASIS_RECOVER_WAIT_S": "0"}):
            with mock.patch.dict(main.app.dependency_overrides,
                                 {main.require_session: lambda: {"email": "ops@test", "role": "admin"}}):
                body = TestClient(main.app).post("/agents/stasis/recover").json()
        self.assertEqual(body["status"], "pending")
        self.assertEqual(body["app"], "dograh_cafebabe")
        self.assertNotIn("dograh_cafebabe", body["registered"])

    def test_static_stasis_rewrite_refuses_unsafe_names(self):
        with self.assertRaises(main.HTTPException):
            main._pbx_set_static_stasis_app("dograh; rm -rf /")
        with self.assertRaises(main.HTTPException):
            main._pbx_set_static_stasis_app("")


if __name__ == "__main__":
    unittest.main()
