#!/usr/bin/env python3
"""verify-dograh-sso.py — prove dograh's Authentik sign-in shows the real org.

WHY THIS EXISTS. SSO users were provisioned into a fresh `oidc-shared`
organization while every agent, telephony config and setting lived in the
original local-auth org — so an admin could sign in and see an empty platform.
The fix merged the organizations (org 1 adopted `oidc-shared` as its
provider_id); this check catches any regression, including the same failure in
reverse (data landing in an org the IdP never provisions into).

What it does, end to end over the public edge:

  1. Drives dograh's OWN OIDC flow (/api/v1/auth/oidc/login -> Authentik ->
     callback) with a real identity — not a synthetic token. The choreography
     that took the longest to get right:
       • the flow executor wants its OAuth context as `?query=<urlencoded
         authorize params>` (what /if/flow/... carries); pass anything else and
         Authentik completes login, then bounces to `/` with the dance lost;
       • the executor URL is relative to the IdP, not to the app that started
         login;
       • first-time identities get a consent stage; and
       • the callback answers 307, not 302 — follow any 3xx.
  2. Asserts the resulting JWT session reports `is_superuser` and sees the
     agents (workflow count > 0) plus the superuser/settings surface.

The identity is `akadmin` (the Cerulean bootstrap admin), whose password comes
from AUTHENTIK_BOOTSTRAP_PASSWORD in cerulean's .env — read, never printed.
Nothing is created or deleted: a read-only check against the live deployment.

Usage:
    python3 scripts/verify-dograh-sso.py
    DOGRAH_BASE=https://dograh.capstone.innotel.us python3 scripts/verify-dograh-sso.py

Exit codes: 0 = pass, 1 = a check failed, 2 = cannot run.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
# capstone lives at <estate>/2-voice/capstone; the estate root is two up.
CERULEAN_ENV = HERE.parents[2] / "1-primary/cerulean/.env"
DOGrah_BASE = os.environ.get("DOGRAH_BASE", "https://dograh.capstone.innotel.us")

# verify-sso.py already owns the Authentik flow client + admin API; reuse it.
_spec = importlib.util.spec_from_file_location("verify_sso", HERE / "verify-sso.py")
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)


def bootstrap_password() -> str:
    for path in (CERULEAN_ENV,):
        if path.exists():
            for line in path.read_text().splitlines():
                if line.startswith("AUTHENTIK_BOOTSTRAP_PASSWORD="):
                    value = line.split("=", 1)[1].strip()
                    if value:
                        return value
    print("cannot run: AUTHENTIK_BOOTSTRAP_PASSWORD not found in cerulean/.env",
          file=sys.stderr)
    sys.exit(2)


def drive_oidc_login(cfg, username: str, password: str) -> str:
    """Run dograh's OIDC dance; return the minted JWT."""
    c = v.Client(cfg, base=DOGrah_BASE)

    def absolute(url: str) -> str:
        return url if url.startswith("http") else c.base + url

    status, loc, _ = c.get(f"{DOGrah_BASE}/api/v1/auth/oidc/login")
    v.require(status in (301, 302, 307, 308), f"login start -> HTTP {status}")
    status, loc2, _ = c.get(loc)
    v.require(status in (301, 302, 307, 308) and loc2, f"authorize -> HTTP {status}")

    flow = urllib.parse.urlparse(urllib.parse.urljoin(cfg.idp + "/", loc2))
    c.base = f"{flow.scheme}://{flow.netloc}"
    url = (c.base + "/api/v3/flows/executor/default-authentication-flow/?"
           + urllib.parse.urlencode({"query": loc2.split("?", 1)[1]}))

    jwt_url = None
    for _hop in range(14):
        status, nxt, body = c.get(url)
        stage = json.loads(body) if status == 200 and body.strip().startswith("{") else None
        if stage is None and status in (301, 302, 307, 308) and nxt:
            if "access_token=" in nxt:
                jwt_url = nxt
                break
            url = absolute(nxt)
            continue
        if stage is None:
            raise v.CheckFailed(f"flow executor returned HTTP {status} at {url[:100]}")
        component = stage.get("component")
        if component == "xak-flow-redirect":
            v.require(stage["to"] not in ("", "/"),
                      "flow completed but lost the OAuth context (redirected to /)")
            url = absolute(stage["to"])
            continue
        if component == "ak-stage-identification":
            payload = {"uid_field": username}
        elif component == "ak-stage-password":
            payload = {"password": password}
        elif component == "ak-stage-consent":
            payload = {"accept": True}
        else:
            raise v.CheckFailed(f"unexpected Authentik stage {component}")
        status, nxt, body = c.post(absolute(url), payload)
        v.require(status in (200, 301, 302, 307, 308),
                  f"{component} rejected (HTTP {status}): {body[:150]}")
        if status in (301, 302, 307, 308) and nxt and "code=" in nxt:
            url = absolute(nxt)
            break
        url = absolute(nxt) if nxt else url
    else:
        raise v.CheckFailed("no authorization code after the stage loop")

    if not jwt_url:
        for _ in range(8):
            status, nxt, _body = c.get(url)
            if status in (301, 302, 307, 308) and nxt:
                if "access_token=" in nxt:
                    jwt_url = nxt
                    break
                url = absolute(nxt)
                continue
            break
    v.require(jwt_url, "the callback chain never carried an access_token fragment")
    return urllib.parse.parse_qs(urllib.parse.urlparse(jwt_url).fragment)["access_token"][0]


def main() -> int:
    import argparse
    cfg = v.Config(argparse.Namespace(base="capstone.innotel.us", host_ip=None, verbose=False))
    password = bootstrap_password()
    print(f"  sign in : akadmin via {DOGrah_BASE}")
    jwt = drive_oidc_login(cfg, "akadmin", password)
    print("  login   : OIDC dance completed, JWT minted ✓")

    def get(path: str):
        req = urllib.request.Request(DOGrah_BASE + path,
                                     headers={"Authorization": "Bearer " + jwt})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status, json.load(resp)
        except urllib.error.HTTPError as err:
            return err.code, (err.read() or b"").decode("utf-8", "replace")[:200]

    status, me = get("/api/v1/user/auth/user")
    v.require(status == 200 and isinstance(me, dict) and me.get("is_superuser") is True,
              f"auth/user -> {status}: admin is not a superuser: {me}")
    print(f"  session : superuser=True (id={me.get('id')}) ✓")

    status, count = get("/api/v1/workflow/count")
    total = count.get("total", 0) if isinstance(count, dict) else 0
    v.require(status == 200 and total > 0,
              f"workflow/count -> {status}: the admin session sees {total} agents — "
              "the data is in an organization the SSO provisioning does not join")
    print(f"  agents  : {total} visible through the SSO session ✓")

    status, _runs = get("/api/v1/superuser/workflow-runs")
    v.require(status == 200, f"superuser workflow-runs -> {status}: settings surface closed")
    print("  settings: superuser surface reachable ✓")

    print("PASS: dograh SSO lands the admin in the organization that owns the agents")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except v.CannotRun as error:
        print(f"cannot run: {error}", file=sys.stderr)
        sys.exit(2)
    except v.CheckFailed as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
