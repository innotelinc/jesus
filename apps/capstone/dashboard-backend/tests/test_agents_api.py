#!/usr/bin/env python3
"""Auto-repair on load — route tests for the Agents page (app/main.py).

The Agents list converges half-wired rows itself instead of only reporting
them: a row that reads Partial is one the idempotent FreePBX writers can
repair, and the page is where an operator meets that state. These tests drive
the real FastAPI app with a fake dograh at the urllib transport and an
in-memory FreePBX at the two `_pbx_*` seams, so the statements come from the
real builders (app/agents.py) and the status comes from the real
`_pbx_status_payload`.

What matters here is the batching and the bounding: the writers must run for
the rows that need them and not for the rows that don't, the whole batch must
be published by ONE reload (a reload is PBX-wide, and one per agent is what
the per-row Re-sync costs), a PBX that refuses a write must leave the page
renderable with the honest status, and a genuinely unrepairable row must not
turn every page load into a write attempt.

Needs the dashboard-api dependencies (fastapi + httpx). It is skipped in a
bare interpreter and runs where `pip install -r dashboard-backend/requirements.txt`
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
KVSTORE = "kvstore_Customappsreg"


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
    """Stand-in for the dograh REST API (urllib request callback)."""

    def __init__(self, numbers):
        self.numbers = numbers
        self.stasis_app = "dograh_deadbeef"

    def __call__(self, req, timeout=None):  # noqa: ARG002 - urlopen signature
        path = req.full_url.split(ENDPOINT, 1)[1]
        if path == "/api/v1/organizations/telephony-configs":
            return FakeResponse({"configurations": [{"id": 7, "name": "Asterisk ARI (dograh)"}]})
        if path == "/api/v1/organizations/telephony-configs/7":
            return FakeResponse({
                "id": 7, "name": "Asterisk ARI (dograh)",
                "credentials": {"stasis_app_name": self.stasis_app},
            })
        if path.endswith("/phone-numbers"):
            return FakeResponse({"phone_numbers": self.numbers})
        if path == "/api/v1/workflow/fetch":
            return FakeResponse([{"id": 1, "name": "IT Help Desk Mock Interview",
                                  "status": "active"}])
        raise AssertionError(f"unexpected dograh request: {req.get_method()} {path}")


class FakePbx:
    """In-memory FreePBX: the two tables the Agents page probes, plus dialplan.

    Dispatches on the SQL our own builders emit, so the test exercises the real
    statement builders rather than a re-implementation of them.
    """

    def __init__(self, exts=(), routes=(), dialplan=(), descriptions=None):
        self.exts = set(exts)
        self.routes = set(routes)
        self.dialplan = set(dialplan)
        # The stored FreePBX description per extension — what a workflow rename
        # has to reach.
        self.descriptions = dict(descriptions or {})
        self.stasis_app = "dograh_deadbeef"
        self.execs: list[list[str]] = []
        self.sql: list[str] = []
        self.confs: dict[str, str] = {}
        self.fail_on = ""  # substring that makes a write raise

    # ── the docker exec seam ────────────────────────────────────────────────
    def exec_(self, cmd):
        self.execs.append(list(cmd))
        if cmd[0] == "asterisk":
            if cmd[2].startswith("dialplan show"):
                body = "\n".join(
                    f"  '{e}' =>          1. NoOp(Dograh voice agent inbound)"
                    f"     [extensions_custom.conf:1]" for e in sorted(self.dialplan)
                )
                return 0, ("[ Context 'dograh-inbound' created by 'pbx_config' ]\n"
                           + body if body else "There is no existence of 'dograh-inbound'")
            if cmd[2] == "ari show apps":
                return 0, f"=====\n{self.stasis_app}"
            return 0, ""
        if cmd[0] == "cat":
            return 0, self.confs.get(cmd[1], "")
        if cmd[0] == "sh" and "base64 -d >" in cmd[2]:
            # `_pbx_write_conf`: echo <b64> | base64 -d > '<path>'
            path = re.search(r"> '([^']+)'", cmd[2]).group(1)
            content = base64.b64decode(cmd[2].split()[1]).decode()
            self.confs[path] = content
            if path.endswith("extensions_custom_dograh.conf"):
                # The reload that follows puts these exten lines in the live
                # dialplan — the generated include is the only routing a number
                # outside the static 8000-8007 set has.
                self.dialplan.update(re.findall(r"^exten => (\S+),", content, re.M))
            return 0, ""
        return 0, ""

    # ── the SQL seam ───────────────────────────────────────────────────────
    def mysql(self, sql):
        self.sql.append(sql)
        if self.fail_on and self.fail_on in sql:
            raise main.HTTPException(status_code=502, detail="PBX SQL failed: simulated")
        if "information_schema.tables" in sql:
            return KVSTORE + "\n"
        # The page-wide probe: one `SELECT '<ext>', (SELECT COUNT(…)` per agent,
        # joined by UNION ALL only when there is more than one agent.
        if re.search(r"SELECT '[^']*', \(SELECT COUNT", sql):
            return "".join(
                f"{ext}\t{1 if ext in self.exts else 0}\t{1 if ext in self.routes else 0}\n"
                for ext in dict.fromkeys(re.findall(r"SELECT '([^']*)',", sql))
            )
        if "SELECT `custom_exten`, `description`" in sql:
            return "".join(f"{e}\t{d}\n" for e, d in sorted(self.descriptions.items()))
        if "INSERT INTO `custom_extensions`" in sql:
            m = re.search(r"VALUES \('([^']*)', '([^']*)'", sql)
            self.exts.add(m.group(1))
            self.descriptions[m.group(1)] = m.group(2)
            return ""
        if "INSERT INTO `incoming`" in sql:
            self.routes.add(re.search(r"VALUES \('([^']*)'", sql).group(1))
            return ""
        if "MAX(CAST(`key` AS UNSIGNED))" in sql:
            return "1\n"
        return ""

    # ── assertions ──────────────────────────────────────────────────────────
    def reloads(self):
        return [c for c in self.execs if c[:2] == ["fwconsole", "reload"]]

    def writes(self):
        return [s for s in self.sql
                if s.startswith(("INSERT", "UPDATE", "DELETE"))]


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed — skipping route tests")
class AgentsAutoRepairTest(unittest.TestCase):
    NUMBERS = [{"id": 10, "address": "8003", "label": "Reception",
                "inbound_workflow_id": 1, "is_active": True}]

    def setUp(self):
        os.environ["DOGRAH_API_TOKEN"] = "TEST-TOKEN"
        os.environ["DOGRAH_API_ENDPOINT"] = ENDPOINT
        os.environ["DOGRAH_CONFIG_NAME"] = "Asterisk ARI (dograh)"
        os.environ.pop("CAPSTONE_DEPLOY_MODE", None)
        self.dograh = FakeDograh([dict(n) for n in self.NUMBERS])
        self.urlopen = mock.patch("urllib.request.urlopen", side_effect=self.dograh)
        self.urlopen.start()
        self.deps = mock.patch.dict(
            main.app.dependency_overrides,
            {main.require_session: lambda: {"email": "ops@test", "role": "admin"}},
        )
        self.deps.start()
        # Module state survives between tests: the dialplan cache and the
        # shared repair cooldown both have to start cold.
        main._dialplan_cache.clear()
        main._repair_claims.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.deps.stop()
        self.urlopen.stop()
        for key in ("DOGRAH_API_TOKEN", "DOGRAH_API_ENDPOINT", "DOGRAH_CONFIG_NAME",
                    "CAPSTONE_DEPLOY_MODE"):
            os.environ.pop(key, None)

    def pbx(self, **kwargs):
        fake = FakePbx(**kwargs)
        self.execs = mock.patch.object(main, "_pbx_exec", side_effect=fake.exec_)
        self.mysql = mock.patch.object(main, "_pbx_mysql", side_effect=fake.mysql)
        self.execs.start()
        self.mysql.start()
        self.addCleanup(self.mysql.stop)
        self.addCleanup(self.execs.stop)
        return fake

    def agent(self, res):
        self.assertEqual(res.status_code, 200)
        return res.json()["agents"][0]

    def test_partial_row_is_repaired_on_load(self):
        # The extension row exists but the inbound route never landed — the
        # state a failed provisioning run leaves behind.
        pbx = self.pbx(exts={"8003"}, dialplan={"8003"})
        agent = self.agent(self.client.get("/agents"))
        self.assertEqual(agent["pbx"]["status"], "provisioned")
        self.assertTrue(agent["pbx"]["customExtension"])
        self.assertTrue(agent["pbx"]["inboundRoute"])
        self.assertIn("8003", pbx.routes, "the missing inbound route was not written")
        self.assertNotIn("detail", agent["pbx"])

    def test_the_whole_batch_is_published_by_one_reload(self):
        pbx = self.pbx(dialplan={"8003"})
        self.agent(self.client.get("/agents"))
        self.assertEqual(len(pbx.reloads()), 1)

    def test_a_provisioned_row_is_not_touched(self):
        pbx = self.pbx(exts={"8003"}, routes={"8003"}, dialplan={"8003"})
        agent = self.agent(self.client.get("/agents"))
        self.assertEqual(agent["pbx"]["status"], "provisioned")
        self.assertEqual(pbx.writes(), [], "a wired row must not be re-written")
        self.assertEqual(pbx.reloads(), [], "a wired row must not trigger a reload")

    def test_a_number_outside_the_static_set_is_wired_and_added_to_the_dialplan(self):
        # 8008 is outside the shipped 8000-8007 set, so it is routed by the
        # generated include — which must be written for it to have a call path.
        self.dograh.numbers = [{"id": 11, "address": "8008", "label": "Sales",
                                "inbound_workflow_id": 1, "is_active": True}]
        pbx = self.pbx()
        agent = self.agent(self.client.get("/agents"))
        self.assertEqual(agent["pbx"]["status"], "provisioned")
        self.assertIn("8008", pbx.exts)
        self.assertIn("8008", pbx.routes)
        body = pbx.confs.get("/etc/asterisk/extensions_custom_dograh.conf", "")
        self.assertIn("exten => 8008", body)
        self.assertEqual(len(pbx.reloads()), 1)

    def test_a_refused_write_leaves_the_page_renderable(self):
        pbx = self.pbx(dialplan={"8003"})
        pbx.fail_on = "INSERT INTO `custom_extensions`"
        agent = self.agent(self.client.get("/agents"))
        # Still the honest status, naming what is missing — not a 502.
        self.assertEqual(agent["pbx"]["status"], "partial")
        self.assertIn("extension", agent["pbx"]["detail"])
        self.assertIn("inbound route", agent["pbx"]["detail"])
        self.assertEqual(pbx.reloads(), [], "nothing was written, so nothing to publish")

    def test_a_repair_attempt_is_bounded_by_the_cooldown(self):
        # An unrepairable row (every write refused) must not make every page load
        # a write attempt — the page polls, and operators leave it open.
        pbx = self.pbx(dialplan={"8003"})
        pbx.fail_on = "INSERT INTO `custom_extensions`"
        for _ in range(3):
            self.agent(self.client.get("/agents"))
        probes = [s for s in pbx.sql if "information_schema.tables" in s]
        self.assertEqual(len(probes), 1, "the cooldown did not bound the attempts")

    def test_addon_mode_reports_pending_sync_and_never_touches_the_pbx(self):
        os.environ["CAPSTONE_DEPLOY_MODE"] = "addon"
        pbx = self.pbx()
        agent = self.agent(self.client.get("/agents"))
        self.assertEqual(agent["pbx"]["status"], "pending-sync")
        self.assertEqual(pbx.sql, [], "add-on mode must not write to the shared PBX")
        self.assertEqual(pbx.execs, [], "add-on mode must not exec into the shared PBX")

    # ── the Workflows page's own PBX row ───────────────────────────────────

    def test_a_renamed_workflow_refreshes_the_pbx_description(self):
        """The FreePBX row carries the workflow name, so a rename leaves it
        naming the old one until the row is re-applied. The Workflows page is
        where a rename is made, so it is where the row converges."""
        self.dograh.numbers[0]["inbound_workflow_name"] = "IT Help Desk (new)"
        stale = main.agents.agent_description("Reception", "IT Help Desk (old)")
        pbx = self.pbx(exts={"8003"}, routes={"8003"}, dialplan={"8003"},
                       descriptions={"8003": stale})

        res = self.client.get("/workflows")

        self.assertEqual(res.status_code, 200)
        self.assertIn("IT Help Desk (new)", pbx.descriptions["8003"])
        self.assertEqual(len(pbx.reloads()), 1)

    def test_a_current_description_is_left_alone(self):
        current = main.agents.agent_description("Reception", "Reception")
        pbx = self.pbx(exts={"8003"}, routes={"8003"}, dialplan={"8003"},
                       descriptions={"8003": current})

        res = self.client.get("/workflows")

        self.assertEqual(res.status_code, 200)
        self.assertEqual(pbx.reloads(), [], "a current row must not be re-written")


if __name__ == "__main__":
    unittest.main()
