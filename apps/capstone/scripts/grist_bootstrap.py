#!/usr/bin/env python3
"""Bootstrap the Grist 'Interviews' table for the capstone stack.

Creates (or reuses) the Grist document and ensures the `Interviews` table
exists with exactly the columns the n8n grader workflow writes:
Track, Student, Phone, RunID, Score, Verdict, Dimensions, Strengths,
Improvements, Transcript.

The n8n Save-to-Grist node targets
`http://grist:8484/api/docs/<GRIST_DOC_ID>/tables/Interviews/records`, so the
resolved doc ID must end up in the compose `.env` as `GRIST_DOC_ID` (the
compose default is an empty UI draft and fails with "Document fork not
found" — this script replaces it with a real, writable doc).

Stdlib only — no pip packages, no jq.

Usage:
    # Create/reuse the doc and ensure the table (writes; prints doc ID):
    python3 scripts/grist_bootstrap.py

    # Verify only — no writes. Exit 0 if the table + columns are ready:
    python3 scripts/grist_bootstrap.py --check

    # Pin to a specific doc (e.g. an existing one from your environment):
    python3 scripts/grist_bootstrap.py --doc-id <id>

    # Custom instance:
    python3 scripts/grist_bootstrap.py --url http://localhost:8484

    # Add per-track saved filter views (IT / DevOps / SQL) to the dashboard:
    python3 scripts/grist_bootstrap.py --track-views
    python3 scripts/grist_bootstrap.py --track-views --check   # verify only

Environment:
    GRIST_DOC_ID   default doc to reuse (when --doc-id is not given)
    GRIST_API_KEY  optional Bearer token (only if auth is enabled)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

# (column id, Grist type, human label)
COLUMNS: list[tuple[str, str, str]] = [
    ("Track", "Text", "Interview track (it / devops / sql)"),
    ("Student", "Text", "Student name"),
    ("Phone", "Text", "Phone number"),
    ("RunID", "Text", "dograh workflow run id"),
    ("Score", "Numeric", "Overall score (0-100)"),
    ("Verdict", "Text", "pass / review / fail"),
    ("Dimensions", "Text", "Per-dimension scores (JSON)"),
    ("Strengths", "Text", "Strengths (JSON list)"),
    ("Improvements", "Text", "Improvements (JSON list)"),
    ("Transcript", "Text", "Full call transcript"),
]

TABLE_ID = "Interviews"
DOC_NAME = "Interview Scores"


class GristError(RuntimeError):
    pass


class GristClient:
    def __init__(self, base_url: str, api_key: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def list_records(self, doc_id: str, table_id: str) -> list[dict]:
        return self._request(
            "GET", f"/api/docs/{doc_id}/tables/{table_id}/records"
        ).get("records", [])

    def add_records(self, doc_id: str, table_id: str, records: list[dict]) -> Any:
        raw = self._request(
            "POST", f"/api/docs/{doc_id}/tables/{table_id}/records",
            {"records": records},
        )
        return (raw or {}).get("records", [])

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.base_url}{path}"
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read()).get("error", "")
            except Exception:
                pass
            raise GristError(f"{method} {path} -> HTTP {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            raise GristError(f"{method} {path} -> unreachable: {e.reason}") from e

    def get_doc(self, doc_id: str) -> Any:
        return self._request("GET", f"/api/docs/{doc_id}")

    def create_doc(self, name: str) -> str:
        raw = self._request("POST", "/api/docs", {"docName": name})
        # POST /api/docs returns the new doc id as a JSON string.
        if not isinstance(raw, str) or not raw:
            raise GristError(f"Unexpected create-doc response: {raw!r}")
        return raw

    def list_tables(self, doc_id: str) -> list[dict]:
        return self._request("GET", f"/api/docs/{doc_id}/tables").get("tables", [])

    def create_table(self, doc_id: str) -> None:
        columns = [
            {"id": cid, "fields": {"label": label, "type": ctype}}
            for cid, ctype, label in COLUMNS
        ]
        self._request(
            "POST",
            f"/api/docs/{doc_id}/tables",
            {"tables": [{"id": TABLE_ID, "columns": columns}]},
        )

    def list_columns(self, doc_id: str) -> list[str]:
        cols = self._request(
            "GET", f"/api/docs/{doc_id}/tables/{TABLE_ID}/columns"
        ).get("columns", [])
        return [c["id"] for c in cols]

    def add_columns(self, doc_id: str, columns: list[tuple[str, str, str]]) -> None:
        body = {
            "columns": [
                {"id": cid, "fields": {"label": label, "type": ctype}}
                for cid, ctype, label in columns
            ]
        }
        self._request(
            "POST", f"/api/docs/{doc_id}/tables/{TABLE_ID}/columns", body
        )


def resolve_doc(client: GristClient, doc_id: str | None, name: str) -> str:
    if doc_id:
        try:
            client.get_doc(doc_id)
            print(f"[grist] reusing existing doc {doc_id}")
            return doc_id
        except GristError as e:
            print(f"[grist] doc {doc_id} not usable ({e}) — creating a new one")
    new_id = client.create_doc(name)
    print(f"[grist] created new doc {new_id}")
    return new_id


# Per-track saved filter views on the Interviews table. Each creates a
# raw_data grid view with all Interviews columns and a saved filter on the
# Track column, so the dashboard gets one-click tabs per interview track.
TRACK_VIEWS: list[tuple[str, str]] = [
    ("it", "IT Track"),
    ("devops", "DevOps Track"),
    ("sql", "SQL Track"),
]


def ensure_track_views(client: GristClient, doc_id: str, check_only: bool) -> bool:
    """Create (or verify) a per-track saved filter view on the Interviews table.

    Grist stores views/filters in its internal _grist_* tables, which the
    records API exposes read/write. For each track: a _grist_Views row, a
    _grist_Views_section grid over all Interviews columns, the section's
    _grist_Views_section_field rows, and a _grist_Filters row filtering the
    Track column (filter text = Grist's client-side filter state JSON).
    Idempotent: skips views whose name already exists.
    """
    tbls = client.list_records(doc_id, "_grist_Tables")
    table_row = next(
        (r for r in tbls if r["fields"].get("tableId") == TABLE_ID), None
    )
    if table_row is None:
        print(f"[grist] FAIL — table '{TABLE_ID}' missing (run bootstrap first)")
        return False
    t_ref = table_row["id"]

    cols = client.list_records(doc_id, "_grist_Tables_column")
    col_refs = {
        c["fields"]["colId"]: c["id"]
        for c in cols
        if c["fields"].get("parentId") == t_ref and c["fields"].get("colId") != "manualSort"
    }
    track_ref = col_refs.get("Track")
    if track_ref is None:
        print(
            "[grist] FAIL — 'Track' column missing on Interviews "
            "(re-run the base bootstrap to add it)"
        )
        return False

    existing_views = {
        v["fields"]["name"]: v["id"]
        for v in client.list_records(doc_id, "_grist_Views")
    }
    ok = True
    for value, label in TRACK_VIEWS:
        if label in existing_views:
            print(f"[grist] track view '{label}' already exists — nothing to do")
            continue
        if check_only:
            print(f"[grist] FAIL (check) — track view '{label}' missing")
            ok = False
            continue

        view = client.add_records(
            doc_id, "_grist_Views",
            [{"fields": {"name": label, "type": "raw_data", "layoutSpec": ""}}],
        )
        view_id = view[0]["id"]
        section = client.add_records(
            doc_id, "_grist_Views_section",
            [{"fields": {
                "tableRef": t_ref, "parentId": view_id, "parentKey": "record",
                "title": "", "description": "", "defaultWidth": 100,
                "borderWidth": 1, "theme": "", "options": "", "chartType": "",
                "layoutSpec": "", "filterSpec": "", "sortColRefs": "[]",
                "linkSrcSectionRef": 0, "linkSrcColRef": 0, "linkTargetColRef": 0,
                "embedId": "", "rules": None, "shareOptions": "",
            }}],
        )
        section_id = section[0]["id"]

        client.add_records(
            doc_id, "_grist_Views_section_field",
            [{"fields": {"parentId": section_id, "colRef": ref}}
             for ref in col_refs.values()],
        )

        filter_text = json.dumps({
            "filters": {"Track": [value]},
            "filterLabels": {"Track": [value]},
            "operations": {"Track": "in"},
            "colTypes": {"Track": "Text"},
        })
        client.add_records(
            doc_id, "_grist_Filters",
            [{"fields": {
                "viewSectionRef": section_id, "colRef": track_ref,
                "filter": filter_text, "pinned": True,
            }}],
        )
        print(f"[grist] created track view '{label}' (filter Track = {value!r})")
    return ok


def ensure_table(client: GristClient, doc_id: str, check_only: bool) -> bool:
    try:
        tables = client.list_tables(doc_id)
    except GristError as e:
        print(f"[grist] FAIL — cannot read tables: {e}")
        return False

    existing = [t["id"] for t in tables]
    if TABLE_ID not in existing:
        if check_only:
            print(f"[grist] FAIL — table '{TABLE_ID}' missing (doc has: {existing})")
            return False
        client.create_table(doc_id)
        print(f"[grist] created table '{TABLE_ID}' with all {len(COLUMNS)} columns")
        return True

    current = set(client.list_columns(doc_id))
    want = {cid for cid, _, _ in COLUMNS}
    missing = [c for c in COLUMNS if c[0] not in current]

    if not missing:
        print(f"[grist] table '{TABLE_ID}' ready ({len(current)} columns)")
        return True

    if check_only:
        print(
            f"[grist] FAIL — table '{TABLE_ID}' missing columns: "
            f"{[c[0] for c in missing]}"
        )
        return False

    client.add_columns(doc_id, missing)
    print(f"[grist] added missing columns: {[c[0] for c in missing]}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("GRIST_URL", "http://127.0.0.1:8484"))
    parser.add_argument("--doc-id", default=os.environ.get("GRIST_DOC_ID", ""))
    parser.add_argument("--name", default=DOC_NAME)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify only — never create or modify anything",
    )
    parser.add_argument(
        "--track-views",
        action="store_true",
        help="also create (or verify) per-track saved filter views on Interviews",
    )
    args = parser.parse_args()

    client = GristClient(args.url, os.environ.get("GRIST_API_KEY"))

    try:
        if args.check:
            if not args.doc_id:
                print("[grist] FAIL — --check needs --doc-id or GRIST_DOC_ID")
                return 1
            doc_id = args.doc_id
        else:
            doc_id = resolve_doc(client, args.doc_id or None, args.name)
        ok = ensure_table(client, doc_id, check_only=args.check)
        if ok and args.track_views:
            ok = ensure_track_views(client, doc_id, check_only=args.check)
    except GristError as e:
        print(f"[grist] FAIL — {e}")
        return 1

    if not ok:
        print("[grist] bootstrap incomplete — fix the issues above and re-run")
        return 1

    print(f"\n[grist] GRIST_DOC_ID={doc_id}")
    if not args.check:
        print("[grist] add that line to .env, then recreate n8n so it picks up the")
        print("[grist] variable (the workflow reads it at runtime):")
        print(f"[grist]     docker compose -f docker-compose.yml up -d n8n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
