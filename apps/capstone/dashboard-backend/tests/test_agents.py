#!/usr/bin/env python3
"""Unit tests for dashboard-backend/app/agents.py — the dograh voice-agent
client + FreePBX wiring builders used by the Control Center Agents page.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v

Everything is mocked at urllib.request.urlopen — no network, no dograh, no
FreePBX, no .env required. The SQL/conf builders are pure strings, so they
are asserted byte-for-byte against the sync-tool contract
(scripts/sync_dograh_routes.py / pbx/bootstrap_dograh_route.py).
"""

import io
import json
import os
import sys
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import agents  # noqa: E402

BASE = "http://dograh.test:8000"
CONFIG = "Asterisk ARI (dograh)"


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


def make_client(token="TOK"):
    return agents.DograhClient(BASE, token, CONFIG)


def captured_request(mock_urlopen):
    mock_urlopen.assert_called_once()
    return mock_urlopen.call_args[0][0]


def header(req, name):
    lowered = {k.lower(): v for k, v in req.headers.items()}
    return lowered.get(name.lower())


class DeployModeTest(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("CAPSTONE_DEPLOY_MODE", None)

    def test_standalone_default(self):
        os.environ.pop("CAPSTONE_DEPLOY_MODE", None)
        self.assertEqual(agents.deploy_mode(), "standalone")

    def test_addon_aliases(self):
        for raw in ("addon", "add-on", "zeus", "shared", "  ADDON  "):
            with self.subTest(raw=raw):
                os.environ["CAPSTONE_DEPLOY_MODE"] = raw
                self.assertEqual(agents.deploy_mode(), "addon")

    def test_anything_else_is_standalone(self):
        os.environ["CAPSTONE_DEPLOY_MODE"] = "bogus"
        self.assertEqual(agents.deploy_mode(), "standalone")


class ExtensionFromAddressTest(unittest.TestCase):
    def test_digits_only(self):
        self.assertEqual(agents.extension_from_address("8003"), "8003")

    def test_e164_strips_prefix(self):
        self.assertEqual(agents.extension_from_address("+12125551234"), "12125551234")

    def test_punctuation_stripped(self):
        self.assertEqual(agents.extension_from_address("(212) 555-1234"), "2125551234")

    def test_empty(self):
        self.assertEqual(agents.extension_from_address(""), "")
        self.assertEqual(agents.extension_from_address(None), "")


class DescriptionTest(unittest.TestCase):
    def test_marker_and_purpose(self):
        self.assertEqual(
            agents.agent_description("label", "Mock Interview"),
            "Dograh Voice Agent (Mock Interview)",
        )

    def test_label_fallback_and_ascii_cap(self):
        d = agents.agent_description("Business Receptionist — ☃", "")
        self.assertLessEqual(len(d), 40)
        self.assertNotIn("☃", d)
        self.assertTrue(d.startswith("Dograh Voice Agent ("))


class ConfigIdTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_resolves_config_by_name(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps({"configurations": [
                {"id": 7, "name": "Other"},
                {"id": 3, "name": CONFIG},
            ]}).encode())
        client = make_client()
        self.assertEqual(client.config_id(), 3)
        req = captured_request(m_url)
        self.assertTrue(req.full_url.endswith("/api/v1/organizations/telephony-configs"))
        self.assertEqual(header(req, "X-API-Key"), "TOK")

    @mock.patch.object(urllib.request, "urlopen")
    def test_missing_config_raises(self, m_url):
        m_url.return_value = FakeResponse(200, json.dumps({"configurations": []}).encode())
        client = make_client()
        with self.assertRaises(agents.DograhError) as ctx:
            client.config_id()
        self.assertIn("no telephony config", str(ctx.exception))

    def test_unconfigured_client(self):
        self.assertFalse(make_client("").configured())
        self.assertTrue(make_client("TOK").configured())


class ListAgentsTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_normalizes_phone_numbers(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps({"phone_numbers": [
                {"id": 1, "address": "8000", "label": "IT Help Desk",
                 "inbound_workflow_id": 42, "inbound_workflow_name": "Mock Interview",
                 "is_active": True},
                {"id": 2, "address": "+12125551234", "label": None,
                 "inbound_workflow_id": None, "is_active": False},
            ]}).encode())
        client = make_client()
        client._config_id = 3
        rows = client.list_agents()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["extension"], "8000")
        self.assertEqual(rows[0]["workflowId"], 42)
        self.assertEqual(rows[0]["workflowName"], "Mock Interview")
        self.assertTrue(rows[0]["active"])
        self.assertEqual(rows[1]["extension"], "12125551234")
        self.assertEqual(rows[1]["workflowName"], "")
        self.assertFalse(rows[1]["active"])

    @mock.patch.object(urllib.request, "urlopen")
    def test_http_error_surfaces_dograh_detail(self, m_url):
        m_url.side_effect = urllib.error.HTTPError(
            f"{BASE}/x", 401, "Unauthorized", {},
            io.BytesIO(b'{"detail":"bad token"}'))
        client = make_client()
        with self.assertRaises(agents.DograhError) as ctx:
            client.list_agents()
        self.assertIn("401", str(ctx.exception))
        self.assertIn("bad token", str(ctx.exception))

    @mock.patch.object(urllib.request, "urlopen")
    def test_unreachable_raises(self, m_url):
        m_url.side_effect = urllib.error.URLError("connection refused")
        client = make_client()
        with self.assertRaises(agents.DograhError) as ctx:
            client.list_agents()
        self.assertIn("unreachable", str(ctx.exception))


