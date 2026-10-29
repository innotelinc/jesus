#!/usr/bin/env python3
"""Wire the capstone stack's switch, idempotently, over the control API.

This replaces `entrypoint-dograh.sh` + `asterisk_converge.py` + `rtp_settings_guard.py`.
Those three existed to bend a FreePBX image into shape on every boot: render
dialplan from the database, converge trunks, re-assert RTP rows a GUI kept
rewriting. Cantus has no GUI rewriting its configuration, so what is left is a
document and an inventory, and the work is:

  1. wait for the switch's control API;
  2. load `cantus/routes.json` (validated by the switch, not here);
  3. load `cantus/lines.json`'s lines as the line inventory;
  4. report whether the ARI application dograh uses is registered.

Every step reads before it writes, so running it on a healthy stack changes
nothing and prints the same report. Exit status is 0 when the switch is
consistent with these files, 1 when it is not (unreachable, invalid, or an
application nobody has registered).

    python3 pbx/bootstrap_cantus.py                       # docker compose network
    python3 pbx/bootstrap_cantus.py --url http://localhost:8088 --token "$CANTUS_CONTROL_TOKEN"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


class Switch:
    def __init__(self, base: str, token: str = "", timeout: float = 10.0):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout

    def call(self, path: str, method: str = "GET", body: dict | None = None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(f"{self.base}{path}", data=data, method=method)
        if data is not None:
            request.add_header("content-type", "application/json")
        if self.token:
            request.add_header("authorization", f"Bearer {self.token}")
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            payload = response.read()
        return json.loads(payload) if payload else None

    def wait(self, attempts: int = 30, delay: float = 2.0) -> dict:
        last = None
        for _ in range(attempts):
            try:
                return self.call("/v1/status")
            except (urllib.error.URLError, OSError, ValueError) as exc:
                last = exc
                time.sleep(delay)
        raise SystemExit(f"bootstrap: switch not reachable at {self.base}: {last}")


def load(name: str) -> dict:
    return json.loads((HERE / "cantus" / name).read_text(encoding="utf-8"))


def apply_routes(switch: Switch, document: dict) -> str:
    current = switch.call("/v1/routes") or {}
    if current.get("routes") == document.get("routes") and current.get("default") == document.get("default"):
        return "unchanged"
    switch.call("/v1/routes", method="POST", body=document)
    return "applied"


def apply_lines(switch: Switch, inventory: dict) -> str:
    existing = {(line.get("ext")): line for line in (switch.call("/v1/lines") or {}).get("lines", [])}
    created = updated = 0
    for line in inventory.get("lines", []):
        if line["ext"] not in existing:
            switch.call("/v1/lines", method="POST", body=line)
            created += 1
        elif existing[line["ext"]].get("displayName") != line.get("displayName"):
            switch.call("/v1/lines", method="POST", body=line)
            updated += 1
    for trunk in inventory.get("trunks", []):
        switch.call("/v1/trunks", method="POST", body=trunk)
    if created or updated:
        return f"{created} created, {updated} updated"
    return "unchanged"


def ari_apps(switch: Switch, user: str, password: str) -> list[dict]:
    """The registered applications, read from the ARI surface itself.

    Deliberately not from the control API: the control API answers "what does
    this switch believe", the ARI surface answers "who is actually subscribed",
    and the difference is exactly the failure this check exists to catch.
    """
    import base64

    request = urllib.request.Request(f"{switch.base}/ari/applications")
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    request.add_header("authorization", f"Basic {token}")
    with urllib.request.urlopen(request, timeout=switch.timeout) as response:
        return json.loads(response.read() or b"[]")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=os.environ.get("CANTUS_URL", "http://cantus-switch:8088"))
    parser.add_argument("--token", default=os.environ.get("CANTUS_CONTROL_TOKEN", ""))
    parser.add_argument("--app", default=os.environ.get("CANTUS_ARI_APP", "dograh"))
    parser.add_argument("--check-only", action="store_true", help="report drift, change nothing")
    args = parser.parse_args()

    switch = Switch(args.url, args.token)
    status = switch.wait()
    print(f"bootstrap: switch {status.get('node', {}).get('id', '?')} at {args.url}")

    routes = load("routes.json")
    inventory = load("lines.json")
    if args.check_only:
        print("bootstrap: routes  check-only, not compared")
        return 0

    print(f"bootstrap: routes  {apply_routes(switch, routes)}")
    print(f"bootstrap: lines   {apply_lines(switch, inventory)}")

    user = os.environ.get("CANTUS_ARI_USER", "dograh")
    password = os.environ.get("CANTUS_ARI_PASSWORD") or os.environ.get("DOGRAH_ARI_PASSWORD", "")
    try:
        apps = ari_apps(switch, user, password)
    except (urllib.error.URLError, OSError) as exc:
        print(f"bootstrap: ari surface unreachable: {exc}", file=sys.stderr)
        return 1
    names = [entry.get("name") for entry in apps if isinstance(entry, dict)]
    ok = args.app in names
    print(f"bootstrap: ari app {args.app} {'registered' if ok else 'NOT registered (is dograh up?)'}")
    if not ok:
        print("bootstrap: inbound agent numbers will be refused until the application connects", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
