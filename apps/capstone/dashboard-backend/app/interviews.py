"""Interview reports — Grist document backing the n8n Interview Grader.

The Interview Grader workflow (n8n) POSTs a graded JSON report to Grist on
every mock-interview hang-up: one row of the ``Interviews`` table per call
(track, prospect, phone, score, verdict, per-dimension evidence, transcript).

The prospect's *name* is derived from the call (their transcript) rather than
supplied up front, and the phone column is the number they called from
(dograh's ``initial_context.caller_number``).

This module is the dashboard's client for those rows: it lists them for the
Interview Reports page and deletes a selected row (or a batch of them) when an
operator throws a bad/test grade away. Deleting is *soft* by default — it sets
the ``Deleted`` flag (owned by scripts/grist_bootstrap.py) so the row survives a
mis-click: the page offers an undo, a "show deleted" view, and a permanent
purge. Grist runs on the same ``interview-net`` bridge as dashboard-api, so we
talk to it directly by service name; auth is the same owner API key setup.sh
minted for the grader (GRIST_API_KEY + GRIST_DOC_ID in the mounted .env).

Mirrors ``app/agents.py`` conventions: urllib only (no pip deps) so it
unit-tests without the stack, and degrades to an "unconfigured" state instead
of raising when the env is missing.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

DEFAULT_URL = "http://grist:8484"
DEFAULT_DOC_ID = ""

# Soft-delete flag on the Interviews table (owned by scripts/grist_bootstrap.py).
DELETED_COLUMN = "Deleted"

# Columns the n8n grader writes (scripts/grist_bootstrap.py owns the schema).
TRACKS = {
    "it": "IT Help Desk (Tier 1)",
    "devops": "DevOps",
    "sql": "SQL (junior data analyst)",
}


def grist_url() -> str:
    return (os.environ.get("GRIST_URL") or DEFAULT_URL).rstrip("/")


def doc_id() -> str:
    return (os.environ.get("GRIST_DOC_ID") or DEFAULT_DOC_ID).strip()


def api_key() -> str:
    return (os.environ.get("GRIST_API_KEY") or "").strip()


def configured() -> bool:
    return bool(doc_id())


class GristError(RuntimeError):
    pass


class GristClient:
    """Thin Grist REST client (Bearer token auth) — list + delete records."""

    def __init__(
        self,
        base_url: str | None = None,
        doc: str | None = None,
        key: str | None = None,
    ) -> None:
        self.base_url = (base_url if base_url is not None else grist_url()).rstrip("/")
        self.doc = doc if doc is not None else doc_id()
        self.key = key if key is not None else api_key()

    def configured(self) -> bool:
        return bool(self.doc)

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        headers: dict[str, str] = {"Accept": "application/json"}
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self.base_url}{path}", headers=headers, data=data, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 - configured endpoint
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read()).get("error", "")
            except Exception:
                pass
            raise GristError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise GristError(f"{method} {path} -> unreachable: {exc.reason}") from exc

    def get_doc(self) -> dict[str, Any]:
        return self._request("GET", f"/api/docs/{self.doc}") or {}

    def list_records(self, table_id: str = "Interviews") -> list[dict[str, Any]]:
        path = f"/api/docs/{self.doc}/tables/{table_id}/records"
        raw = self._request("GET", path)
        # Grist answers with {"records": [...]}; anything else (an HTML error
        # page parsed as JSON, a truncated body, a list) must surface as a
        # GristError — a bare AttributeError/TypeError would 500 the endpoint.
        if not isinstance(raw, dict):
            raise GristError(
                f"GET {path} -> unexpected payload ({type(raw).__name__})"
            )
        records = raw.get("records") or []
        if not isinstance(records, list):
            raise GristError(
                f"GET {path} -> unexpected 'records' ({type(records).__name__})"
            )
        return records

    def set_deleted(
        self, record_ids: list[Any], deleted: bool = True, table_id: str = "Interviews"
    ) -> list[int]:
        """Flip the soft-delete flag on records; returns the ids actually sent.

        A PATCH on the records collection is what Grist's own UI does for a
        cell edit. An empty id list is a no-op, so a stale UI selection can't
        turn into an accidental "delete everything".
        """
        ids = normalize_record_ids(record_ids)
        if not ids:
            return []
        path = f"/api/docs/{self.doc}/tables/{table_id}/records"
        body = {
            "records": [
                {"id": rid, "fields": {DELETED_COLUMN: bool(deleted)}} for rid in ids
            ]
        }
        self._request("PATCH", path, body=body)
        return ids

    def purge_records(
        self, record_ids: list[Any], table_id: str = "Interviews"
    ) -> list[int]:
        """Permanently remove records; returns the ids actually sent.

        Grist's delete endpoint takes a bare JSON array of row ids
        (``POST /api/docs/<doc>/tables/<table>/records/delete``) and answers
        200 with an empty body. Reserved for rows that are already flagged
        ``Deleted`` — the page's permanent-delete action.
        """
        ids = normalize_record_ids(record_ids)
        if not ids:
            return []
        path = f"/api/docs/{self.doc}/tables/{table_id}/records/delete"
        self._request("POST", path, body=ids)
        return ids


def track_label(track: str) -> str:
    """Human label for a track value ('devops' -> 'DevOps'); unknown -> as-is."""
    return TRACKS.get((track or "").strip().lower(), (track or "").strip() or "—")


def normalize_record_ids(raw: Any) -> list[int]:
    """Coerce a UI-supplied id list into unique positive ints.

    Anything that isn't a row id (booleans are ints in Python, so they are
    rejected explicitly, as are floats, dicts and negative/zero values) is
    dropped rather than raising — a malformed selection must not 500 the page.
    """
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[int] = []
    for item in raw:
        if isinstance(item, bool):
            continue
        if isinstance(item, int):
            value = item
        elif isinstance(item, str) and item.strip().lstrip("-").isdigit():
            value = int(item.strip())
        else:
            continue
        if value > 0 and value not in out:
            out.append(value)
    return out


def parse_rubric(raw: Any) -> dict[str, Any]:
    """The ``Rubric`` column -> which grading plan scored this report.

    Written by the n8n grader as JSON: the generated plan's title, model and
    dimension weights, or a marker that the built-in track rubric was used.
    Rows written before the column existed (and anything unparseable) yield
    ``{}`` so the page shows a fallback instead of breaking.
    """
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    dimensions: list[dict[str, Any]] = []
    for item in data.get("dimensions") or []:
        if not isinstance(item, dict):
            continue
        weight = item.get("weight")
        dimensions.append(
            {
                "key": str(item.get("key") or ""),
                "label": str(item.get("label") or item.get("key") or ""),
                "weight": weight if isinstance(weight, (int, float)) else None,
            }
        )

    def _int(value: Any) -> int | None:
        return int(value) if isinstance(value, (int, float)) else None

    return {
        "source": "plan" if data.get("source") == "plan" else "builtin",
        "title": str(data.get("title") or "").strip(),
        "model": str(data.get("model") or "").strip(),
        "generatedAt": str(data.get("generated_at") or "").strip(),
        "passScore": _int(data.get("pass_score")),
        "reviewScore": _int(data.get("review_score")),
        "dimensions": dimensions,
    }


def parse_dimensions(raw: str) -> list[dict[str, Any]]:
    """Dimensions JSON string -> ordered list of {name, score, evidence}.

    The grader stores ``{name: {score, evidence}}``; a list or malformed JSON
    degrades to empty so the UI can show a fallback instead of crashing.
    """
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    for name, val in data.items():
        if isinstance(val, dict):
            out.append(
                {
                    "name": name,
                    "score": val.get("score"),
                    "evidence": val.get("evidence") or "",
                }
            )
        else:
            out.append({"name": name, "score": val, "evidence": ""})
    return out


def parse_str_list(raw: str) -> list[str]:
    """A grader JSON list field (strengths/improvements) -> list[str]."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [str(item) for item in data if str(item).strip()]