class WorkflowsTest(unittest.TestCase):
    @mock.patch.object(urllib.request, "urlopen")
    def test_fetch_endpoint_returns_id_name_pairs(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps([
                {"id": 9, "name": "Mock Interview", "status": "active"},
                {"id": 10, "name": "Receptionist", "status": "archived"},
            ]).encode())
        client = make_client()
        rows = client.list_workflows()
        req = captured_request(m_url)
        self.assertTrue(req.full_url.endswith("/api/v1/workflow/fetch"))
        self.assertEqual(rows, [{"id": 9, "name": "Mock Interview", "status": "active"},
                                {"id": 10, "name": "Receptionist", "status": "archived"}])

    @mock.patch.object(urllib.request, "urlopen")
    def test_dict_envelope_fallback(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps({"workflows": [{"id": 1, "title": "Survey"}]}).encode())
        self.assertEqual(make_client().list_workflows(),
                         [{"id": 1, "name": "Survey", "status": ""}])

    @mock.patch.object(urllib.request, "urlopen")
    def test_get_workflow_returns_definition(self, m_url):
        definition = {"nodes": [{"id": "node-start", "type": "startCall"}], "edges": []}
        m_url.return_value = FakeResponse(
            200, json.dumps({"id": 4, "name": "Receptionist", "status": "active",
                             "workflow_definition": definition}).encode())
        wf = make_client().get_workflow(4)
        req = captured_request(m_url)
        self.assertEqual(req.get_method(), "GET")
        self.assertTrue(req.full_url.endswith("/api/v1/workflow/fetch/4"))
        self.assertEqual(wf["id"], 4)
        self.assertEqual(wf["name"], "Receptionist")
        self.assertEqual(wf["status"], "active")
        self.assertEqual(wf["definition"], definition)

    @mock.patch.object(urllib.request, "urlopen")
    def test_get_workflow_without_definition_sets_none(self, m_url):
        m_url.return_value = FakeResponse(200, json.dumps({"id": 4, "name": "X"}).encode())
        self.assertIsNone(make_client().get_workflow(4)["definition"])

    @mock.patch.object(urllib.request, "urlopen")
    def test_create_workflow_posts_definition(self, m_url):
        m_url.return_value = FakeResponse(200, json.dumps({"id": 11, "name": "Dental"}).encode())
        client = make_client()
        wf = client.create_workflow(name="Dental", definition={"nodes": [], "edges": []})
        req = captured_request(m_url)
        self.assertEqual(req.get_method(), "POST")
        self.assertTrue(req.full_url.endswith("/api/v1/workflow/create/definition"))
        body = json.loads(req.data)
        self.assertEqual(body["name"], "Dental")
        self.assertEqual(body["workflow_definition"], {"nodes": [], "edges": []})
        self.assertEqual(wf["id"], 11)

    @mock.patch.object(urllib.request, "urlopen")
    def test_update_workflow_puts_and_can_rename(self, m_url):
        m_url.return_value = FakeResponse(200, json.dumps({"id": 4, "name": "New"}).encode())
        client = make_client()
        client.update_workflow(4, definition={"nodes": []}, name="New")
        req = captured_request(m_url)
        self.assertEqual(req.get_method(), "PUT")
        self.assertTrue(req.full_url.endswith("/api/v1/workflow/4"))
        body = json.loads(req.data)
        self.assertEqual(body["name"], "New")
        self.assertEqual(body["workflow_definition"], {"nodes": []})

    def test_update_workflow_without_changes_raises(self):
        with self.assertRaises(agents.DograhError):
            make_client().update_workflow(4)

    @mock.patch.object(urllib.request, "urlopen")
    def test_publish_workflow_posts_publish(self, m_url):
        m_url.return_value = FakeResponse(200, json.dumps({"status": "published"}).encode())
        result = make_client().publish_workflow(4)
        req = captured_request(m_url)
        self.assertEqual(req.get_method(), "POST")
        self.assertTrue(req.full_url.endswith("/api/v1/workflow/4/publish"))
        self.assertEqual(result["status"], "published")

    @mock.patch.object(urllib.request, "urlopen")
    def test_set_workflow_status_puts_status(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps({"id": 4, "name": "Receptionist", "status": "archived"}).encode())
        wf = make_client().set_workflow_status(4, "archived")
        req = captured_request(m_url)
        self.assertEqual(req.get_method(), "PUT")
        self.assertTrue(req.full_url.endswith("/api/v1/workflow/4/status"))
        self.assertEqual(json.loads(req.data)["status"], "archived")
        self.assertEqual(wf["status"], "archived")
        self.assertEqual(wf["name"], "Receptionist")


