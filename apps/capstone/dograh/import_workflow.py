"""Import dograh/interview-workflow.json as a new dograh workflow via the SDK.

Mirrors the upstream example (vai-platform/examples/python/create_workflow.py).

Requirements:
    pip install -r examples/python/requirements.txt

Environment variables (loaded from `.env` in this directory or the repo root):
    DOGRAH_API_ENDPOINT  - Dograh API base URL (e.g. http://localhost:8000)
    DOGRAH_API_TOKEN     - API token sent as X-API-Key

Run:
    python dograh/import_workflow.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from dograh_sdk import DograhClient
from dograh_sdk._generated_models import CreateWorkflowRequest

_HERE = Path(__file__).parent

load_dotenv(_HERE / ".env")
load_dotenv(_HERE.parent / ".env")  # repo root fallback


def main() -> int:
    api_endpoint = os.environ.get("DOGRAH_API_ENDPOINT", "http://localhost:8000")
    api_token = os.environ.get("DOGRAH_API_TOKEN")

    if not api_token:
        print("DOGRAH_API_TOKEN is required (set it in .env)", file=sys.stderr)
        return 1

    definition = json.loads((_HERE / "interview-workflow.json").read_text())
    name = definition.pop("name", "IT Help Desk Mock Interview")

    with DograhClient(base_url=api_endpoint, api_key=api_token) as client:
        workflow = client.create_workflow(
            body=CreateWorkflowRequest(
                name=name,
                workflow_definition=definition,
            )
        )
        print(
            f"Created workflow {workflow.id}: {workflow.name!r} "
            f"(status={workflow.status})"
        )
        print("Next: open it in the dograh UI, assign an inbound workflow to")
        print("extension 8000 (or use the trigger for outbound), and publish.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
