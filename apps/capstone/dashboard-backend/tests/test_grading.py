#!/usr/bin/env python3
"""Tests for the grading selection + auto-generated plan (app/grading.py).

Two layers:

* pure-function tests for the payload/plan plumbing (no deps needed);
* route tests that drive the real FastAPI app with a fake dograh at the urllib
  transport, covering list / enable (+ plan generation) / regenerate / disable.

Needs the dashboard-api dependencies (fastapi + httpx) for the route half; it is
skipped in a bare interpreter and runs wherever
`pip install -r dashboard-backend/requirements.txt` has been done, e.g.:

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

from app import grading  # noqa: E402 - path shim above

try:  # pragma: no cover - depends on the environment
    from fastapi.testclient import TestClient

    from app import main

    _HAVE_DEPS = True
except Exception:  # noqa: BLE001 - any import failure means the deps are absent
    _HAVE_DEPS = False

ENDPOINT = "http://dograh.test"
GRADER_URL = "http://127.0.0.1:5678/webhook/interview-graded"


def webhook_node(*, enabled=True, graded=None, plan=None, url=GRADER_URL, name="Notify n8n Grader"):
    template = {
        "run_id": "{{workflow_run_id}}",
        "transcript_url": "{{transcript_url}}",
    }
    if graded is not None:
        template["graded"] = graded
    if plan is not None:
        template["grading_plan"] = plan
    return {
        "id": "node-webhook",
        "type": "webhook",
        "data": {
            "name": name,
            "enabled": enabled,
            "http_method": "POST",
            "endpoint_url": url,
            "payload_template": template,
        },
    }


def interview_definition(**node_kwargs):
    return {
        "nodes": [
            {"id": "node-global", "type": "globalNode",
             "data": {"name": "Persona", "prompt": "You are an interviewer."}},
            {"id": "node-start", "type": "startCall",
             "data": {"name": "Open", "greeting": "Hi!", "prompt": "Open the call."}},
            {"id": "node-scenario", "type": "agentNode",
             "data": {"name": "Scenario 1", "prompt": "Ask about SQL joins."}},
            webhook_node(**node_kwargs),
        ],
        "edges": [],
    }


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed — skipping route tests")
class NormalizeCallDurationTest(unittest.TestCase):
    """main.normalize_call_duration: the PUT body -> dograh configurations."""

    def setUp(self):
        from app import main
        self.main = main

    def test_omitted_leaves_the_setting_untouched(self):
        self.assertIsNone(self.main.normalize_call_duration(None, {}))

    def test_zero_means_no_limit(self):
        self.assertEqual(self.main.normalize_call_duration(0, {}),
                         {"max_call_duration": 0})

    def test_unchanged_value_sends_nothing(self):
        self.assertIsNone(
            self.main.normalize_call_duration(600, {"maxCallDuration": 600}))

    def test_junk_types_are_rejected(self):
        for junk in (True, "ten", 1.5):
            with self.assertRaises(Exception):
                self.main.normalize_call_duration(junk, {})

    def test_negative_is_rejected(self):
        with self.assertRaises(Exception) as ctx:
            self.main.normalize_call_duration(-5, {})
        self.assertIn("negative", str(ctx.exception))

    def test_a_configured_ceiling_is_enforced(self):
        env = {"MAX_CALL_DURATION_SECONDS": "1200"}
        with mock.patch.dict(os.environ, env):
            with self.assertRaises(Exception) as ctx:
                self.main.normalize_call_duration(5000, {})
            self.assertIn("1200", str(ctx.exception))
            # At the ceiling is fine.
            self.assertEqual(self.main.normalize_call_duration(1200, {}),
                             {"max_call_duration": 1200})

    def test_no_ceiling_env_means_anything_goes(self):
        env = {"MAX_CALL_DURATION_SECONDS": "0"}
        with mock.patch.dict(os.environ, env):
            self.assertEqual(self.main.normalize_call_duration(99999, {}),
                             {"max_call_duration": 99999})


class NormalizeWorkflowDurationTest(unittest.TestCase):
    """agents.normalize_workflow surfaces max_call_duration for the UI."""

    def test_numeric_config_is_surfaced(self):
        row = {"id": 1, "name": "W", "status": "active",
               "workflow_definition": {}, "workflow_configurations":
                   {"max_call_duration": 0}}
        self.assertEqual(grading.agents.normalize_workflow(row)["maxCallDuration"], 0)

    def test_missing_config_reads_as_none(self):
        row = {"id": 1, "name": "W", "status": "active", "workflow_definition": {}}
        self.assertIsNone(grading.agents.normalize_workflow(row)["maxCallDuration"])

    def test_non_numeric_config_reads_as_none(self):
        row = {"id": 1, "name": "W", "status": "active", "workflow_definition": {},
               "workflow_configurations": {"max_call_duration": "soon"}}
        self.assertIsNone(grading.agents.normalize_workflow(row)["maxCallDuration"])


SPEC = {
    "title": "SQL interview rubric",
    "dimensions": [
        {"key": "schema_questions", "label": "Schema questions",
         "description": "Asks about tables and cardinality before proposing a fix.", "weight": 40},
        {"key": "join_logic", "label": "Join logic",
         "description": "Explains one-to-many fan-out and the correct aggregation level.", "weight": 35},
        {"key": "clarity", "label": "Communication clarity",
         "description": "Explains the problem and the fix in plain language.", "weight": 25},
    ],
    "pass_score": 75,
    "review_score": 60,
    "summary": "Diagnose a faulty revenue query.",
}


class GradingStateTest(unittest.TestCase):
    def test_find_webhook_prefers_the_grader_endpoint(self):
        definition = {
            "nodes": [
                webhook_node(url="https://crm.example.com/calls", name="CRM"),
                webhook_node(name="Grader"),
            ]
        }
        node = grading.find_webhook_node(definition)
        self.assertEqual(node["data"]["name"], "Grader")

    def test_find_webhook_falls_back_to_the_only_webhook(self):
        definition = {"nodes": [webhook_node(url="https://crm.example.com/calls")]}
        self.assertEqual(grading.find_webhook_node(definition)["id"], "node-webhook")

    def test_no_webhook_is_still_selectable(self):
        definition = {"nodes": [{"id": "n", "type": "agentNode", "data": {}}]}
        self.assertIsNone(grading.find_webhook_node(definition))
        state = grading.grading_state(definition)
        # Enabling appends the grader's webhook, so the row stays selectable.
        self.assertTrue(state["available"])
        self.assertFalse(state["has_webhook"])
        self.assertEqual(state["mode"], "none")
        self.assertFalse(state["enabled"])

    def test_selected_without_a_plan_uses_the_builtin_rubric(self):
        state = grading.grading_state(interview_definition())
        self.assertTrue(state["available"])
        self.assertTrue(state["has_webhook"])
        self.assertTrue(state["enabled"])
        self.assertEqual(state["mode"], "builtin")
        self.assertEqual(state["plan"], "")

    def test_a_plan_means_a_custom_rubric(self):
        state = grading.grading_state(interview_definition(plan="GRADE THIS"))
        self.assertEqual(state["mode"], "custom")
        self.assertEqual(state["plan"], "GRADE THIS")

    def test_graded_false_is_explicitly_excluded(self):
        state = grading.grading_state(
            interview_definition(graded=False, plan="STALE")
        )
        self.assertFalse(state["enabled"])
        self.assertEqual(state["mode"], "off")
        # A plan that survived a disable must not be treated as active.
        self.assertEqual(state["plan"], "STALE")

    def test_a_switched_off_webhook_is_surfaced(self):
        state = grading.grading_state(interview_definition(enabled=False))
        self.assertTrue(state["enabled"])
        self.assertFalse(state["webhook_enabled"])


class ApplyGradingTest(unittest.TestCase):
    def test_enable_stores_the_plan_alongside_the_existing_payload(self):
        definition = interview_definition()
        updated = grading.apply_grading(
            definition, enabled=True, plan="PLAN", meta={"title": "T", "dimensions": []}
        )
        template = grading.find_webhook_node(updated)["data"]["payload_template"]
        self.assertIs(template["graded"], True)
        self.assertEqual(template["grading_plan"], "PLAN")
        self.assertEqual(template["grading_meta"]["title"], "T")
        # Pre-existing keys are untouched.
        self.assertEqual(template["run_id"], "{{workflow_run_id}}")
        # And the original definition is left alone (no in-place edit).
        original = grading.find_webhook_node(definition)["data"]["payload_template"]
        self.assertNotIn("grading_plan", original)

    def test_disable_marks_the_workflow_and_drops_the_plan(self):
        definition = interview_definition(graded=True, plan="PLAN")
        updated = grading.apply_grading(definition, enabled=False)
        template = grading.find_webhook_node(updated)["data"]["payload_template"]
        self.assertIs(template["graded"], False)
        self.assertNotIn("grading_plan", template)
        self.assertNotIn("grading_meta", template)
        self.assertEqual(grading.grading_state(updated)["mode"], "off")

    def test_enable_without_a_plan_stays_on_the_builtin_rubric(self):
        updated = grading.apply_grading(interview_definition(graded=False), enabled=True)
        self.assertEqual(grading.grading_state(updated)["mode"], "builtin")

    def test_enabling_switches_a_disabled_webhook_back_on(self):
        updated = grading.apply_grading(
            interview_definition(enabled=False), enabled=True, plan="PLAN"
        )
        self.assertTrue(grading.find_webhook_node(updated)["data"]["enabled"])

    def test_enabling_appends_the_grader_webhook(self):
        updated = grading.apply_grading(
            {"nodes": [{"id": "n", "type": "agentNode", "data": {"prompt": "hi"}}]},
            enabled=True,
            plan="PLAN",
        )
        node = grading.find_webhook_node(updated)
        self.assertIsNotNone(node)
        self.assertIn("interview-graded", node["data"]["endpoint_url"])
        self.assertEqual(node["data"]["payload_template"][grading.PLAN_KEY], "PLAN")
        template = node["data"]["payload_template"]
        # The node renders the keys the grader reads off the call.
        self.assertEqual(template["run_id"], "{{workflow_run_id}}")
        self.assertEqual(template["transcript_url"], "{{transcript_url}}")
        # The graph keeps its other nodes, and gets an edges list to validate.
        self.assertEqual([n["id"] for n in updated["nodes"]], ["n", "node-webhook-grader"])
        self.assertEqual(updated["edges"], [])
        self.assertEqual(grading.grading_state(updated)["mode"], "custom")

    def test_an_empty_definition_still_gets_a_valid_graph(self):
        updated = grading.apply_grading({}, enabled=True)
        self.assertEqual(len(updated["nodes"]), 1)
        self.assertEqual(updated["edges"], [])
        self.assertEqual(grading.grading_state(updated)["mode"], "builtin")

    def test_disabling_without_a_webhook_changes_nothing(self):
        definition = {"nodes": [{"id": "n", "type": "agentNode", "data": {}}]}
        self.assertEqual(grading.apply_grading(definition, enabled=False), definition)

    def test_meta_is_trimmed_to_the_report_page_fields(self):
        updated = grading.apply_grading(
            interview_definition(),
            enabled=True,
            plan="PLAN",
            meta={
                "title": "T",
                "dimensions": [
                    {"key": "a", "label": "A", "weight": 50, "description": "x" * 500},
                    "junk",
                ],
                "pass_score": 75,
                "review_score": 60,
                "model": "auto",
                "generated_at": "2026-01-01T00:00:00+00:00",
                "secret": "must not be copied",
            },
        )
        meta = grading.find_webhook_node(updated)["data"]["payload_template"][
            grading.META_KEY
        ]
        self.assertEqual(meta["dimensions"], [{"key": "a", "label": "A", "weight": 50}])
        self.assertEqual(meta["pass_score"], 75)
        self.assertNotIn("secret", meta)


class RubricSpecTest(unittest.TestCase):
    def test_weights_are_renormalised_to_one_hundred(self):
        spec = grading.parse_rubric_spec(json.dumps({
            "dimensions": [
                {"key": "a", "label": "A", "description": "One two three four", "weight": 3},
                {"key": "b", "label": "B", "description": "One two three four", "weight": 5},
            ]
        }))
        self.assertEqual([d["weight"] for d in spec["dimensions"]], [38, 62])
        self.assertEqual(sum(d["weight"] for d in spec["dimensions"]), 100)

    def test_weights_already_summing_to_one_hundred_are_untouched(self):
        spec = grading.parse_rubric_spec(json.dumps(SPEC))
        self.assertEqual([d["weight"] for d in spec["dimensions"]], [40, 35, 25])

    def test_a_three_way_split_still_totals_one_hundred(self):
        spec = grading.parse_rubric_spec(json.dumps({
            "dimensions": [
                {"key": k, "label": k.upper(), "description": "One two three four", "weight": 1}
                for k in ("a", "b", "c")
            ]
        }))
        self.assertEqual(sum(d["weight"] for d in spec["dimensions"]), 100)

    def test_keys_are_slugged_and_duplicates_dropped(self):
        spec = grading.parse_rubric_spec(json.dumps({
            "dimensions": [
                {"key": "Active Listening!", "label": "Active listening",
                 "description": "Lets the caller finish before replying.", "weight": 60},
                {"key": "active_listening", "label": "Duplicate",
                 "description": "Same dimension again in another spelling.", "weight": 40},
                {"key": "clarity", "label": "Clarity",
                 "description": "Plain language, confirmed understanding.", "weight": 40},
            ]
        }))
        self.assertEqual([d["key"] for d in spec["dimensions"]],
                         ["active_listening", "clarity"])

    def test_a_dimension_without_a_description_is_rejected(self):
        with self.assertRaises(grading.GradingError) as ctx:
            grading.parse_rubric_spec(json.dumps({
                "dimensions": [
                    {"key": "a", "label": "A", "description": "too short", "weight": 50},
                    {"key": "b", "label": "B", "description": "One two three four", "weight": 50},
                ]
            }))
        self.assertIn("description", str(ctx.exception))

    def test_one_dimension_is_not_a_rubric(self):
        with self.assertRaises(grading.GradingError) as ctx:
            grading.parse_rubric_spec(json.dumps({
                "dimensions": [
                    {"key": "a", "label": "A", "description": "One two three four", "weight": 50},
                ]
            }))
        self.assertIn("dimension", str(ctx.exception))

    def test_pass_at_or_below_review_is_repaired(self):
        spec = grading.parse_rubric_spec(json.dumps({**SPEC, "pass_score": 50, "review_score": 80}))
        self.assertGreater(spec["pass_score"], spec["review_score"])

    def test_scores_out_of_range_are_clamped(self):
        spec = grading.parse_rubric_spec(json.dumps({**SPEC, "pass_score": 250, "review_score": -5}))
        self.assertEqual(spec["pass_score"], 100)
        self.assertEqual(spec["review_score"], 0)

    def test_non_json_is_rejected(self):
        with self.assertRaises(grading.GradingError):
            grading.parse_rubric_spec("Sure! Here is your rubric:")


class ComposePlanTest(unittest.TestCase):
    def test_plan_carries_the_dimensions_weights_and_verdicts(self):
        plan = grading.compose_plan(grading.parse_rubric_spec(json.dumps(SPEC)), "SQL Mock Interview")
        self.assertIn("SQL Mock Interview", plan)
        for dimension in SPEC["dimensions"]:
            self.assertIn(dimension["key"], plan)
            self.assertIn(f"(weight {dimension['weight']})", plan)
        self.assertIn("pass >= 75", plan)
        self.assertIn("review 60-74", plan)
        # The parser in n8n reads exactly this shape.
        for key in ('"overall_score"', '"verdict"', '"dimensions"', '"strengths"',
                    '"improvements"', '"summary"'):
            self.assertIn(key, plan)

    def test_plan_tells_the_model_not_to_fabricate_evidence(self):
        plan = grading.compose_plan(grading.parse_rubric_spec(json.dumps(SPEC)), "X")
        self.assertIn("never fabricate quotes", plan)


class GeneratePlanTest(unittest.TestCase):
    def test_generate_plan_uses_the_workflow_prompts(self):
        captured = {}

        def fake_chat(system, user, gateway, api_key, model, **kwargs):
            captured.update(system=system, user=user, model=model)
            return json.dumps(SPEC)

        with mock.patch.object(grading, "_chat", side_effect=fake_chat):
            plan, meta = grading.generate_plan(
                "SQL Mock Interview",
                interview_definition(),
                gateway="http://gw",
                api_key="k",
                model="auto",
            )
        self.assertIn("WORKFLOW: SQL Mock Interview", captured["user"])
        self.assertIn("Ask about SQL joins.", captured["user"])
        self.assertIn("rubric", captured["system"].lower())
        self.assertIn("schema_questions", plan)
        self.assertEqual(meta["title"], "SQL interview rubric")
        self.assertEqual(len(meta["dimensions"]), 3)
        self.assertEqual(meta["pass_score"], 75)
        self.assertTrue(meta["generated_at"])

    def test_generate_plan_needs_prompts_to_work_from(self):
        with self.assertRaises(grading.GradingError):
            grading.generate_plan("Empty", {"nodes": []})


class FakeDograhGrading:
    """Minimal stateful dograh stand-in: list + fetch + update + publish."""

    def __init__(self, definition, **workflow_kwargs):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.workflows = {
            1: {
                "id": 1,
                "name": "SQL Mock Interview",
                "status": "active",
                "workflow_definition": definition,
                **workflow_kwargs,
            },
        }

    def _response(self, wid):
        w = self.workflows[wid]
        return {
            "id": wid,
            "name": w["name"],
            "status": w["status"],
            "workflow_definition": w["workflow_definition"],
        }

    def __call__(self, req, timeout=None):  # noqa: ARG002 - urlopen signature
        method = req.get_method()
        path = req.full_url.split(ENDPOINT, 1)[1]
        body = json.loads(req.data) if req.data else None
        self.calls.append((method, path, body))

        if method == "GET" and path == "/api/v1/workflow/fetch":
            return FakeResponse([
                {"id": w["id"], "name": w["name"], "status": w["status"]}
                for w in self.workflows.values()
            ])
        if method == "GET" and path.startswith("/api/v1/workflow/fetch/"):
            return FakeResponse(self._response(int(path.rsplit("/", 1)[1])))
        if method == "POST" and path.endswith("/publish"):
            return FakeResponse({"status": "published"})
        if method == "PUT" and path.startswith("/api/v1/workflow/"):
            wid = int(path.rsplit("/", 1)[1])
            if body.get("workflow_definition"):
                self.workflows[wid]["workflow_definition"] = body["workflow_definition"]
            return FakeResponse(self._response(wid))
        raise AssertionError(f"unexpected dograh request: {method} {path}")

    def paths(self, method):
        return [p for m, p, _ in self.calls if m == method]

    def template(self):
        return grading.find_webhook_node(
            self.workflows[1]["workflow_definition"]
        )["data"]["payload_template"]


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


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed — skipping route tests")
class GradingRoutesTest(unittest.TestCase):
    PLAN = "GENERATED PLAN"
    META = {"title": "SQL interview rubric", "dimensions": [], "pass_score": 75}

    def setUp(self):
        os.environ["DOGRAH_API_TOKEN"] = "TEST-TOKEN"
        os.environ["DOGRAH_API_ENDPOINT"] = ENDPOINT
        self.dograh = FakeDograhGrading(interview_definition())
        self.urlopen = mock.patch("urllib.request.urlopen", side_effect=self.dograh)
        self.urlopen.start()
        self.plan_patch = mock.patch.object(
            main.grading, "generate_plan", return_value=(self.PLAN, self.META)
        )
        self.generate = self.plan_patch.start()
        self.deps = mock.patch.dict(
            main.app.dependency_overrides,
            {main.require_session: lambda: {"email": "ops@test", "role": "admin"}},
        )
        self.deps.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.deps.stop()
        self.plan_patch.stop()
        self.urlopen.stop()
        for key in ("DOGRAH_API_TOKEN", "DOGRAH_API_ENDPOINT"):
            os.environ.pop(key, None)

    def test_list_reports_the_grading_state_per_workflow(self):
        res = self.client.get("/grading/workflows")
        self.assertEqual(res.status_code, 200)
        workflows = res.json()["workflows"]
        self.assertEqual(len(workflows), 1)
        self.assertEqual(workflows[0]["name"], "SQL Mock Interview")
        self.assertEqual(workflows[0]["grading"]["mode"], "builtin")

    def test_enable_generates_a_plan_and_publishes_it(self):
        res = self.client.post("/grading/workflows/1", json={"enabled": True})
        self.assertEqual(res.status_code, 200)
        state = res.json()["grading"]
        self.assertEqual(state["mode"], "custom")
        self.assertEqual(state["plan"], self.PLAN)
        self.generate.assert_called_once()
        # The plan has to reach dograh, not just the response.
        self.assertEqual(self.dograh.template()["grading_plan"], self.PLAN)
        self.assertIn("/api/v1/workflow/1", self.dograh.paths("PUT"))
        self.assertIn("/api/v1/workflow/1/publish", self.dograh.paths("POST"))

    def test_enable_keeps_an_existing_plan(self):
        self.dograh.workflows[1]["workflow_definition"] = interview_definition(plan="KEEP ME")
        res = self.client.post("/grading/workflows/1", json={"enabled": True})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["grading"]["plan"], "KEEP ME")
        self.generate.assert_not_called()

    def test_regenerate_replaces_the_plan(self):
        self.dograh.workflows[1]["workflow_definition"] = interview_definition(plan="OLD")
        res = self.client.post(
            "/grading/workflows/1", json={"enabled": True, "regenerate": True}
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["grading"]["plan"], self.PLAN)
        self.generate.assert_called_once()

    def test_disable_marks_the_workflow_ungraded(self):
        self.dograh.workflows[1]["workflow_definition"] = interview_definition(plan="PLAN")
        res = self.client.delete("/grading/workflows/1")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["grading"]["mode"], "off")
        self.assertIs(self.dograh.template()["graded"], False)
        self.assertNotIn("grading_plan", self.dograh.template())

    def test_enable_without_a_webhook_instruments_the_workflow(self):
        self.dograh.workflows[1]["workflow_definition"] = {
            "nodes": [{"id": "node-start", "type": "startCall",
                       "data": {"prompt": "open the call", "greeting": "hi"}}],
            "edges": [],
        }
        res = self.client.post("/grading/workflows/1", json={"enabled": True})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["addedWebhook"])
        self.assertTrue(body["grading"]["has_webhook"])
        self.assertEqual(body["grading"]["mode"], "custom")
        node = grading.find_webhook_node(self.dograh.workflows[1]["workflow_definition"])
        self.assertIn("interview-graded", node["data"]["endpoint_url"])

    def test_enable_on_an_already_instrumented_workflow_adds_nothing(self):
        res = self.client.post("/grading/workflows/1", json={"enabled": True})
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json()["addedWebhook"])

    def test_a_failing_planner_surfaces_as_a_bad_gateway(self):
        self.generate.side_effect = grading.GradingError("LLM gateway unreachable")
        res = self.client.post("/grading/workflows/1", json={"enabled": True})
        self.assertEqual(res.status_code, 502)
        self.assertIn("LLM gateway unreachable", res.json()["detail"])

    def test_a_workflow_that_fails_to_load_is_still_listed(self):
        client = mock.Mock()
        client.list_workflows.return_value = [{"id": 1, "name": "Broken", "status": "active"}]
        client.get_workflow.side_effect = grading.agents.DograhError("dograh 500")
        described = grading.describe_workflows(client)
        self.assertEqual(described[0]["name"], "Broken")
        self.assertFalse(described[0]["grading"]["available"])
        self.assertIn("dograh 500", described[0]["grading"]["error"])


if __name__ == "__main__":
    unittest.main()
