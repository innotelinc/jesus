#!/usr/bin/env python3
"""Unit tests for dashboard-backend/app/interviews.py — the Grist client +
report mappers behind the Control Center Interview Reports page.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v

Everything is mocked at urllib.request.urlopen — no network, no Grist, no
.env required. The JSON mappers are pure functions, so they are asserted
against the exact shapes the n8n Interview Grader writes (see
n8n-grader-workflow.json / scripts/grist_bootstrap.py).
"""

import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import interviews  # noqa: E402

BASE = "http://grist.test:8484"
DOC = "vhuKUoYjXAmLHKc5h828Qq"


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


def make_client(doc=DOC, key="grist_test"):
    return interviews.GristClient(BASE, doc, key)


def http_error(status, body):
    import io
    fp = io.BytesIO(body)
    return urllib.error.HTTPError("url", status, "err", hdrs=None, fp=fp)  # type: ignore[arg-type]


class ConfigTest(unittest.TestCase):
    def tearDown(self):
        for var in ("GRIST_URL", "GRIST_DOC_ID", "GRIST_API_KEY"):
            os.environ.pop(var, None)

    def test_defaults(self):
        self.assertEqual(interviews.grist_url(), "http://grist:8484")
        self.assertFalse(interviews.configured())

    def test_env_overrides(self):
        os.environ["GRIST_URL"] = "http://grist:9999/"
        os.environ["GRIST_DOC_ID"] = " abc123 "
        self.assertEqual(interviews.grist_url(), "http://grist:9999")
        self.assertTrue(interviews.configured())

    def test_client_configured_requires_doc(self):
        self.assertFalse(make_client(doc="").configured())
        self.assertTrue(make_client(doc=DOC).configured())


class GristClientRequestTest(unittest.TestCase):
    def test_list_records_sends_bearer_and_parses(self):
        client = make_client()
        payload = {"records": [{"id": 1, "fields": {"Student": "Ada"}}]}
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, json.dumps(payload).encode())) as m:
            rows = client.list_records()
        req = m.call_args[0][0]
        self.assertEqual(req.get_method(), "GET")
        self.assertEqual(req.full_url, f"{BASE}/api/docs/{DOC}/tables/Interviews/records")
        self.assertEqual(req.headers.get("Authorization"), "Bearer grist_test")
        self.assertEqual(rows[0]["fields"]["Student"], "Ada")

    def test_list_records_no_key_omits_header(self):
        client = make_client(key="")
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, b'{"records":[]}')) as m:
            client.list_records()
        self.assertIsNone(m.call_args[0][0].headers.get("Authorization"))

    def test_http_error_becomes_grist_error(self):
        client = make_client()
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=http_error(404, b'{"error":"document not found"}'),
        ):
            with self.assertRaises(interviews.GristError) as ctx:
                client.list_records()
        self.assertIn("404", str(ctx.exception))
        self.assertIn("document not found", str(ctx.exception))

    def test_unreachable_becomes_grist_error(self):
        import urllib.request as _ur

        client = make_client()
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=_ur.URLError("connection refused"),
        ):
            with self.assertRaises(interviews.GristError) as ctx:
                client.list_records()
        self.assertIn("unreachable", str(ctx.exception))


# A row exactly as the n8n grader writes it (Dimensions/Strengths/
# Improvements are JSON *strings* in Text columns).
GRADED_ROW = {
    "id": 7,
    "fields": {
        "Track": "devops",
        "Student": "Ada Lovelace",
        "Phone": "8001",
        "RunID": "run-42",
        "Score": 82.5,
        "Verdict": "pass",
        "Dimensions": json.dumps({
            "incident_response_and_triage": {"score": 4, "evidence": "what changed?"},
            "troubleshooting_methodology": {"score": 4.5, "evidence": "none"},
        }),
        "Strengths": json.dumps(["calm under pressure", "asked about deploys"]),
        "Improvements": json.dumps(["document the timeline"]),
        "Transcript": "AI: Welcome...\nCaller: Hi...",
        "parse_error": "",
    },
}


