#!/usr/bin/env python3
"""npm_smoke_test.py — verify every Capstone NPM proxy host through the public edge.

Checks, per https://<sub>.<NPM_BASE_DOMAIN>/ (STRICT TLS — no cert skipping):

  • DNS resolves
  • TLS handshake + certificate validity (system trust store)
  • UI hosts (app, pbx, n8n, grist, signoz, workflow) return 302 → the
    Cerulean Authentik outpost sign-in (forward-auth gate active)
  • open hosts (api, dashboard/admin, auth, voice, apex) respond WITHOUT
    being gated (200/302-to-auth-flow/404/307 are all fine — they serve
    machine traffic, the OIDC redirect target, the IdP, or WS signaling)
  • the embedded outpost is reachable through each gated vhost
    (/outpost.goauthentik.io/ping → 204)

Exit 0 only when every host passes; exit 1 otherwise (CI-friendly).

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
from urllib.parse import urlparse

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


def is_sso_redirect(location: str | None, signin_base: str) -> bool:
    if not location:
        return False
    loc_host = urlparse(location).netloc
    auth_host = urlparse(signin_base).netloc or urlparse(signin_base).path
    return "outpost.goauthentik.io/start" in location and (
        not auth_host or loc_host == auth_host
    )


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
            return "PASS", "SSO redirect + outpost ping 204"
        if status < 500:
            return "FAIL", f"NOT gated — served {status} without SSO"
        return "FAIL", f"upstream error {status}"
    # Open host: no SSO bounce, any real HTTP answer is fine.
    if location and "outpost.goauthentik.io/start" in location:
        return "FAIL", "SSO-gated but expected open"
    if status < 500:
        return "PASS", f"open ({status})"
    return "FAIL", f"upstream error {status}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(REPO / ".env"))
    parser.add_argument("--base-domain", default=None, help="override NPM_BASE_DOMAIN")
    parser.add_argument("--timeout", type=int, default=12, help="per-request timeout seconds")
    args = parser.parse_args()
    env = load_env_file(Path(args.env_file))

    base_domain = (args.base_domain or env.get("NPM_BASE_DOMAIN") or "capstone.innotel.us").strip().lstrip(".")
    signin_base = (env.get("NPM_AUTHENTIK_URL") or f"https://auth.{base_domain}").rstrip("/")

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
        gated = h.get("forward_auth") is not False
        verdict, note = check_host(domain, gated, signin_base, args.timeout)
        print(f"{domain:45} {verdict} ({note})")
        if verdict == "FAIL":
            failed.append(domain)

    print()
    if failed:
        print(f"FAIL {len(failed)}/{len(hosts)} host(s) unhealthy: {', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"PASS all {len(hosts)} proxy hosts healthy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
