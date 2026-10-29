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

The Magnate entitlement gate (RevenueOps) rides along, because it was part of the
FreePBX sync this replaced and a merge into a document is not a reason to stop
billing for the routes: agents are a Magnate add-on SKU, so when
MAGNATE_PUBLIC_URL and MAGNATE_AGENT_PLAN are both set the sync may only write
`agent-number-<n>` routes while Magnate says that SKU is entitled. Not entitled
removes the routes this script owns (a human-written route is never touched), an
unreachable Magnate fails open so a billing outage never blacks out calls, a 401
aborts without writing anything, and a URL with no plan leaves the gate inactive
so existing deployments keep behaving as they did.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
OWNED_PREFIX = "agent-number-"
MAGNATE_TIMEOUT_SECONDS = 10


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


def magnate_entitlement(url: str, token: str, plan: str, user: str) -> dict[str, Any]:
    """Ask Magnate's v2.1 entitlement API whether the agent add-on SKU may route.

    Returns a dict whose ``mode`` the caller acts on:

      entitled      — 200 with entitled=true: routes may be (re)created.
      not_entitled  — authoritative no (200 entitled=false or 404): create no
                      routes and remove the ones this script owns.
      unauthorized  — 401: token mismatch. The caller aborts rather than
                      silently un-wiring routes on a config error.
      unreachable   — network/HTTP failure: fail open per Capstone policy (an
                      entitlements outage never blocks agent routing).
    """
    params = {"plan": plan}
    if user:
        params["user"] = user
    request = urllib.request.Request(
        f"{url}/api/entitlements?{urllib.parse.urlencode(params)}",
        headers={"Accept": "application/json"},
    )
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=MAGNATE_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read() or b"{}")
            status = response.status
        mode = "entitled" if data.get("entitled") is True else "not_entitled"
        return {
            "mode": mode,
            "reason": data.get("reason") or ("ok" if mode == "entitled" else "denied"),
            "plan": data.get("plan"),
            "http": status,
        }
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read() or b"{}")
        except Exception:  # noqa: BLE001 — the body may not be JSON
            data = {}
        if exc.code == 401:
            return {"mode": "unauthorized", "reason": data.get("reason", "unauthorized"), "http": exc.code}
        if exc.code == 404:
            return {"mode": "not_entitled", "reason": data.get("reason", "plan_not_found"), "http": exc.code}
        return {"mode": "unreachable", "reason": f"HTTP {exc.code}", "http": exc.code}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"mode": "unreachable", "reason": f"{exc.__class__.__name__}: {exc}", "http": None}


def entitle(args) -> dict[str, Any] | None:
    """Resolve the gate for this run, announcing it; None means abort.

    Kept apart from ``main`` so the decision — and the fact that a closed or
    unreadable gate is printed rather than merely acted on — stays in one place.
    """
    if not args.magnate_url:
        return {"mode": "standalone", "reason": "standalone_no_billing"}
    if not args.magnate_plan:
        print(f"[magnate] MAGNATE_AGENT_PLAN not set — gate inactive "
              f"(MAGNATE_PUBLIC_URL={args.magnate_url})")
        return {"mode": "disabled", "reason": "MAGNATE_AGENT_PLAN not set — gate inactive"}
    gate = magnate_entitlement(args.magnate_url, args.magnate_token, args.magnate_plan, args.magnate_user)
    if gate["mode"] == "unauthorized":
        print(f"FAIL Magnate entitlements returned 401 ({gate['reason']}) — "
              "check ENTITLEMENTS_API_TOKEN; refusing to write routes", file=sys.stderr)
        return None
    if gate["mode"] == "not_entitled":
        print(f"[magnate] NOT entitled ({gate['reason']}, plan={args.magnate_plan}) — "
              "un-wiring dograh inbound routes")
    else:
        print(f"[magnate] gate {gate['mode']} ({gate['reason']}, "
              f"plan={gate.get('plan') or args.magnate_plan})")
    return gate


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
    parser.add_argument("--magnate-url", default=os.environ.get("MAGNATE_PUBLIC_URL", ""),
                        help="Magnate storefront base URL (env MAGNATE_PUBLIC_URL); empty = standalone, no gate")
    parser.add_argument("--magnate-token", default=os.environ.get("ENTITLEMENTS_API_TOKEN", ""),
                        help="bearer token for Magnate's entitlements API (env ENTITLEMENTS_API_TOKEN)")
    parser.add_argument("--magnate-plan", default=os.environ.get("MAGNATE_AGENT_PLAN", ""),
                        help="agent add-on SKU slug/id on Magnate (env MAGNATE_AGENT_PLAN)")
    parser.add_argument("--magnate-user", default=os.environ.get("MAGNATE_AGENT_USER", ""),
                        help="optional subscriber the SKU is checked against (env MAGNATE_AGENT_USER)")
    args = parser.parse_args()
    args.magnate_url = args.magnate_url.strip().rstrip("/")
    args.magnate_plan = args.magnate_plan.strip()
    args.magnate_user = args.magnate_user.strip()

    try:
        numbers = dograh_numbers(args.dograh, args.token)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"sync: dograh unreachable at {args.dograh}: {exc}", file=sys.stderr)
        return 1

    gate = entitle(args)
    if gate is None:
        return 1
    closed = gate["mode"] == "not_entitled"
    # A closed gate still merges — with no numbers — so the routes this script
    # owns are removed rather than left pointing at an unpaid agent. The same is
    # true when dograh advertises nothing: the document may hold stale ones.
    if not numbers and not closed:
        print("sync: dograh advertises no numbers; nothing to route")
        return 0

    document = json.loads(Path(args.file).read_text(encoding="utf-8"))
    merged, created, removed = merge(document, [] if closed else numbers, args.app)
    print(f"sync: numbers {len(numbers)}  created {len(created)}  removed {len(removed)}")
    for number in created:
        print(f"  + {number} -> ari {args.app}")
    for name in removed:
        print(f"  - {name}")

    if args.dry_run:
        # A closed gate is a finding, not a no-op: say which numbers would lose
        # their route and exit non-zero so a --check run reports it.
        if closed:
            for number in numbers:
                print(f"PROBLEM: DID {number} not entitled ({gate['reason']}) — would be un-wired")
            return 1
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