class MutationsTest(unittest.TestCase):
    def setUp(self):
        # Config resolution is its own call (tested in ConfigIdTest); seed the
        # per-client cache so mutation tests hit only the phone-numbers URL.
        self.client = make_client()
        self.client._config_id = 3

    @mock.patch.object(urllib.request, "urlopen")
    def test_create_posts_phone_number(self, m_url):
        m_url.return_value = FakeResponse(
            200, json.dumps({"id": 5, "address": "8008", "label": "Receptionist",
                             "inbound_workflow_id": 3, "is_active": True}).encode())
        client = self.client
        agent = client.create_agent(address="8008", label="Receptionist", workflow_id=3)
        req = captured_request(m_url)
        self.assertEqual(req.get_method(), "POST")
        self.assertTrue(req.full_url.endswith(
            "/api/v1/organizations/telephony-configs/3/phone-numbers"))
        body = json.loads(req.data)
        self.assertEqual(body["address"], "8008")
        self.assertEqual(body["inbound_workflow_id"], 3)
        self.assertEqual(body["is_active"], True)
        self.assertEqual(agent["extension"], "8008")

    @mock.patch.object(urllib.request, "urlopen")
    def test_update_uses_put_and_clear_flag(self, m_url):
        m_url.return_value = FakeResponse(200, b"{}")
        client = self.client
        client.update_agent(5, label="New Label", clear_workflow=True)
        req = captured_request(m_url)
        self.assertEqual(req.get_method(), "PUT")
        body = json.loads(req.data)
        self.assertEqual(body["label"], "New Label")
        self.assertTrue(body["clear_inbound_workflow"])
        self.assertNotIn("inbound_workflow_id", body)

    @mock.patch.object(urllib.request, "urlopen")
    def test_update_sends_workflow_when_bound(self, m_url):
        m_url.return_value = FakeResponse(200, b"{}")
        client = self.client
        client.update_agent(5, workflow_id=8, is_active=False)
        body = json.loads(captured_request(m_url).data)
        self.assertEqual(body["inbound_workflow_id"], 8)
        self.assertFalse(body["is_active"])

    @mock.patch.object(urllib.request, "urlopen")
    def test_delete_uses_delete_method(self, m_url):
        m_url.return_value = FakeResponse(204, b"")
        client = self.client
        client.delete_agent(5)
        req = captured_request(m_url)
        self.assertEqual(req.get_method(), "DELETE")
        self.assertTrue(req.full_url.endswith(
            "/api/v1/organizations/telephony-configs/3/phone-numbers/5"))