def row_to_report(row: dict[str, Any]) -> dict[str, Any]:
    """Grist record -> flat report dict for the dashboard."""
    fields = row.get("fields", {}) or {}
    if not isinstance(fields, dict):
        fields = {}
    score = fields.get("Score")
    verdict = str(fields.get("Verdict") or "").strip().lower()
    return {
        "id": row.get("id"),
        "track": str(fields.get("Track") or "").strip().lower(),
        "trackLabel": track_label(str(fields.get("Track") or "")),
        # "Prospect" is the current column; fall back to the legacy "Student"
        # column so pre-rename rows keep showing their name.
        "prospect": str(fields.get("Prospect") or fields.get("Student") or "").strip(),
        "phone": str(fields.get("Phone") or "").strip(),
        "runId": str(fields.get("RunID") or "").strip(),
        "score": score if isinstance(score, (int, float)) else None,
        "verdict": verdict if verdict in {"pass", "review", "fail"} else "unknown",
        "dimensions": parse_dimensions(fields.get("Dimensions") or ""),
        "strengths": parse_str_list(fields.get("Strengths") or ""),
        "improvements": parse_str_list(fields.get("Improvements") or ""),
        # Which rubric produced this grade (the grader stamps it per row).
        "rubric": parse_rubric(fields.get("Rubric")),
        "transcript": str(fields.get("Transcript") or ""),
        "parseError": str(fields.get("parse_error") or "").strip(),
        # Soft delete: rows the Control Center threw away but kept restorable.
        # Rows written before the column existed have no value -> not deleted.
        "deleted": bool(fields.get(DELETED_COLUMN)),
    }


def sort_reports(reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Newest record id first (Grist record ids are monotonic)."""
    return sorted(reports, key=lambda r: -(r.get("id") or 0))


def rows_to_reports(rows: list[Any]) -> list[dict[str, Any]]:
    """Grist records -> report dicts, newest first.

    Rows that aren't records (``None``, a bare scalar from a malformed
    payload) are skipped rather than raising, so one bad row can't blank the
    whole Interview Reports page.
    """
    reports = [row_to_report(row) for row in rows if isinstance(row, dict)]
    return sort_reports(reports)


def filter_reports(
    reports: list[dict[str, Any]], track: str = "all", search: str = ""
) -> list[dict[str, Any]]:
    """Track filter + substring search across prospect/phone/runId."""
    needle = (search or "").strip().lower()
    out = []
    for report in reports:
        if track != "all" and report.get("track") != track:
            continue
        if needle:
            haystack = " ".join(
                str(report.get(field) or "")
                for field in ("prospect", "phone", "runId")
            ).lower()
            if needle not in haystack:
                continue
        out.append(report)
    return out


def verdict_stats(reports: list[dict[str, Any]]) -> dict[str, Any]:
    """Summary chips: counts per verdict + average score (scored rows only)."""
    counts = {"pass": 0, "review": 0, "fail": 0, "unknown": 0}
    scored: list[float] = []
    for report in reports:
        counts[report.get("verdict", "unknown")] = (
            counts.get(report.get("verdict", "unknown"), 0) + 1
        )
        score = report.get("score")
        if isinstance(score, (int, float)):
            scored.append(float(score))
    avg = round(sum(scored) / len(scored), 1) if scored else None
    return {
        "total": len(reports),
        **counts,
        "averageScore": avg,
    }
