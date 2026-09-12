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

try:  # pragma: no cover - depends on the environment
    from fastapi.testclient import TestClient

    from app import main

    _HAVE_DEPS = True
except Exception:  # noqa: BLE001 - any import failure means the deps are absent
    _HAVE_DEPS = False

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
        payload = {"records": [{"id": 1, "fields": {"Prospect": "Ada"}}]}
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, json.dumps(payload).encode())) as m:
            rows = client.list_records()
        req = m.call_args[0][0]
        self.assertEqual(req.get_method(), "GET")
        self.assertEqual(req.full_url, f"{BASE}/api/docs/{DOC}/tables/Interviews/records")
        self.assertEqual(req.headers.get("Authorization"), "Bearer grist_test")
        self.assertEqual(rows[0]["fields"]["Prospect"], "Ada")

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

    def test_non_dict_payload_becomes_grist_error(self):
        client = make_client()
        # A JSON array (not the docs envelope) must not raise AttributeError.
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, b'[]')):
            with self.assertRaises(interviews.GristError) as ctx:
                client.list_records()
        self.assertIn("unexpected payload", str(ctx.exception))

    def test_records_not_a_list_becomes_grist_error(self):
        client = make_client()
        body = json.dumps({"records": {"id": 1}}).encode()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, body)):
            with self.assertRaises(interviews.GristError) as ctx:
                client.list_records()
        self.assertIn("unexpected 'records'", str(ctx.exception))

    def test_missing_records_key_is_empty_list(self):
        client = make_client()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, b'{"tables":[]}')):
            self.assertEqual(client.list_records(), [])

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


class GristDeleteTest(unittest.TestCase):
    """The delete-family paths the Interview Reports page relies on.

    Soft delete is a PATCH of the `Deleted` flag (what Grist's own UI does for
    a cell edit); purge is the records/delete endpoint, which takes a bare
    JSON array of row ids and answers 200 with an empty body — both verified
    against the live container.
    """

    def test_soft_delete_patches_the_flag(self):
        client = make_client()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, b"")) as m:
            sent = client.set_deleted([7])
        req = m.call_args[0][0]
        self.assertEqual(req.get_method(), "PATCH")
        self.assertEqual(req.full_url, f"{BASE}/api/docs/{DOC}/tables/Interviews/records")
        self.assertEqual(req.headers.get("Authorization"), "Bearer grist_test")
        self.assertEqual(req.headers.get("Content-type"), "application/json")
        self.assertEqual(json.loads(req.data.decode()),
                         {"records": [{"id": 7, "fields": {"Deleted": True}}]})
        self.assertEqual(sent, [7])

    def test_restore_clears_the_flag(self):
        client = make_client()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, b"")) as m:
            sent = client.set_deleted([4, 9], deleted=False)
        self.assertEqual(json.loads(m.call_args[0][0].data.decode()),
                         {"records": [{"id": 4, "fields": {"Deleted": False}},
                                      {"id": 9, "fields": {"Deleted": False}}]})
        self.assertEqual(sent, [4, 9])

    def test_soft_delete_dedupes_and_normalises(self):
        client = make_client()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, b"")) as m:
            sent = client.set_deleted([3, "4", 3, 0, -1, None, True, 2.5, "x"])
        payload = json.loads(m.call_args[0][0].data.decode())
        self.assertEqual([r["id"] for r in payload["records"]], [3, 4])
        self.assertEqual(sent, [3, 4])

    def test_empty_selection_makes_no_request(self):
        client = make_client()
        with mock.patch("urllib.request.urlopen") as m:
            self.assertEqual(client.set_deleted([]), [])
            self.assertEqual(client.set_deleted(None), [])
            self.assertEqual(client.set_deleted("7"), [])
            self.assertEqual(client.purge_records([]), [])
        m.assert_not_called()

    def test_null_body_response_is_ok(self):
        # Grist answers the purge with a literal `null` JSON body.
        client = make_client()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, b"null")):
            self.assertEqual(client.purge_records([9]), [9])

    def test_http_error_becomes_grist_error(self):
        client = make_client()
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=http_error(404, b'{"error":"No such table"}'),
        ):
            with self.assertRaises(interviews.GristError) as ctx:
                client.purge_records([1])
        self.assertIn("404", str(ctx.exception))
        self.assertIn("No such table", str(ctx.exception))

    def test_purge_posts_id_array_and_honours_table_override(self):
        client = make_client()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(200, b"")) as m:
            sent = client.purge_records([1, 2], "OtherTable")
        req = m.call_args[0][0]
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.full_url, f"{BASE}/api/docs/{DOC}/tables/OtherTable/records/delete")
        self.assertEqual(json.loads(req.data.decode()), [1, 2])
        self.assertEqual(sent, [1, 2])


