#!/usr/bin/env python3
"""sync_dograh_routes.py — mirror dograh's phone numbers into FreePBX inbound routes.

Reads the phone numbers registered on dograh's ARI telephony config (each one
is a workflow↔extension binding created by `scripts/dograh_wire.py` or the
Workflow Studio) and auto-creates the FreePBX side of each:

  • a Custom Destination  →  dograh-inbound,<exten>,1
  • an Inbound Route      →  DID <exten> → that custom destination

...so the FreePBX GUI (Connectivity → Inbound Routes) can see and adjust them.
Idempotent: existing routes are left alone unless --force.

Usage (from the repo root, with the capstone .env loaded):
    python3 scripts/sync_dograh_routes.py            # create missing routes
    python3 scripts/sync_dograh_routes.py --check    # verify only
    python3 scripts/sync_dograh_routes.py --force    # update existing routes

Environment / args:
    --dograh-endpoint  dograh API base (env DOGRAH_API_ENDPOINT, default http://127.0.0.1:8000)
    --dograh-token     X-API-Key (env DOGRAH_API_TOKEN, required)
    --url              FreePBX base URL (env FREEPBX_URL, default http://127.0.0.1)
    --container        freepbx container (env FREEPBX_CONTAINER, default pbx-freepbx)
    --client-id        OAuth client id (env FREEPBX_CLIENT_ID, default pbxportal-api)
    --client-secret    OAuth client secret (env FREEPBX_CLIENT_SECRET, required)
    --config-name      dograh telephony config name (env DOGRAH_CONFIG_NAME, default 'Asterisk ARI (dograh)')
    --force            update existing routes (default: skip)
    --check            verify only, no writes
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "pbx"))

from bootstrap_dograh_route import (  # noqa: E402
    FreepbxApi,
    FreepbxError,
    ensure_custom_dest,
    kvstore_table,
    resolve_container,
)


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def dograh_phone_numbers(endpoint: str, token: str, config_name: str) -> list[dict]:
    """List phone numbers on the ARI telephony config (dograh API)."""
    h = {"X-API-Key": token, "Accept": "application/json"}
    req = urllib.request.Request(f"{endpoint}/api/v1/organizations/telephony-configs", headers=h)
    with urllib.request.urlopen(req, timeout=30) as resp:
        configs = (json.loads(resp.read() or b"{}") or {}).get("configurations", [])
    cfg = next((c for c in configs if c.get("name") == config_name), None)
    if not cfg:
        raise FreepbxError(f"no telephony config named '{config_name}' found in dograh")
    req = urllib.request.Request(
        f"{endpoint}/api/v1/organizations/telephony-configs/{cfg['id']}/phone-numbers",
        headers=h,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return (json.loads(resp.read() or b"{}") or {}).get("phone_numbers", [])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(REPO / ".env"))
    parser.add_argument("--dograh-endpoint",
                        default=os.environ.get("DOGRAH_API_ENDPOINT", "http://127.0.0.1:8000"))
    parser.add_argument("--dograh-token", default=os.environ.get("DOGRAH_API_TOKEN", ""))
    parser.add_argument("--url", default=os.environ.get("FREEPBX_URL", "http://127.0.0.1"))
    parser.add_argument("--container", default=os.environ.get("FREEPBX_CONTAINER", "pbx-freepbx"))
    parser.add_argument("--client-id", default=os.environ.get("FREEPBX_CLIENT_ID", "pbxportal-api"))
    parser.add_argument("--client-secret", default=os.environ.get("FREEPBX_CLIENT_SECRET", ""))
    parser.add_argument("--config-name",
                        default=os.environ.get("DOGRAH_CONFIG_NAME", "Asterisk ARI (dograh)"))
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    args.env = load_env_file(Path(args.env_file))
    token = args.dograh_token or args.env.get("DOGRAH_API_TOKEN", "")
    secret = args.client_secret or args.env.get("FREEPBX_CLIENT_SECRET", "")
    endpoint = args.dograh_endpoint or args.env.get("DOGRAH_API_ENDPOINT", "http://127.0.0.1:8000")

    if not token:
        print("FAIL DOGRAH_API_TOKEN required (run scripts/dograh_wire.py once)", file=sys.stderr)
        return 1
    if not secret:
        print("FAIL FREEPBX_CLIENT_SECRET required", file=sys.stderr)
        return 1

    container = resolve_container(args.container)
    problems: list[str] = []

    try:
        numbers = dograh_phone_numbers(endpoint, token, args.config_name)
    except (urllib.error.URLError, urllib.error.HTTPError, FreepbxError, KeyError) as e:
        print(f"FAIL could not read dograh phone numbers: {e}", file=sys.stderr)
        return 1

    if not numbers:
        print("No phone numbers registered on the dograh config — nothing to sync.")
        return 0

    table = None
    if not args.check:
        table = kvstore_table(container)

    api = FreepbxApi(args.url, args.client_id, secret)
    try:
        api.wait_ready(timeout=300)
    except FreepbxError as e:
        print(f"FAIL FreePBX API not ready: {e}", file=sys.stderr)
        return 1

    print(f"[sync] {len(numbers)} dograh phone number(s) → FreePBX inbound routes")
    for num in numbers:
        ext = str(num.get("address", "")).strip()
        label = num.get("label") or f"dograh ext {ext}"
        if not ext:
            continue
        target = f"dograh-inbound,{ext},1"
        desc = f"Dograh Voice Agent ({label})"
        try:
            existing = api.find_route(ext)
            if existing and not args.force:
                print(f"PASS inbound route DID {ext} already exists ({existing.get('description')})")
                continue
            if args.check:
                if existing:
                    print(f"PASS inbound route DID {ext} present")
                else:
                    problems.append(f"inbound route DID {ext} missing")
                continue
            # Custom destination first (the API module can't create those).
            ensure_custom_dest(container, table, target, desc)
            api.add_route(ext, desc, target)
            print(f"PASS inbound route DID {ext} → {target}")
        except (FreepbxError, OSError) as e:
            problems.append(f"DID {ext}: {e}")

    if problems:
        print()
        for p in problems:
            print(f"  PROBLEM: {p}")
        return 1
    print("\n[sync] done — open FreePBX → Connectivity → Inbound Routes to review/map DIDs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())