#!/usr/bin/env python3
"""npm_smoke_test.py — verify every Capstone NPM proxy host through the public edge.

Checks, per https://<sub>.<NPM_BASE_DOMAIN>/ (STRICT TLS — no cert skipping):

  • DNS resolves
  • TLS handshake + certificate validity (system trust store)
  • gated hosts (the ones flagged `gated` in npm-proxy-hosts.py — FreePBX, n8n,
    Grist, Grafana, Workflow Studio) bounce an unauthenticated request into the
    IdP, by either handshake this stack uses:
      – the Authentik outpost (302 → /outpost.goauthentik.io/start, which must
        also answer /ping with 204 and then reach an /application/o/authorize/
        that renders), or
      – an oauth2-proxy gateway (302 → the IdP's /application/o/authorize/
        carrying THIS host's /oauth2/callback as redirect_uri, which must
        render rather than reject the callback)
  • open hosts (everything else: api, dashboard/admin, auth, voice, apex, the
    app and the media prefix) respond WITHOUT being gated (200/302-to-auth-flow/
    404/307 are all fine — they serve machine traffic, the OIDC redirect target,
    the IdP, or WS signaling)
  • the media prefix (/voice-audio) on the hosts that proxy it reaches MinIO
    (an S3 XML body, not the edge's error page) — transcripts and recordings
    are unsigned URLs on the app hosts, so a stale upstream there only ever
    shows up as a failed transcript fetch at grading time
  • the app's own page on each origin that serves it (apex, app, dograh) renders
    for a session cookie the API will reject, rather than the pre-patch
    "Authentication required" dead end — a UI image built from the registry's
    `main` answers 200 with that dead end for every signed-in user, so this is
    the only check here that can name a stale image

Exit codes, matching scripts/ci/sso-smoke.py: 0 = every host passed, 1 = a
host failed, 2 = the edge could not be reached at all (no route to the estate —
the hosted-CI case) — a SKIP, not a pass.

Usage:
  python3 scripts/npm-smoke-test.py                 # config from .env
  python3 scripts/npm-smoke-test.py --base-domain capstone.innotel.us
  python3 scripts/npm-smoke-test.py --timeout 10
"""

from __future__ import annotations

import argparse
import importlib.util
import socket
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlparse

REPO = Path(__file__).resolve().parent.parent


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def load_hosts_module():
    """Import HOSTS (and per-host metadata) from npm-proxy-hosts.py."""
    spec = importlib.util.spec_from_file_location(
        "npm_proxy_hosts", REPO / "scripts" / "npm-proxy-hosts.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # surface 30x to the caller instead of following


OPENER = urllib.request.build_opener(NoRedirect)


def fetch(url: str, timeout: int) -> tuple[int, str | None]:
    """Strict-TLS GET that does not follow redirects: (status, Location)."""
    req = urllib.request.Request(url, headers={"User-Agent": "capstone-npm-smoke/1.0"})
    try:
        with OPENER.open(req, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Location")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Location")


def edge_reachable(base_domain: str, timeout: int) -> bool:
    """Whether the edge answers at all — the gate between a SKIP and a report.

    A runner with no route to the estate (the hosted-CI case) must not fail the
    build once per host: an edge that never answers says nothing about the
    hosts behind it, which is a SKIP. An edge that does answer, and then fails
    a host, is a real finding — so any HTTP status, including an error one,
    counts as reachable and the run continues into the per-host checks.
    """
    try:
        fetch(f"https://{base_domain}/", timeout)
        return True
    except (urllib.error.URLError, OSError, ssl.SSLError):
        return False


def fetch_body(url: str, timeout: int) -> tuple[int, str, str | None]:
    """Strict-TLS GET that does not follow redirects: (status, body, Location).

    The body is what tells a service's own answer from a proxy's failure page —
    NPM rewrites the Server header on what it proxies, so that one says
    `openresty` either way.
    """
    req = urllib.request.Request(url, headers={"User-Agent": "capstone-npm-smoke/1.0"})
    try:
        with OPENER.open(req, timeout=timeout) as resp:
            return (resp.status, resp.read(600).decode("utf-8", "replace"),
                    resp.headers.get("Location"))
    except urllib.error.HTTPError as e:
        return (e.code, (e.read(600) or b"").decode("utf-8", "replace"),
                e.headers.get("Location"))


def is_sso_redirect(location: str | None, signin_base: str) -> bool:
    if not location:
        return False
    loc_host = urlparse(location).netloc
    auth_host = urlparse(signin_base).netloc or urlparse(signin_base).path
    return "outpost.goauthentik.io/start" in location and (
        not auth_host or loc_host == auth_host
    )


# Five hosts are gated by an oauth2-proxy gateway instead of an outpost (see the
# `gated` rows in npm-proxy-hosts.py). Those answer an unauthenticated request
# with a 302 straight into the IdP's authorization endpoint that carries THIS
# host's own /oauth2/callback as redirect_uri — which is what makes "the gate is
# on" provable without a session: the redirect hands the browser to an OIDC
# authorize URL whose callback is this very host.
AUTHORIZE_PATH = "/application/o/authorize/"


def is_oauth2_proxy_redirect(location: str | None, host: str) -> bool:
    """A 302 into the IdP for THIS host (the oauth2-proxy handshake)."""
    if not location:
        return False
    parsed = urlparse(location)
    if AUTHORIZE_PATH not in parsed.path:
        return False
    query = parse_qs(parsed.query)
    if not (query.get("client_id") or [""])[0]:
        return False
    return urlparse((query.get("redirect_uri") or [""])[0]).netloc == host


def check_oauth2_proxy_chain(authorize_url: str, timeout: int) -> tuple[str, str]:
    """The authorize call the gateway handed out must render, not reject us.

    Same #5922-shaped failure the outpost walk asserts: a redirect_uri the
    provider does not own comes back as HTTP 400 "Redirect URI Error" before any
    login — which still *looks* like a working gate from outside.
    """
    idp = urlparse(authorize_url).netloc
    try:
        status, body, location = fetch_body(authorize_url, timeout)
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, ssl.SSLError) as e:
        return "FAIL", f"authorize {idp}: {getattr(e, 'code', e)}"
    if status == 400 and "redirect" in body.lower():
        return "FAIL", "authorize rejected the redirect_uri (400)"
    # Either answer is a working gate: the login page itself (200), or the
    # provider moving the browser on into its flow (3xx) — which is what this
    # IdP does. Anything else (4xx/5xx) is the gate failing, not gating.
    if 200 <= status < 400:
        target = urlparse(location or "").path or "login"
        return "PASS", f"oauth2-proxy → {idp} authorize ok ({status} → {target})"
    return "FAIL", f"authorize returned {status}"