class FreePbxBuildersTest(unittest.TestCase):
    def test_upsert_custom_extension_markers(self):
        sql = agents.upsert_custom_extension_sql("8008", "Receptionist", "Business")
        self.assertIn("INSERT INTO `custom_extensions`", sql)
        self.assertIn("Dograh Voice Agent (Business)", sql)
        self.assertIn("dograh-managed", sql)
        self.assertIn("ON DUPLICATE KEY UPDATE", sql)

    def test_sql_escaping(self):
        sql = agents.upsert_custom_extension_sql("8009", "O'Brien's Agent", "")
        self.assertIn("O''Brien''s Agent", sql)

    def test_delete_custom_extension_targets_ext_only(self):
        sql = agents.delete_custom_extension_sql("8008")
        self.assertIn("DELETE FROM `custom_extensions` WHERE `custom_exten`='8008'", sql)

    def test_custom_dest_json_shape(self):
        dest = agents.custom_dest_json(12, "dograh-inbound,8008,1", "desc")
        self.assertEqual(dest["destid"], 12)
        self.assertEqual(dest["target"], "dograh-inbound,8008,1")
        self.assertEqual(dest["destret"], "")  # empty = fwconsole reload safe

    def test_inbound_route_marker_guard(self):
        sql = agents.delete_inbound_route_sql("8008")
        self.assertIn("`description` LIKE '%Dograh Voice Agent%'", sql)

    def test_counts_are_marker_scoped(self):
        self.assertIn("Dograh Voice Agent", agents.count_custom_extension_sql("8008"))
        self.assertIn("Dograh Voice Agent", agents.count_inbound_route_sql("8008"))

    def test_find_custom_dest_orders_by_key(self):
        sql = agents.find_custom_dest_sql("kvstore_Customappsreg", "dograh-inbound,8008,1")
        self.assertIn("ORDER BY CAST(`key` AS UNSIGNED)", sql)
        self.assertIn("LIMIT 1", sql)

    def test_dialplan_body_dynamic_only(self):
        # 8003 is in the static 8000-8007 set — never re-emitted. Env cleared
        # so the resolved Stasis name is the deterministic legacy default.
        with mock.patch.dict(os.environ, {}, clear=True):
            body = agents.dialplan_body(["8003", "8008", "8012"])
        self.assertIn("exten => 8008,1,NoOp(Dograh voice agent inbound)", body)
        self.assertIn("exten => 8012,1,NoOp(Dograh voice agent inbound)", body)
        self.assertNotIn("exten => 8003,1,NoOp(Dograh voice agent inbound)", body)
        self.assertIn("[dograh-inbound]", body)
        self.assertIn("[from-internal-custom]", body)
        self.assertIn("Stasis(dograh)", body)

    def test_stasis_app_name_env_overrides_placeholder(self):
        with mock.patch.dict(os.environ, {"DOGRAH_STASIS_APP_NAME": "dograh_72e590ef66eb"}):
            self.assertEqual(agents.stasis_app_name(), "dograh_72e590ef66eb")
            # An explicit argument still wins over the environment.
            self.assertEqual(agents.stasis_app_name("dograh_explicit"), "dograh_explicit")

    def test_stasis_app_name_falls_back_to_legacy_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(agents.stasis_app_name(), "dograh")
            self.assertEqual(agents.stasis_app_name(""), "dograh")

    def test_dialplan_body_uses_env_stasis_app(self):
        # Regression: dashboard-generated numbers used to emit Stasis(dograh),
        # an app no ARI client registers — Asterisk fell through to Hangup()
        # and every call to an agent beyond 8000-8007 died.
        with mock.patch.dict(os.environ, {"DOGRAH_STASIS_APP_NAME": "dograh_72e590ef66eb"}):
            body = agents.dialplan_body(["8008"])
        self.assertIn("Stasis(dograh_72e590ef66eb)", body)

    def test_dialplan_body_explicit_stasis_app_wins(self):
        with mock.patch.dict(os.environ, {"DOGRAH_STASIS_APP_NAME": "dograh_env"}):
            body = agents.dialplan_body(["8008"], "dograh_arg")
        self.assertIn("Stasis(dograh_arg)", body)
        self.assertNotIn("Stasis(dograh_env)", body)

    def test_discovered_stasis_app_prefers_env(self):
        client = agents.DograhClient(endpoint="http://example.invalid", token="t")
        with mock.patch.dict(os.environ, {"DOGRAH_STASIS_APP_NAME": "dograh_env"}):
            self.assertEqual(client.discovered_stasis_app_name(), "dograh_env")

    def test_discovered_stasis_app_reads_live_config(self):
        # Regression for the 8008 failure: with no env var the dashboard must
        # discover the registered app from dograh, not emit Stasis(dograh).
        client = agents.DograhClient(endpoint="http://example.invalid", token="t")
        client._config_id = 7
        calls: list[tuple[str, str]] = []

        def fake_request(method: str, path: str, body=None):
            calls.append((method, path))
            return {"credentials": {"stasis_app_name": "dograh_72e590ef66eb"}}

        with mock.patch.dict(os.environ, {}, clear=True):
            client._request = fake_request  # type: ignore[method-assign]
            self.assertEqual(client.discovered_stasis_app_name(), "dograh_72e590ef66eb")
            # Cached — a second lookup makes no further call.
            self.assertEqual(client.discovered_stasis_app_name(), "dograh_72e590ef66eb")
        self.assertEqual(calls, [("GET", "/api/v1/organizations/telephony-configs/7")])

    def test_discovered_stasis_app_falls_back_when_unavailable(self):
        client = agents.DograhClient(endpoint="http://example.invalid", token="t")
        client._config_id = 7

        def boom(method: str, path: str, body=None):
            raise agents.DograhError("nope")

        with mock.patch.dict(os.environ, {}, clear=True):
            client._request = boom  # type: ignore[method-assign]
            self.assertEqual(client.discovered_stasis_app_name(), "dograh")

    def test_dialplan_body_empty_when_all_static(self):
        self.assertEqual(agents.dialplan_body(["8000", "8007"]), "")
        self.assertEqual(agents.dialplan_body([]), "")

    def test_dialplan_body_dedupes_and_sorts(self):
        body = agents.dialplan_body(["8010", "8009", "8009"])
        self.assertLess(body.index("8009"), body.index("8010"))
        # Duplicates collapse to one entry per context (the NoOp prefix
        # appears twice: once in [dograh-inbound], once in
        # [from-internal-custom]).
        self.assertEqual(body.count("exten => 8009,1,NoOp"), 2)
        self.assertEqual(body.count("exten => 8010,1,NoOp"), 2)


if __name__ == "__main__":
    unittest.main()