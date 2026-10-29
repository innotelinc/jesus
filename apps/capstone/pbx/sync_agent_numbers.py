#!/usr/bin/env python3
"""Make every number dograh advertises dialable on the switch.

This is the Cantus replacement for `scripts/sync_dograh_routes.py`, which wrote
FreePBX rows with `docker exec mysql` and rendered an `extensions_custom_*.conf`
include. Both of those were how a second copy of the truth stayed in step with
the first; here there is one document, and the sync is a merge into it.

The merge is deliberate rather than a rewrite: routes a human wrote in
`cantus/routes.json` are preserved, and only the `agent-number-<n>` routes this
script owns are replaced. Run it on a timer, in the dashboard, or by hand:

    python3 pbx/sync_agent_numbers.py --dograh http://host.docker.internal:8000 \
        --token "$DOGRAH_API_TOKEN" --switch http://cantus-switch:8088

It prints what changed and exits 0 when the switch ended up holding every
number, 1 when it could not.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OWNED_PREFIX = "agent-number-"


def get(url: str, token: str = "") -> object:
    request = urllib.request.Request(url)
    if token:
        request.add_header("x-api-key", token)
        request.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read() or b"null")


def switch_call(base: str, path: str, token: str, method: str = "GET", body: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"{base.rstrip('/')}{path}", data=data, method=method)
    if data is not None:
        request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = response.read()
    return json.loads(payload) if payload else None


def dograh_numbers(base: str, token: str) -> list[str]:
    """The numbers dograh answers on, in the shape its API actually returns.

    It has moved between a bare list and an object with a `phone_numbers` key
    more than once, so both are accepted rather than pinning one release.
    """
    payload = get(f"{base.rstrip('/')}/api/v1/telephony/phone-numbers", token)
    if isinstance(payload, dict):
        payload = payload.get("phone_numbers") or payload.get("items") or []
    numbers = []
    for entry in payload or []:
        if not isinstance(entry, dict):
            continue
        number = entry.get("address") or entry.get("number") or entry.get("phone_number")
        if number:
            numbers.append(str(number))
    return numbers


def merge(document: dict, numbers: list[str], app: str) -> tuple[dict, list[str], list[str]]:
    kept = [route for route in document.get("routes", []) if not str(route.get("name", "")).startswith(OWNED_PREFIX)]
    before = {route["name"]: route for route in document.get("routes", []) if route.get("name", "").startswith(OWNED_PREFIX)}
    created = []
    for number in numbers:
        name = f"{OWNED_PREFIX}{number}"
        route = {
            "name": name,
            "when": {"to": f"{number}@*"},
            "then": [{"answer": {}}, {"ari": {"app": app}}],
        }
        kept.append(route)
        if name not in before:
            created.append(number)
    merged = dict(document, routes=kept)
    removed = [name for name in before if name[len(OWNED_PREFIX):] not in numbers]
    return merged, created, removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dograh", default=os.environ.get("DOGRAH_API_ENDPOINT", "http://host.docker.internal:8000"))
    parser.add_argument("--token", default=os.environ.get("DOGRAH_API_TOKEN", ""))
    parser.add_argument("--switch", default=os.environ.get("CANTUS_URL", "http://cantus-switch:8088"))
    parser.add_argument("--control-token", default=os.environ.get("CANTUS_CONTROL_TOKEN", ""))
    parser.add_argument("--app", default=os.environ.get("CANTUS_ARI_APP", "dograh"))
    parser.add_argument("--file", default=str(HERE / "cantus" / "routes.json"), help="document to merge into")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        numbers = dograh_numbers(args.dograh, args.token)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"sync: dograh unreachable at {args.dograh}: {exc}", file=sys.stderr)
        return 1
    if not numbers:
        print("sync: dograh advertises no numbers; nothing to route")
        return 0

    document = json.loads(Path(args.file).read_text(encoding="utf-8"))
    merged, created, removed = merge(document, numbers, args.app)
    print(f"sync: numbers {len(numbers)}  created {len(created)}  removed {len(removed)}")
    for number in created:
        print(f"  + {number} -> ari {args.app}")
    for name in removed:
        print(f"  - {name}")

    if args.dry_run:
        return 0

    try:
        switch_call(args.switch, "/v1/routes", args.control_token, method="POST", body=merged)
    except (urllib.error.URLError, OSError) as exc:
        print(f"sync: switch unreachable at {args.switch}: {exc}", file=sys.stderr)
        return 1
    Path(args.file).write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    print(f"sync: applied to {args.switch} and written to {args.file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
