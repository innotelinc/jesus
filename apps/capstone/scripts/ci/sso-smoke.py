#!/usr/bin/env python3
"""sso-smoke.py — drive a real dograh OIDC sign-in end to end, then clean up.

Why: "Sign-in could not be completed" is the browser's message for any failure
in the chain, so the only way to know the chain works is to walk it. This does
exactly what a browser does — GET the app's login entry, authenticate at
Authentik, come back to the callback with the code and the state cookie, and
then use the session that results — using a temporary, clearly-named identity
that is deleted in a `finally` block.

    AK_TOKEN=<authentik api token> SMOKE_PW=<random> python3 sso-smoke.py
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

AUTH = "https://auth.cerulean.innotel.us"
APP = "https://dograh.capstone.innotel.us"
FLOW_SLUG = "default-authentication-flow"
USERNAME = "sso-smoke-temp"
EMAIL = "sso-smoke@innotel.us"
GROUP = "cerulean-platform"

TOKEN = os.environ.get("AK_TOKEN", "")
PASSWORD = os.environ.get("SMOKE_PW", "")
if not TOKEN or not PASSWORD:
    sys.exit("need AK_TOKEN and SMOKE_PW")

jar = http.cookiejar.CookieJar()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Return the redirect itself instead of following it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


no_follow = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(jar), NoRedirect
)
follow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def api(path: str, method: str = "GET", body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        AUTH + path, data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")[:300]}


def fetch(url: str, opener=follow, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, lower(r.headers), r.read(), r.url
    except urllib.error.HTTPError as e:
        return e.code, lower(e.headers), e.read(), url


def lower(headers) -> dict:
    """Header names arrive in whatever case the server chose (uvicorn sends
    `location`, the UI's Next proxy sends `Location`) — compare in one case."""
    return {k.lower(): v for k, v in headers.items()}


def cookies_for(domain: str) -> list[str]:
    return [f"{c.name}={c.value}" for c in jar if domain in (c.domain or "")]


def step(n: int, text: str) -> None:
    print(f"\n[{n}] {text}")


user_uuid = None
try:
    step(1, "resolve the allowed group + Authentik API")
    status, groups = api("/api/v3/core/groups/?search=" + urllib.parse.quote(GROUP))
    match = [g for g in groups.get("results", []) if g["name"] == GROUP]
    if not match:
        sys.exit(f"group {GROUP} not found (status {status})")
    group_uuid = match[0]["pk"]
    print(f"    group {GROUP} = {group_uuid}")

    step(2, "create the temporary identity")
    status, user = api("/api/v3/core/users/", "POST", {
        "username": USERNAME, "name": "SSO smoke test (temporary)",
        "email": EMAIL, "is_active": True, "path": "users", "type": "internal",
    })
    if status not in (200, 201):
        sys.exit(f"user create failed: {status} {user}")
    user_uuid = user["pk"]
    print(f"    created {EMAIL} ({user_uuid})")

    status, res = api(f"/api/v3/core/users/{user_uuid}/set_password/", "POST",
                      {"password": PASSWORD})
    print(f"    set_password -> {status}")

    status, res = api(f"/api/v3/core/groups/{group_uuid}/add_user/", "POST",
                      {"pk": user_uuid})
    print(f"    added to {GROUP} -> {status}")

    step(3, "app login entry (this is what the browser hits)")
    status, headers, body, _ = fetch(f"{APP}/api/v1/auth/oidc/login", no_follow)
    state_cookie = [c for c in cookies_for("dograh.capstone") if "state" in c]
    location = headers.get("location", "")
    authorize_url = location
    print(f"    HTTP {status}")
    print(f"    location head: {location[:72]}...")
    print(f"    state cookie: {state_cookie[0][:34] + '...' if state_cookie else 'MISSING'}")
    if status not in (301, 302, 303, 307) or not state_cookie:
        sys.exit("FAIL: the login entry did not hand the browser a redirect + state cookie")

    step(4, "follow the authorization request (no session yet)")
    status, headers, body, url = fetch(location, no_follow)
    location = headers.get("location", "")
    print(f"    HTTP {status} -> {location[:80]}")
    parsed = urllib.parse.urlsplit(location)
    slug = FLOW_SLUG
    if "/if/flow/" in parsed.path:
        slug = parsed.path.rstrip("/").split("/")[-1]
    query = parsed.query
    print(f"    flow slug: {slug}")

    step(5, "authenticate against the flow executor")
    ex = f"{AUTH}/api/v3/flows/executor/{slug}/?{query}"
    csrf = next((c.value for c in jar if c.name == "authentik_csrf"), "")
    hdrs = {"Content-Type": "application/json"}
    if csrf:
        hdrs["X-CSRFToken"] = csrf

    status, headers, body, _ = fetch(ex, follow, headers=hdrs)
    challenge = json.loads(body or b"{}")
    print(f"    GET  -> {status} {challenge.get('component')}")

    status, headers, body, _ = fetch(
        ex, follow, data=json.dumps({"uid_field": USERNAME}).encode(), headers=hdrs)
    challenge = json.loads(body or b"{}")
    print(f"    uid  -> {status} {challenge.get('component')}")

    status, headers, body, _ = fetch(
        ex, follow, data=json.dumps({"password": PASSWORD}).encode(), headers=hdrs)
    challenge = json.loads(body or b"{}")
    print(f"    pass -> {status} {challenge.get('component')}")
    if challenge.get("component") == "ak-stage-password":
        print("    " + json.dumps(challenge.get("response_errors") or {})[:200])
        sys.exit("FAIL: Authentik rejected the sign-in (check the flow/user)")
    redirect_to = challenge.get("to") or headers.get("location", "")

    step(6, "return to the app callback with the code")
    # The flow's `to` may be relative (Authentik resolves it against its own
    # origin, and for an authorization flow the real "next" is the authorize
    # URL again) — which is exactly what the browser re-requests now that it
    # holds a session. Try that first, then the flow's own target.
    candidates = [authorize_url]
    if redirect_to.startswith("http"):
        candidates.insert(0, redirect_to)
    status = headers = None
    for target in candidates:
        status, headers, body, url = fetch(target, no_follow)
        location = headers.get("location", "")
        print(f"    HTTP {status} -> {location[:96]}")
        if "code=" in location:
            break
    if "code=" not in location:
        sys.exit(f"FAIL: no authorization code came back ({location[:120]})")

    step(7, "app callback (token exchange + id_token + admission + session)")
    status, headers, body, url = fetch(location, no_follow)
    location = headers.get("location", "")
    print(f"    HTTP {status} -> {location[:80]}")
    set_cookies = [k for k in headers if k.lower() == "set-cookie"]
    jar_names = sorted({c.name for c in jar if "dograh.capstone" in (c.domain or "")})
    print(f"    app cookies now: {jar_names}")
    if "error=" in location or status >= 400:
        sys.exit(f"FAIL: the callback refused the sign-in: {location[:160]}")

    step(8, "use the issued token, the way the SPA does")
    # The callback hands the token to the SPA in the URL *fragment* (that is
    # what AUTHENTIK_POST_LOGIN_REDIRECT's /auth/callback page reads), so the
    # fragment — not a cookie — is where the session actually lives. A 401 here
    # would mean a token that Authentik-like verification accepts but this API
    # does not, which cookie-jar probing alone would never reveal.
    token = ""
    if "#" in location:
        frag = dict(urllib.parse.parse_qsl(location.split("#", 1)[1]))
        token = frag.get("access_token", "")
    print(f"    access_token from fragment: {'yes, %d chars' % len(token) if token else 'MISSING'}")
    if not token:
        sys.exit("FAIL: the callback redirect carried no access_token")

    ok = False
    for path in ("/api/v1/auth/me", "/api/v1/user", "/api/v1/workflows"):
        s, _, b, _ = fetch(APP + path, follow,
                           headers={"Authorization": f"Bearer {token}"})
        print(f"    GET {path} -> {s}")
        if s == 200 and not ok:
            ok = True
            try:
                who = json.loads(b)
                email = who.get("email") or who.get("user", {}).get("email")
                print(f"        identity: {email or who.get('username') or '(list response)'}")
            except Exception:
                pass
    if not ok:
        sys.exit("FAIL: the issued token was refused by every authenticated endpoint")

    print("\nRESULT: a real sign-in completes — authorize -> callback -> token -> authenticated request.")
finally:
    if user_uuid:
        print(f"\n[cleanup] deleting {EMAIL}")
        st, _ = api(f"/api/v3/core/users/{user_uuid}/", "DELETE")
        print(f"    DELETE -> {st}")