class RowToReportTest(unittest.TestCase):
    def test_graded_row_maps_fully(self):
        report = interviews.row_to_report(GRADED_ROW)
        self.assertEqual(report["id"], 7)
        self.assertEqual(report["track"], "devops")
        self.assertEqual(report["trackLabel"], "DevOps")
        self.assertEqual(report["student"], "Ada Lovelace")
        self.assertEqual(report["phone"], "8001")
        self.assertEqual(report["runId"], "run-42")
        self.assertEqual(report["score"], 82.5)
        self.assertEqual(report["verdict"], "pass")
        self.assertEqual(len(report["dimensions"]), 2)
        self.assertEqual(report["dimensions"][0]["name"], "incident_response_and_triage")
        self.assertEqual(report["dimensions"][0]["score"], 4)
        self.assertEqual(report["dimensions"][0]["evidence"], "what changed?")
        self.assertEqual(report["strengths"], ["calm under pressure", "asked about deploys"])
        self.assertEqual(report["improvements"], ["document the timeline"])
        self.assertIn("Welcome", report["transcript"])
        self.assertEqual(report["parseError"], "")

    def test_unknown_verdict_normalised(self):
        row = {"id": 1, "fields": {"Verdict": "PASS "}}
        self.assertEqual(interviews.row_to_report(row)["verdict"], "pass")
        row = {"id": 2, "fields": {"Verdict": "weird"}}
        self.assertEqual(interviews.row_to_report(row)["verdict"], "unknown")

    def test_score_garbage_becomes_none(self):
        row = {"id": 3, "fields": {"Score": "high"}}
        self.assertIsNone(interviews.row_to_report(row)["score"])

    def test_empty_row_is_safe(self):
        report = interviews.row_to_report({"id": 4, "fields": {}})
        self.assertEqual(report["trackLabel"], "—")
        self.assertEqual(report["verdict"], "unknown")
        self.assertEqual(report["dimensions"], [])

    def test_parse_error_survives(self):
        row = {"id": 5, "fields": {"parse_error": "LLM returned prose"}}
        self.assertEqual(interviews.row_to_report(row)["parseError"], "LLM returned prose")


class ParseHelpersTest(unittest.TestCase):
    def test_parse_dimensions_malformed(self):
        self.assertEqual(interviews.parse_dimensions("not json"), [])
        self.assertEqual(interviews.parse_dimensions('["a","b"]'), [])
        self.assertEqual(interviews.parse_dimensions(""), [])

    def test_parse_dimensions_flat_scores(self):
        out = interviews.parse_dimensions('{"greeting": 3}')
        self.assertEqual(out, [{"name": "greeting", "score": 3, "evidence": ""}])

    def test_parse_str_list_malformed_and_non_list(self):
        self.assertEqual(interviews.parse_str_list("{oops"), [])
        self.assertEqual(interviews.parse_str_list('{"a":1}'), [])
        self.assertEqual(interviews.parse_str_list('["a", "b", ""]'), ["a", "b"])


class TrackLabelTest(unittest.TestCase):
    def test_known_tracks(self):
        self.assertEqual(interviews.track_label("it"), "IT Help Desk (Tier 1)")
        self.assertEqual(interviews.track_label("DevOps"), "DevOps")
        self.assertEqual(interviews.track_label("sql"), "SQL (junior data analyst)")

    def test_unknown_and_empty(self):
        self.assertEqual(interviews.track_label("golang"), "golang")
        self.assertEqual(interviews.track_label(""), "—")


class SortFilterStatsTest(unittest.TestCase):
    def make(self, rid, verdict="pass", score=80, track="it", student="S", phone="8000"):
        return {
            "id": rid, "verdict": verdict, "score": score, "track": track,
            "student": student, "phone": phone, "runId": f"run-{rid}",
        }

    def test_sort_newest_first(self):
        out = interviews.sort_reports([self.make(1), self.make(9), self.make(4)])
        self.assertEqual([r["id"] for r in out], [9, 4, 1])

    def test_filter_track_and_search(self):
        rows = [
            self.make(1, track="it", student="Ada"),
            self.make(2, track="devops", student="Grace"),
            self.make(3, track="sql", student="Alan", phone="8002"),
        ]
        self.assertEqual(len(interviews.filter_reports(rows, track="devops")), 1)
        self.assertEqual(len(interviews.filter_reports(rows, search="ada")), 1)
        self.assertEqual(len(interviews.filter_reports(rows, search="8002")), 1)
        self.assertEqual(len(interviews.filter_reports(rows, search="run-3")), 1)
        self.assertEqual(len(interviews.filter_reports(rows, search="nomatch")), 0)
        self.assertEqual(len(interviews.filter_reports(rows)), 3)

    def test_stats(self):
        rows = [
            self.make(1, verdict="pass", score=90),
            self.make(2, verdict="fail", score=50),
            self.make(3, verdict="review", score=65),
            self.make(4, verdict="unknown", score=None),
        ]
        stats = interviews.verdict_stats(rows)
        self.assertEqual(stats["total"], 4)
        self.assertEqual(stats["pass"], 1)
        self.assertEqual(stats["review"], 1)
        self.assertEqual(stats["fail"], 1)
        self.assertEqual(stats["unknown"], 1)
        self.assertEqual(stats["averageScore"], 68.3)


if __name__ == "__main__":
    unittest.main()