def check_sso_chain(start_url: str, signin_base: str, timeout: int) -> str | None:
    """Walk the forward-auth handshake and return None when it is sound.

    `start_url` is the `/outpost.goauthentik.io/start` the gate bounced to.
    Two failure modes are #5922-shaped and invisible to a single-request
    check, so they are asserted explicitly:

      * the outpost's `authentik_host` points at a DIFFERENT Authentik vhost,
        so the browser lands on an /application/o/authorize/ URL on a host
        whose origin does not own the provider (cross-domain cookie/redirect
        mismatch);
      * that authorize call rejects the `redirect_uri`, which Authentik
        renders as "Redirect URI Error" (HTTP 400) before the login flow.
    """
    try:
        status, location = fetch(start_url, timeout)
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, ssl.SSLError) as e:
        return f"outpost start: {getattr(e, 'code', e)}"
    if not location or "/application/o/authorize/" not in location:
        return f"outpost start did not reach authorize (status {status})"
    auth_host = urlparse(signin_base).netloc or urlparse(signin_base).path
    loc_host = urlparse(location).netloc
    if auth_host and loc_host != auth_host:
        return (
            f"authorize bounced to {loc_host!r} (outpost authentik_host is not {auth_host!r} — "
            "cross-domain SSO, the classic redirect_uri mismatch)"
        )
    try:
        status, _ = fetch(location, timeout)
    except urllib.error.HTTPError as e:
        return f"authorize returned {e.code} (redirect_uri rejected)"
    except (urllib.error.URLError, OSError, ssl.SSLError) as e:
        return f"authorize: {getattr(e, 'code', e)}"
    if status >= 400:
        return f"authorize returned {status} (redirect_uri rejected)"
    return None


