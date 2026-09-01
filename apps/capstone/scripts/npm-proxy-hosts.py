#!/usr/bin/env python3
"""npm_proxy_hosts.py — keep Nginx Proxy Manager proxy hosts in sync with the stack.

Idempotent; talks to the NPM REST API only (no UI clicks). Safe to re-run:
every step GETs first and only writes when state differs.

What it does:

  1. auth      — login with NPM_ADMIN_EMAIL/NPM_ADMIN_PASSWORD (POST /api/tokens),
                 or use a persistent NPM_API_TOKEN (NPM → Access → API Tokens)
  2. sync      — for every service in the README "NPM proxy hosts" table,
                 create-or-update its proxy host under NPM_BASE_DOMAIN
                 (forward host/port from the compose port map)
  3. ssl       — when NPM_LETSENCRYPT_EMAIL is set, create-or-reuse a Let's
                 Encrypt certificate per host and force HTTPS. With
                 --wildcard + DNS provider credentials (NPM_DNS_PROVIDER /
                 NPM_DNS_PROVIDER_CREDENTIALS), ONE wildcard certificate
                 covering "*.base + base" is issued via DNS-01 and
                 auto-attached to every proxy host instead.

Optional services (nocodb, portal) are skipped unless listed in
--include-optional / NPM_INCLUDE_OPTIONAL — they only exist when their
compose profile is enabled. Note: a later run WITHOUT the include flag treats
those hosts as stale and prunes them — pass --no-prune to keep them.

The `ws` host forwards to Asterisk's HTTP-TLS listener (https://<host>:8089)
with WebSocket support ON, which is what the in-browser Softphone connects to
(wss://ws.<domain>/ws). If your NPM validates upstream certificates and balks
at the PBX's self-signed integration cert, use --ws-scheme http --ws-port 8088
(plain-ws upstream, same /ws signaling handler).

Environment variables (real env wins, then the capstone .env, then defaults):

  NPM_API_URL             NPM base URL            (http://127.0.0.1:81)
  NPM_ADMIN_EMAIL         NPM admin login email   (required unless NPM_API_TOKEN)
  NPM_ADMIN_PASSWORD      NPM admin login password(required unless NPM_API_TOKEN)
  NPM_API_TOKEN           persistent NPM API token (optional; skips login)
  NPM_BASE_DOMAIN         base domain, e.g. capstone.innotel.us  (required)
  NPM_UPSTREAM_HOST       Docker host IP NPM forwards to
                          (default: PJSIP_MEDIA_ADDRESS from .env)
  NPM_LETSENCRYPT_EMAIL   email for Let's Encrypt certs
                          (default: GRIST_ADMIN_EMAIL; empty → hosts without SSL)
  NPM_INCLUDE_OPTIONAL    comma list of optional hosts: nocodb,portal (or "all")
  NPM_WILDCARD_CERT       1/true → issue ONE wildcard cert (*.base + base) via
                          DNS-01 and attach it to every host (or --wildcard)
  NPM_DNS_PROVIDER        DNS provider slug for the wildcard cert, e.g.
                          cloudflare, route53, digitalocean, dnsimple, duckdns
                          (must be saved as a credential in NPM)
  NPM_DNS_PROVIDER_CREDENTIALS  NPM credential id for the DNS provider
                          (NPM → Credentials → the id in the row's URL/DB)

Usage (from the repo root):

  python3 scripts/npm-proxy-hosts.py                  # create/update + prune
  python3 scripts/npm-proxy-hosts.py --check          # verify only, exit 1 if out of sync
  python3 scripts/npm-proxy-hosts.py --no-prune       # never delete hosts
  python3 scripts/npm-proxy-hosts.py --no-ssl         # skip certificates/HTTPS
  python3 scripts/npm-proxy-hosts.py --include-optional nocodb,portal
  python3 scripts/npm-proxy-hosts.py --ws-scheme http --ws-port 8088
  python3 scripts/npm-proxy-hosts.py --wildcard \
      --dns-provider cloudflare --dns-credentials 3   # one wildcard cert for all hosts
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
DEFAULT_API_URL = "http://127.0.0.1:81"

# The proxy-host map — one entry per README "NPM proxy hosts" row.
#   key       compose service label (used for --include-optional + pruning)
#   sub       subdomain under NPM_BASE_DOMAIN (None → the apex domain)
#   scheme    upstream scheme NPM forwards with (http/https)
#   port      upstream host port
#   websocket enable allow_websocket_upgrade (n8n/SigNoz/dograh-ui UIs + ws)
#   name      human label for PASS/FAIL output
#   optional  only synced when explicitly included (compose profile services)
HOSTS: list[dict[str, Any]] = [
    {"key": "apex",      "sub": None,        "scheme": "http",  "port": 8000,  "websocket": False, "name": "Dograh API (apex origin)"},
    {"key": "dograh",    "sub": "dograh",    "scheme": "http",  "port": 8000,  "websocket": False, "name": "Dograh API"},
    {"key": "dograh-ui", "sub": "dograh-ui", "scheme": "http",  "port": 3010,  "websocket": True,  "name": "Dograh UI"},
    {"key": "pbx",       "sub": "pbx",       "scheme": "http",  "port": 80,    "websocket": False, "name": "FreePBX"},
    {"key": "n8n",       "sub": "n8n",       "scheme": "http",  "port": 5678,  "websocket": True,  "name": "n8n"},
    {"key": "grist",     "sub": "grist",     "scheme": "http",  "port": 8484,  "websocket": False, "name": "Grist"},
    {"key": "omniroute", "sub": "omniroute", "scheme": "http",  "port": 20128, "websocket": False, "name": "OmniRoute"},
    {"key": "signoz",    "sub": "signoz",    "scheme": "http",  "port": 3301,  "websocket": True,  "name": "SigNoz"},
    {"key": "workflow",  "sub": "workflow",  "scheme": "http",  "port": 8090,  "websocket": False, "name": "Workflow Studio"},
    {"key": "dashboard", "sub": "dashboard", "scheme": "http",  "port": 8096,  "websocket": False, "name": "Control Center dashboard"},
    {"key": "ws",        "sub": "ws",        "scheme": "https", "port": 8089,  "websocket": True,  "name": "WebRTC WSS signaling"},
    {"key": "nocodb",    "sub": "nocodb",    "scheme": "http",  "port": 8080,  "websocket": False, "name": "NocoDB",     "optional": True},
    {"key": "portal",    "sub": "portal",    "scheme": "http",  "port": 3000,  "websocket": False, "name": "PBX Portal", "optional": True},
]


class NpmError(Exception):
    pass


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


def cfg(args: argparse.Namespace, key: str, default: str = "") -> str:
    """Resolve a setting: real env first, then the .env file, then default."""
    return os.environ.get(key) or args.env.get(key) or default


class NpmApi:
    """Minimal Nginx Proxy Manager REST API client (stdlib only)."""

    def __init__(self, base_url: str, token: str = ""):
        self.base = base_url.rstrip("/")
        self.token = token

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = (e.read() or b"").decode(errors="replace")[:300]
            raise NpmError(f"{method} {path} → HTTP {e.code}: {detail}") from e

    def login(self, identity: str, secret: str) -> None:
        res = self._call("POST", "/api/tokens", {"identity": identity, "secret": secret})
        token = (res or {}).get("token") or (res or {}).get("access_token") or ""
        if not token:
            raise NpmError("login response contained no token")
        self.token = token

    def proxy_hosts(self) -> list[dict]:
        return self._call("GET", "/api/nginx/proxy-hosts") or []

    def create_proxy_host(self, payload: dict) -> dict:
        return self._call("POST", "/api/nginx/proxy-hosts", payload)

    def update_proxy_host(self, pid: int, payload: dict) -> dict:
        return self._call("PUT", f"/api/nginx/proxy-hosts/{pid}", payload)

    def delete_proxy_host(self, pid: int) -> None:
        self._call("DELETE", f"/api/nginx/proxy-hosts/{pid}")

    def certificates(self) -> list[dict]:
        return self._call("GET", "/api/nginx/certificates") or []

    def create_certificate(self, payload: dict) -> dict:
        return self._call("POST", "/api/nginx/certificates", payload)


def build_payload(domain: str, h: dict, forward_host: str,
                  cert_id: int | None, ssl: bool) -> dict:
    return {
        "domain_names": [domain],
        "forward_scheme": h["scheme"],
        "forward_host": forward_host,
        "forward_port": h["port"],
        "certificate_id": cert_id if ssl else None,
        "ssl_forced": ssl,
        "block_exploits": True,
        "caching_enabled": False,
        "allow_websocket_upgrade": h["websocket"],
        "access_list_id": "0",
        "advanced_config": "",
        "meta": {"letsencrypt_agree": False, "dns_challenge": False},
        "locations": [],
        "hsts_enabled": False,
        "hsts_subdomains": False,
        "http2_support": True,
        "enabled": True,
    }


def ensure_cert(api: NpmApi, domains: list[str], le_email: str,
                dns_provider: str, dns_credentials: str,
                check: bool, certs_by_domain: dict[str, int],
                failed: list[str]) -> int | None:
    """Return the cert id covering `domains`, creating it when missing.

    With DNS provider credentials set, issues the cert via DNS-01 (required
    for wildcard names); otherwise uses the default HTTP-01 challenge. In
    --check mode never writes: reports the missing cert as a FAIL instead.
    """
    for d in domains:
        cid = certs_by_domain.get(d.lower())
        if cid is not None:
            return cid
    label = ", ".join(domains)
    if check:
        print(f"FAIL no Let's Encrypt certificate for {label}")
        failed.append(domains[0])
        return None
    meta = {"letsencrypt_email": le_email, "letsencrypt_agree": True, "dns_challenge": False}
    if dns_provider and dns_credentials:
        meta.update({
            "dns_challenge": True,
            "dns_provider": dns_provider,
            "dns_provider_credentials": dns_credentials,
        })
    try:
        cert = api.create_certificate({
            "provider": "letsencrypt",
            "domain_names": domains,
            "meta": meta,
        })
        cid = cert.get("id")
        for d in domains:
            certs_by_domain[d.lower()] = cid
        print(f"PASS requested Let's Encrypt certificate for {label} (id {cid})")
        return cid
    except (NpmError, urllib.error.URLError, OSError) as e:
        print(f"FAIL could not create certificate for {label}: {e}", file=sys.stderr)
        failed.append(domains[0])
        return None


def desired(domain: str, h: dict, forward_host: str,
            cert_id: int | None, ssl: bool) -> dict:
    """The field values we own, used to diff an existing host against the map."""
    return {
        "domain_names": [domain],
        "forward_scheme": h["scheme"],
        "forward_host": forward_host,
        "forward_port": h["port"],
        "allow_websocket_upgrade": h["websocket"],
        "ssl_forced": ssl,
        "certificate_id": cert_id if cert_id else None,  # NPM wants null, not 0
        "enabled": True,
    }


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default=None, help="NPM base URL (env NPM_API_URL)")
    parser.add_argument("--email", default=None, help="NPM admin email (env NPM_ADMIN_EMAIL)")
    parser.add_argument("--password", default=None, help="NPM admin password (env NPM_ADMIN_PASSWORD)")
    parser.add_argument("--api-token", default=None, help="persistent NPM API token (env NPM_API_TOKEN)")
    parser.add_argument("--base-domain", default=None, help="base domain, e.g. capstone.innotel.us (env NPM_BASE_DOMAIN)")
    parser.add_argument("--upstream-host", default=None, help="Docker host IP NPM forwards to (env NPM_UPSTREAM_HOST)")
    parser.add_argument("--letsencrypt-email", default=None, help="email for Let's Encrypt certs (env NPM_LETSENCRYPT_EMAIL)")
    parser.add_argument("--wildcard", action="store_true",
                        help="issue ONE wildcard cert (*.base + base) via DNS-01 and attach it to every host (env NPM_WILDCARD_CERT)")
    parser.add_argument("--dns-provider", default=None,
                        help="DNS provider slug for the wildcard cert, e.g. cloudflare (env NPM_DNS_PROVIDER)")
    parser.add_argument("--dns-credentials", default=None,
                        help="NPM credential id for the DNS provider (env NPM_DNS_PROVIDER_CREDENTIALS)")
    parser.add_argument("--include-optional", default=None, help="comma list of optional hosts: nocodb,portal (or 'all')")
    parser.add_argument("--ws-scheme", choices=["http", "https"], default=None,
                        help="upstream scheme for the ws.<domain> host (default https)")
    parser.add_argument("--ws-port", type=int, default=None,
                        help="upstream port for the ws.<domain> host (default 8089; use 8088 with --ws-scheme http)")
    parser.add_argument("--no-ssl", action="store_true", help="skip certificates and HTTPS forcing")
    parser.add_argument("--no-prune", action="store_true", help="never delete NPM hosts")
    parser.add_argument("--check", action="store_true", help="verify only — no writes, exit 1 if out of sync")
    parser.add_argument("--env-file", default=str(repo / ".env"), help="capstone .env path")
    args = parser.parse_args()
    args.env = load_env_file(Path(args.env_file))

    api_url = args.api_url or cfg(args, "NPM_API_URL", DEFAULT_API_URL)
    base_domain = (args.base_domain or cfg(args, "NPM_BASE_DOMAIN", "")).strip().lstrip(".")
    upstream = args.upstream_host or cfg(args, "NPM_UPSTREAM_HOST", "") or cfg(args, "PJSIP_MEDIA_ADDRESS", "")
    le_email = args.letsencrypt_email or cfg(args, "NPM_LETSENCRYPT_EMAIL", "") or cfg(args, "GRIST_ADMIN_EMAIL", "")
    include_raw = (args.include_optional or cfg(args, "NPM_INCLUDE_OPTIONAL", "")).lower()

    if not base_domain:
        print("FAIL NPM_BASE_DOMAIN is empty — set it in .env (e.g. capstone.innotel.us)", file=sys.stderr)
        return 1
    if not upstream:
        print("FAIL NPM_UPSTREAM_HOST (or PJSIP_MEDIA_ADDRESS) is empty — set the Docker host IP in .env", file=sys.stderr)
        return 1

    optional = {s.strip() for s in include_raw.split(",") if s.strip()}
    if "all" in optional:
        optional = {"nocodb", "portal"}

    hosts = [dict(h) for h in HOSTS]
    if args.ws_scheme is not None or args.ws_port is not None:
        for h in hosts:
            if h["key"] == "ws":
                if args.ws_scheme is not None:
                    h["scheme"] = args.ws_scheme
                if args.ws_port is not None:
                    h["port"] = args.ws_port
    if optional:
        hosts = [h for h in hosts if not h.get("optional") or h["key"] in optional]
    else:
        hosts = [h for h in hosts if not h.get("optional")]

    # Auth
    api = NpmApi(api_url)
    token = args.api_token or cfg(args, "NPM_API_TOKEN", "")
    if token:
        api.token = token
    else:
        identity = args.email or cfg(args, "NPM_ADMIN_EMAIL", "")
        secret = args.password or cfg(args, "NPM_ADMIN_PASSWORD", "")
        if not identity or not secret:
            print("FAIL NPM_ADMIN_EMAIL/NPM_ADMIN_PASSWORD (or NPM_API_TOKEN) required", file=sys.stderr)
            return 1
        try:
            api.login(identity, secret)
        except (NpmError, urllib.error.URLError, OSError) as e:
            print(f"FAIL NPM login failed ({api_url}): {e}", file=sys.stderr)
            return 1
    print("PASS authenticated with Nginx Proxy Manager")

    try:
        existing_hosts = api.proxy_hosts()
    except (NpmError, urllib.error.URLError, OSError) as e:
        print(f"FAIL could not list NPM proxy hosts: {e}", file=sys.stderr)
        return 1

    # Domain → existing host
    by_domain: dict[str, dict] = {}
    for eh in existing_hosts:
        for d in eh.get("domain_names") or []:
            by_domain.setdefault(d.lower(), eh)

    # Certificates: reuse a cert that already covers our domain.
    certs_by_domain: dict[str, int] = {}
    try:
        for c in api.certificates():
            for d in c.get("domain_names") or []:
                certs_by_domain.setdefault(d.lower(), c["id"])
    except (NpmError, urllib.error.URLError, OSError) as e:
        print(f"WARN could not list NPM certificates ({e}) — continuing without SSL")

    ssl = not args.no_ssl and bool(le_email)
    if not ssl and not args.no_ssl:
        print("WARN NPM_LETSENCRYPT_EMAIL not set — creating hosts without SSL (pass --no-ssl to silence)")

    # Wildcard mode: ONE cert covering "*.base + base" issued via DNS-01 and
    # auto-attached to every host. Requires DNS provider credentials saved in
    # NPM — without them we fall back to the per-host HTTP-01 certs below.
    wildcard = args.wildcard or cfg(args, "NPM_WILDCARD_CERT", "").lower() in {"1", "true", "yes", "on"}
    dns_provider = args.dns_provider or cfg(args, "NPM_DNS_PROVIDER", "")
    dns_credentials = args.dns_credentials or cfg(args, "NPM_DNS_PROVIDER_CREDENTIALS", "")
    if wildcard and ssl and not (dns_provider and dns_credentials):
        print("WARN wildcard requested but NPM_DNS_PROVIDER / NPM_DNS_PROVIDER_CREDENTIALS unset — "
              "falling back to per-host HTTP-01 certificates", file=sys.stderr)
        wildcard = False
    if wildcard and not ssl:
        wildcard = False

    created = updated = ok = pruned = 0
    failed: list[str] = []
    managed_domains: set[str] = set()

    # Issue the single wildcard cert up front; every host then reuses it.
    if wildcard:
        wc_id = ensure_cert(api, [f"*.{base_domain}", base_domain], le_email,
                            dns_provider, dns_credentials, args.check,
                            certs_by_domain, failed)
        if wc_id is None:
            if args.check:
                print("FAIL wildcard certificate missing — proxy hosts out of sync", file=sys.stderr)
                return 1
            print("WARN wildcard certificate could not be issued — continuing per host", file=sys.stderr)

    for h in hosts:
        domain = base_domain if h["sub"] is None else f"{h['sub']}.{base_domain}"
        managed_domains.add(domain)
        label = h["name"]
        existing = by_domain.get(domain.lower())

        # Ensure a certificate for this domain (reuses the wildcard cert when
        # it covers the name).
        cert_id = None
        if ssl:
            cert_id = ensure_cert(api, [domain], le_email, dns_provider, dns_credentials,
                                  args.check, certs_by_domain, failed)
            if cert_id is None:
                continue

        want = desired(domain, h, upstream, cert_id, ssl)
        if existing is None:
            if args.check:
                print(f"FAIL {label} — proxy host {domain} missing")
                failed.append(domain)
                continue
            try:
                api.create_proxy_host(build_payload(domain, h, upstream, cert_id, ssl))
                created += 1
                print(f"PASS {label} — created {domain} → {h['scheme']}://{upstream}:{h['port']}")
            except (NpmError, urllib.error.URLError, OSError) as e:
                print(f"FAIL {label} — could not create {domain}: {e}", file=sys.stderr)
                failed.append(domain)
            continue

        # Compare only the fields we manage (certificate_id normalised None/0).
        diffs: list[str] = []
        for k, v in want.items():
            cur = existing.get(k)
            if k == "certificate_id":
                cur, v = int(cur or 0), int(v or 0)
            elif k == "domain_names":
                cur, v = sorted(cur or []), sorted(v)
            if cur != v:
                diffs.append(k)

        if not diffs:
            ok += 1
            print(f"PASS {label} — {domain} already correct")
            continue

        if args.check:
            print(f"FAIL {label} — {domain} out of date ({', '.join(diffs)})")
            failed.append(domain)
            continue
        try:
            payload = dict(existing)
            payload.update(want)
            api.update_proxy_host(existing["id"], payload)
            updated += 1
            print(f"PASS {label} — updated {domain} ({', '.join(diffs)})")
        except (NpmError, urllib.error.URLError, OSError) as e:
            print(f"FAIL {label} — could not update {domain}: {e}", file=sys.stderr)
            failed.append(domain)

    # Prune: hosts under our base domain that are no longer in the map.
    if not args.no_prune:
        scope_suffix = f".{base_domain}"
        for eh in existing_hosts:
            doms = eh.get("domain_names") or []
            in_scope = any(d.lower() == base_domain or d.lower().endswith(scope_suffix) for d in doms)
            if not in_scope:
                continue
            if any(d.lower() in managed_domains for d in doms):
                continue
            if args.check:
                print(f"FAIL stale NPM host would be pruned: {', '.join(doms)}")
                failed.append(doms[0])
                continue
            try:
                api.delete_proxy_host(eh["id"])
                pruned += 1
                print(f"PASS pruned stale NPM host {', '.join(doms)}")
            except (NpmError, urllib.error.URLError, OSError) as e:
                print(f"FAIL could not prune {', '.join(doms)}: {e}", file=sys.stderr)
                failed.append(doms[0])

    if args.check:
        if failed:
            print(f"FAIL {len(failed)} host(s) out of sync", file=sys.stderr)
            return 1
        print(f"PASS all {len(hosts)} proxy hosts in sync")
        return 0

    print(f"PASS sync complete — created {created}, updated {updated}, unchanged {ok}, pruned {pruned}, failed {len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
