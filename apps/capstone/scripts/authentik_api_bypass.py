#!/usr/bin/env python3
"""Let `pbx.innotel.site/api/` reach the console without Authentik's SSO redirect.

The console's API is consumed by machines (health probes, the voice check, the
dashboard), so a 302 to `/outpost.goauthentik.io/start` breaks them while the UI
should stay protected. Authentik's proxy provider has exactly the lever for
that: `skip_path_regex`, a regex of paths the outpost forwards untouched.

This is idempotent and never removes an existing pattern — it appends ours if it
is missing, and reports what it found otherwise.

    AUTHENTIK_TOKEN=<admin token> python3 scripts/authentik_api_bypass.py --dry-run
    AUTHENTIK_TOKEN=<admin token> python3 scripts/authentik_api_bypass.py

Needs a token with permission to read/write providers on the instance that
fronts the host (defaults to https://auth.innotel.us, the instance the pbx outpost
itself redirects to; auth.innotel.site is the same server, and the LAN address
192.168.1.127 answers on 9000 if you ever have a shell there). The outpost picks the
change up on its next refresh (~60 s); no redeploy, no restart.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_API = "https://auth.innotel.us"
DEFAULT_HOST = "pbx.innotel.site"
PATTERN = r"^/api/"


def call(base: str, token: str, method: str, path: str, body: dict | None = None):
    url = base.rstrip("/") + "/api/v3" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode() or "{}"
        return json.loads(raw)


def find_provider(base: str, token: str, host: str) -> dict:
    apps = call(base, token, "GET", "/core/applications/?page_size=200").get("results", [])
    wanted = [a for a in apps if host in (a.get("external_host") or "")]
    if not wanted:
        raise SystemExit(
            f"no application on {base} has external_host containing {host} "
            f"(saw {len(apps)} applications)"
        )
    if len(wanted) > 1:
        names = ", ".join(a.get("slug", "?") for a in wanted)
        raise SystemExit(f"ambiguous: several applications match {host} ({names})")
    app = wanted[0]
    provider = call(base, token, "GET", f"/providers/proxy/{app['provider']}/")
    return {"application": app, "provider": provider}


def merge_regex(current: str, pattern: str) -> tuple[str, bool]:
    parts = [p for p in (current or "").split("|") if p]
    if pattern in parts or pattern.strip("^/") in (current or ""):
        return current, False
    parts.append(pattern)
    return "|".join(parts), True


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--api", default=os.environ.get("AUTHENTIK_API_URL", DEFAULT_API))
    p.add_argument("--host", default=DEFAULT_HOST, help="external host to find")
    p.add_argument("--pattern", default=PATTERN, help="regex to skip forward-auth on")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    token = os.environ.get("AUTHENTIK_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "AUTHENTIK_TOKEN is not set. This needs an admin API token for "
            f"{args.api} (Authentik → Directory → Tokens). Without it every call "
            "returns 401 and nothing is changed."
        )

    try:
        found = find_provider(args.api, token, args.host)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise SystemExit(
                f"token rejected by {args.api} ({e.code}) — it is not an admin "
                "token for this instance"
            )
        raise SystemExit(f"{args.api} answered {e.code}: {e.read().decode(errors='replace')[:300]}")

    provider = found["provider"]
    app = found["application"]
    current = provider.get("skip_path_regex") or ""
    print(f"application: {app.get('slug')} ({app.get('external_host')})")
    print(f"provider:    {provider.get('name')} ({provider.get('pk')})")
    print(f"skip_path_regex now: {current!r}")

    merged, changed = merge_regex(current, args.pattern)
    if not changed:
        print(f"already allows {args.pattern} — nothing to do")
        return 0

    print(f"skip_path_regex after: {merged!r}")
    if args.dry_run:
        print("dry run: not writing")
        return 0

    call(args.api, token, "PATCH", f"/providers/proxy/{provider['pk']}/", {"skip_path_regex": merged})
    after = call(args.api, token, "GET", f"/providers/proxy/{provider['pk']}/")
    ok = args.pattern in (after.get("skip_path_regex") or "")
    print(f"wrote and read back: {ok}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