def check_host(domain: str, gated: bool, signin_base: str, timeout: int) -> tuple[str, str]:
    """One host → (verdict, note). Gated hosts must bounce to SSO; open
    hosts must serve without a bounce. Both must present a valid cert."""
    try:
        status, location = fetch(f"https://{domain}/", timeout)
    except urllib.error.HTTPError as e:  # pragma: no cover
        return "FAIL", f"HTTP {e.code}"
    except (urllib.error.URLError, OSError, ssl.SSLError) as e:
        reason = getattr(e, "reason", None) or e
        return "FAIL", f"DNS/TLS/connect: {reason}"

    if gated:
        if is_sso_redirect(location, signin_base):
            # The gate works; the outpost behind the same vhost must too.
            try:
                st, _ = fetch(f"https://{domain}/outpost.goauthentik.io/ping", timeout)
                if st != 204:
                    return "FAIL", f"SSO ok but outpost ping {st}"
            except (urllib.error.HTTPError, urllib.error.URLError, OSError, ssl.SSLError) as e:
                return "FAIL", f"outpost ping: {getattr(e, 'code', e)}"
            chain_error = check_sso_chain(location, signin_base, timeout)
            if chain_error:
                return "FAIL", chain_error
            return "PASS", "SSO redirect + outpost ping 204 + authorize ok"
        if is_oauth2_proxy_redirect(location, domain):
            return check_oauth2_proxy_chain(location, timeout)
        if status < 500:
            return "FAIL", f"NOT gated — served {status} without SSO"
        return "FAIL", f"upstream error {status}"
    # Open host: no SSO bounce, any real HTTP answer is fine.
    if location and "outpost.goauthentik.io/start" in location:
        return "FAIL", "SSO-gated but expected open"
    if status < 500:
        return "PASS", f"open ({status})"
    return "FAIL", f"upstream error {status}"


def walk_to_authorize(url: str, timeout: int, hops: int = 3) -> tuple[bool, str]:
    """Follow the sign-in entry's redirects and require that they reach the IdP.

    A stale UI image answers this entry with 200 and the IdP's *page*: the UI's
    own API proxy resolved the 307 server-side, so neither the Location nor the
    state cookie ever reached the browser and the sign-in did nothing. A status
    check alone cannot tell that from a working sign-in — the assertion has to
    be that the browser is sent onwards, and that the end of the chain is the
    IdP's authorize endpoint (npm-proxy-hosts.py OIDC_PATH).
    """
    for _ in range(hops):
        try:
            status, location = fetch(url, timeout)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, ssl.SSLError) as e:
            return False, f"{getattr(e, 'code', e)}"
        if not location:
            return False, f"answered {status} with no redirect (the sign-in never leaves)"
        if AUTHORIZE_PATH in location:
            return True, f"{status} → authorize on {urlparse(location).netloc}"
        if not location.startswith("http"):
            return False, f"redirect to a non-absolute target: {location[:60]}"
        url = location
    return False, f"still no authorize endpoint after {hops} redirects"


# The one request that tells a patched voice UI from a registry-built one. The
# dead-end branch (dograh/patches/0001) renders only when the middleware lets
# the request through, and the middleware guards on the *presence* of the
# session cookie — so a cookie the API will reject is enough to see which image
# is answering, with no account and nothing to undo. docs/operations.md carries
# the same probe under the login gates.
UI_PAGE = "/workflow"
UI_PROBE_COOKIE = "dograh_auth_token=probe"
UI_DEAD_END = "Authentication required"
UI_PROBE_BODY_LIMIT = 512 * 1024