class NormalizeRecordIdsTest(unittest.TestCase):
    def test_accepts_ints_and_numeric_strings(self):
        self.assertEqual(interviews.normalize_record_ids([1, "2"]), [1, 2])
        self.assertEqual(interviews.normalize_record_ids([" 3 "]), [3])

    def test_drops_junk_and_non_positives(self):
        self.assertEqual(
            interviews.normalize_record_ids([None, {}, [], True, False, 0, -5, 2.5, "", "x", "7x"]),
            [],
        )

    def test_dedupes_preserving_order(self):
        self.assertEqual(interviews.normalize_record_ids([5, 2, 5, "2", 9]), [5, 2, 9])

    def test_non_list_input(self):
        self.assertEqual(interviews.normalize_record_ids(None), [])
        self.assertEqual(interviews.normalize_record_ids("12"), [])
        self.assertEqual(interviews.normalize_record_ids(42), [])


# A row exactly as the n8n grader writes it (Dimensions/Strengths/
# Improvements are JSON *strings* in Text columns). New rows carry the
# prospect's name in the Prospect column; older rows only have Student.
GRADED_ROW = {
    "id": 7,
    "fields": {
        "Track": "devops",
        "Prospect": "Ada Lovelace",
        "Student": "",
        "Phone": "+15551234567",
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
        self.assertEqual(report["prospect"], "Ada Lovelace")
        self.assertEqual(report["phone"], "+15551234567")
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

    def test_legacy_student_column_still_reads(self):
        row = {"id": 8, "fields": dict(GRADED_ROW["fields"], Prospect="", Student="Grace Hopper")}
        self.assertEqual(interviews.row_to_report(row)["prospect"], "Grace Hopper")

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

    def test_soft_delete_flag_maps(self):
        # Rows written before the Deleted column existed have no value.
        self.assertFalse(interviews.row_to_report(GRADED_ROW)["deleted"])
        self.assertTrue(interviews.row_to_report(
            {"id": 9, "fields": {"Deleted": True}})["deleted"])
        self.assertFalse(interviews.row_to_report(
            {"id": 9, "fields": {"Deleted": False}})["deleted"])


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


class RowsToReportsTest(unittest.TestCase):
    def test_maps_and_sorts_newest_first(self):
        rows = [
            {"id": 2, "fields": {"Student": "Grace", "Verdict": "fail"}},
            GRADED_ROW,
        ]
        reports = interviews.rows_to_reports(rows)
        self.assertEqual([r["id"] for r in reports], [7, 2])
        self.assertEqual(reports[0]["prospect"], "Ada Lovelace")
        self.assertEqual(reports[1]["verdict"], "fail")

    def test_skips_non_record_rows(self):
        rows = [None, "oops", 5, [{}], {"id": 3, "fields": {}}]
        reports = interviews.rows_to_reports(rows)
        self.assertEqual([r["id"] for r in reports], [3])

    def test_empty_input(self):
        self.assertEqual(interviews.rows_to_reports([]), [])

    def test_non_dict_fields_row_is_safe(self):
        reports = interviews.rows_to_reports([{"id": 4, "fields": "nope"}])
        self.assertEqual(reports[0]["trackLabel"], "—")
        self.assertEqual(reports[0]["dimensions"], [])


class SortFilterStatsTest(unittest.TestCase):
    def make(self, rid, verdict="pass", score=80, track="it", prospect="P", phone="8000"):
        return {
            "id": rid, "verdict": verdict, "score": score, "track": track,
            "prospect": prospect, "phone": phone, "runId": f"run-{rid}",
        }

    def test_sort_newest_first(self):
        out = interviews.sort_reports([self.make(1), self.make(9), self.make(4)])
        self.assertEqual([r["id"] for r in out], [9, 4, 1])

    def test_filter_track_and_search(self):
        rows = [
            self.make(1, track="it", prospect="Ada"),
            self.make(2, track="devops", prospect="Grace"),
            self.make(3, track="sql", prospect="Alan", phone="8002"),
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


class FakeGrist:
    """Records the requests dashboard-api makes and answers like Grist does.

    Grist returns every row on a GET (deleted ones included — the API does the
    filtering) and a literal `null` body for the purge endpoint.
    """

    def __init__(self, rows=None):
        self.calls: list[tuple[str, str, object]] = []
        self.rows = rows if rows is not None else []

    def __call__(self, req, timeout=None):
        body = json.loads(req.data.decode()) if req.data else None
        self.calls.append((req.get_method(), req.full_url, body))
        if req.get_method() == "GET":
            return FakeResponse(200, json.dumps({"records": self.rows}).encode())
        return FakeResponse(200, b"null")

    @property
    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    @property
    def flips(self):
        """id -> Deleted value for every PATCH the app sent."""
        out: dict[int, object] = {}
        for method, url, body in self.writes:
            if method != "PATCH":
                continue
            assert url.endswith("/tables/Interviews/records")
            for rec in body["records"]:
                out[rec["id"]] = rec["fields"]["Deleted"]
        return out

    @property
    def purged(self):
        return [c[2] for c in self.writes if c[0] == "POST"]


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed — skipping route tests")
class InterviewReportRoutesTest(unittest.TestCase):
    """Route tests for the delete/restore/purge endpoints behind the page."""

    def setUp(self):
        os.environ["GRIST_URL"] = BASE
        os.environ["GRIST_DOC_ID"] = DOC
        os.environ["GRIST_API_KEY"] = "grist_test"
        self.grist = FakeGrist([
            {"id": 1, "fields": {"Prospect": "Ada", "Verdict": "pass"}},
            {"id": 2, "fields": {"Prospect": "Grace", "Verdict": "fail", "Deleted": True}},
        ])
        self.urlopen = mock.patch("urllib.request.urlopen", side_effect=self.grist)
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
        for var in ("GRIST_URL", "GRIST_DOC_ID", "GRIST_API_KEY"):
            os.environ.pop(var, None)

    def test_reports_hide_deleted_rows_by_default(self):
        res = self.client.get("/interviews/reports")
        self.assertEqual(res.status_code, 200)
        self.assertEqual([r["id"] for r in res.json()["reports"]], [1])
        self.assertFalse(res.json()["reports"][0]["deleted"])

    def test_reports_can_include_deleted_rows(self):
        res = self.client.get("/interviews/reports?includeDeleted=1")
        reports = res.json()["reports"]
        self.assertEqual([r["id"] for r in reports], [2, 1])
        self.assertTrue(reports[0]["deleted"])
        self.assertFalse(reports[1]["deleted"])

    def test_delete_one_report_patches_the_flag(self):
        res = self.client.delete("/interviews/reports/7")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"status": "deleted", "id": 7})
        self.assertEqual(self.grist.flips, {7: True})
        self.assertEqual(self.grist.purged, [])

    def test_delete_one_rejects_non_positive_id(self):
        res = self.client.delete("/interviews/reports/0")
        self.assertEqual(res.status_code, 422)
        self.assertEqual(self.grist.writes, [])

    def test_delete_batch_is_soft(self):
        res = self.client.post("/interviews/reports/delete", json={"ids": [3, 2, 3, "4", None]})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"status": "deleted", "ids": [3, 2, 4], "count": 3})
        self.assertEqual(self.grist.flips, {3: True, 2: True, 4: True})

    def test_restore_clears_the_flag(self):
        res = self.client.post("/interviews/reports/restore", json={"ids": [2]})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"status": "restored", "ids": [2], "count": 1})
        self.assertEqual(self.grist.flips, {2: False})

    def test_purge_hard_deletes(self):
        res = self.client.post("/interviews/reports/purge", json={"ids": [2, 2, "5"]})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"status": "purged", "ids": [2, 5], "count": 2})
        self.assertEqual(self.grist.purged, [[2, 5]])
        self.assertEqual(self.grist.flips, {})

    def test_write_without_ids_is_a_noop(self):
        for path in ("delete", "restore", "purge"):
            for body in ({}, {"ids": []}, {"ids": None}, {"ids": "12"}):
                res = self.client.post(f"/interviews/reports/{path}", json=body)
                self.assertEqual(res.status_code, 200)
                self.assertEqual(res.json()["count"], 0)
        self.assertEqual(self.grist.writes, [])

    def test_write_503_when_unconfigured(self):
        os.environ.pop("GRIST_DOC_ID", None)
        res = self.client.delete("/interviews/reports/7")
        self.assertEqual(res.status_code, 503)
        self.assertIn("GRIST_DOC_ID", res.json()["detail"])

    def test_write_502_on_grist_error(self):
        self.urlopen.stop()

        def deny(*_args, **_kwargs):
            # A fresh HTTPError per call: its body is read-once, so reusing one
            # instance would lose the detail on every call after the first.
            raise http_error(403, b'{"error":"Access denied"}')

        self.urlopen = mock.patch("urllib.request.urlopen", side_effect=deny)
        self.urlopen.start()
        for call in (lambda: self.client.delete("/interviews/reports/7"),
                     lambda: self.client.post("/interviews/reports/restore", json={"ids": [2]}),
                     lambda: self.client.post("/interviews/reports/purge", json={"ids": [2]})):
            res = call()
            self.assertEqual(res.status_code, 502)
            self.assertIn("Access denied", res.json()["detail"])

    def test_delete_routes_share_the_reports_session_gate(self):
        # Same dependency the reports read uses: with OIDC enabled and no
        # session cookie the request must be rejected before Grist is touched.
        oidc = {
            "AUTHENTIK_ISSUER_URL": "https://auth.test/application/o/capstone/",
            "AUTHENTIK_CLIENT_ID": "test-client",
            "AUTHENTIK_CLIENT_SECRET": "test-secret",
        }
        for call in (lambda c: c.delete("/interviews/reports/7"),
                     lambda c: c.post("/interviews/reports/delete", json={"ids": [7]}),
                     lambda c: c.post("/interviews/reports/restore", json={"ids": [7]}),
                     lambda c: c.post("/interviews/reports/purge", json={"ids": [7]})):
            with mock.patch.dict(os.environ, oidc), \
                 mock.patch.dict(main.app.dependency_overrides, {}, clear=True):
                res = call(TestClient(main.app))
            self.assertEqual(res.status_code, 401)
        self.assertEqual(self.grist.writes, [])


if __name__ == "__main__":
    unittest.main()