def probe_ui_image(domain: str, timeout: int) -> tuple[bool, str]:
    """One request that tells a patched UI image from a registry-built one.

    A patched image resolves the cookie as the session and renders the page it
    names; an image built from the ``innotelinc/dograh`` fork's ``main`` has a
    ``getServerAccessToken()`` that knows only ``stack``/``local``, so the same
    cookie resolves to no token and the page renders the dead end instead. Both
    answer HTTP 200 with a page on it, which is why the assertion has to be on
    the body — no status check can separate them.

    The sign-in walk above cannot either: the edge cuts the OIDC legs straight
    to the API (npm-proxy-hosts.py OIDC_PATH), so an unpatched UI still sends a
    browser to the IdP and the entry passes on exactly the image that renders
    nothing useful once the person arrives back signed in.
    """
    req = urllib.request.Request(
        f"https://{domain}{UI_PAGE}",
        headers={"User-Agent": "capstone-npm-smoke/1.0", "Cookie": UI_PROBE_COOKIE},
    )
    try:
        with OPENER.open(req, timeout=timeout) as resp:
            status = resp.status
            body = resp.read(UI_PROBE_BODY_LIMIT).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status = e.code
        body = (e.read(UI_PROBE_BODY_LIMIT) or b"").decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ssl.SSLError) as e:
        return False, f"connect: {getattr(e, 'reason', e)}"
    if UI_DEAD_END in body:
        return False, (
            "the UI answered the pre-0001 dead end — this image predates "
            "dograh/patches/0001 (a registry tag cannot carry them)"
        )
    if status != 200:
        return False, (
            f"HTTP {status}: the probe cookie was not honoured, so the page never "
            "rendered and this check could not see the image"
        )
    return True, "patched UI (the probe session renders the page, no dead end)"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(REPO / ".env"))
    parser.add_argument("--base-domain", default=None, help="override NPM_BASE_DOMAIN")
    parser.add_argument("--timeout", type=int, default=12, help="per-request timeout seconds")
    args = parser.parse_args()
    env = load_env_file(Path(args.env_file))

    base_domain = (args.base_domain or env.get("NPM_BASE_DOMAIN") or "capstone.innotel.us").strip().lstrip(".")
    signin_base = (env.get("NPM_AUTHENTIK_URL") or f"https://auth.{base_domain}").rstrip("/")

    # No route to the estate is a skip, not a list of 15 failures: a scheduled
    # run on a hosted runner lands here, and it must not page anyone.
    if not edge_reachable(base_domain, min(args.timeout, 8)):
        print(f"SKIP: no answer from https://{base_domain}/ — this runner has no route to "
              "the estate, so nothing behind the edge can be probed", file=sys.stderr)
        return 2

    mod = load_hosts_module()
    hosts = [dict(h) for h in mod.HOSTS if not h.get("optional")]

    print(f"NPM edge: https://<sub>.{base_domain} · SSO: {signin_base}\n")

    failed: list[str] = []

    # 0. Outpost health through the auth vhost (the gate's backbone).
    try:
        st, _ = fetch(f"https://auth.{base_domain}/outpost.goauthentik.io/ping", args.timeout)
        print(f"{'auth outpost ping':45} {'PASS' if st == 204 else 'FAIL'} ({st})")
        if st != 204:
            failed.append("outpost ping")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, ssl.SSLError) as e:
        print(f"{'auth outpost ping':45} FAIL ({getattr(e, 'code', e)})")
        failed.append("outpost ping")

    for h in hosts:
        sub = h["sub"]
        domain = base_domain if sub is None else f"{sub}.{base_domain}"
        gated = bool(h.get("gated"))
        verdict, note = check_host(domain, gated, signin_base, args.timeout)
        print(f"{domain:45} {verdict} ({note})")
        if verdict == "FAIL":
            failed.append(domain)

    # 2. The media prefix, through the same vhosts that serve the app. Any
    # answer MinIO itself produces is fine (a bucket listing, or an S3 error
    # document for a name it does not have), so the test is "did an S3 XML body
    # come back" rather than any particular status. What must not come back is
    # the edge's own HTML error page, which is all a forward_host that no longer
    # runs MinIO can produce.
    for h in [x for x in hosts if x["key"] in mod.MEDIA_HOST_KEYS]:
        sub = h["sub"]
        domain = base_domain if sub is None else f"{sub}.{base_domain}"
        label = f"{domain}{mod.MEDIA_PATH}/"
        try:
            status, body, _ = fetch_body(f"https://{label}", args.timeout)
            ok = "<ListBucketResult" in body or "<Error>" in body
            note = f"{status} {'MinIO' if ok else 'edge, not MinIO'}"
        except (urllib.error.URLError, OSError, ssl.SSLError) as e:
            ok, note = False, f"connect: {getattr(e, 'reason', e)}"
        print(f"{label:45} {'PASS' if ok else 'FAIL'} ({note})")
        if not ok:
            failed.append(label)

    # 3. The Cerulean sign-in entry, on every origin that serves the app. See
    #    walk_to_authorize: this is the check for the fault where signing in
    #    "does nothing" because the redirect was answered by a proxy.
    for h in [x for x in hosts if x["key"] in mod.OIDC_HOST_KEYS]:
        sub = h["sub"]
        domain = base_domain if sub is None else f"{sub}.{base_domain}"
        label = f"{domain}{mod.OIDC_PATH}/login"
        url = f"https://{label}?next=%2Fafter-sign-in"
        ok, note = walk_to_authorize(url, args.timeout)
        print(f"{label:45} {'PASS' if ok else 'FAIL'} ({note})")
        if not ok:
            failed.append(label)

    # 4. The app's own page, on the same origins (they are the ones that serve
    #    it). See probe_ui_image: the walk above passes on a stale UI image,
    #    because the edge route sends the sign-in to the API regardless — only
    #    the page itself still carries the pre-patch dead end.
    for h in [x for x in hosts if x["key"] in mod.OIDC_HOST_KEYS]:
        sub = h["sub"]
        domain = base_domain if sub is None else f"{sub}.{base_domain}"
        label = f"{domain}{UI_PAGE}"
        ok, note = probe_ui_image(domain, args.timeout)
        print(f"{label:45} {'PASS' if ok else 'FAIL'} ({note})")
        if not ok:
            failed.append(label)

    print()
    if failed:
        print(f"FAIL {len(failed)}/{len(hosts)} host(s) unhealthy: {', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"PASS all {len(hosts)} proxy hosts healthy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
