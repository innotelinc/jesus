"""Request-aware host resolution for browser-facing endpoints.

The aggregator serves a browser that may reach it over a LAN IP or through the
reverse proxy's public hostname. Endpoints that hand URLs back to that browser
— ``/turnconfig`` for the softphone's STUN/TURN/WSS configuration — must use
the address the browser actually used, not a host guessed from
``BACKEND_API_ENDPOINT`` / ``NPM_BASE_DOMAIN``: a private LAN IP in a STUN URL
is unreachable from a remote client, so ICE never gets a server-reflexive
candidate.

Dependency-free like ``app/agents.py`` / ``app/interviews.py`` so it unit-tests
without FastAPI or the stack.
"""

from __future__ import annotations

# The Control Center's own NPM subdomain (main.py's NPM_SUBDOMAINS reuses this)
# and the aggregator's OIDC callback path (main.py's ``/auth/callback``, reached
# by the SPA at ``/api/auth/callback``).
#
# ``dashboard`` is what the Authentik application "Capstone Dashboard"
# (client_id ``capstone-dashboard``) has registered — its launch URL and its
# ONLY redirect_uri. ``admin.<domain>`` proxies to the same container, but the
# OIDC client is bound to this name, so it must stay the derived default.
DASHBOARD_SUBDOMAIN = "dashboard"
CALLBACK_PATH = "/api/auth/callback"


def split_host(value: str) -> str:
    """Bare hostname from a Host / X-Forwarded-Host header value.

    Strips the port and any proxy chain (``a.example, b.internal``), and
    unwraps IPv6 literals (``[::1]:8096`` -> ``::1``).
    """
    first = (value or "").split(",")[0].strip()
    if not first:
        return ""
    if first.startswith("["):
        return first[1:].split("]")[0]
    return first.split(":")[0]


def is_https(x_forwarded_proto: str, scheme: str = "") -> bool:
    """True when the browser's connection to the edge was HTTPS.

    The proxy's ``X-Forwarded-Proto`` wins; the container's own scheme is
    plain HTTP, so it is only a fallback for direct (non-proxied) calls.
    """
    proto = (x_forwarded_proto or "").split(",")[0].strip().lower()
    if not proto:
        proto = (scheme or "").strip().lower()
    return proto == "https"


def browser_host(x_forwarded_host: str, host: str, fallback: str) -> str:
    """Host the browser reached us on, else ``fallback``."""
    return split_host(x_forwarded_host) or split_host(host) or fallback


def _bare_host(value: str) -> str:
    """Host from a public URL or bare host (scheme, port and path stripped)."""
    first = (value or "").split(",")[0].strip()
    if "//" in first:
        first = first.split("//", 1)[1]
    return split_host(first.split("/", 1)[0])


def callback_url(explicit: str, legacy: str, npm_domain: str, dashboard_host: str) -> str:
    """OIDC ``redirect_uri`` the Control Center sends — and Authentik must allow.

    Resolution order:

    1. ``explicit`` (``DASHBOARD_AUTHENTIK_REDIRECT_URI``) — this app's own var.
    2. ``legacy`` (``AUTHENTIK_REDIRECT_URI``) — honoured **only** when it already
       points at this app's callback. dograh shares that variable for
       ``/api/v1/auth/oidc/callback``; adopting its value hands the post-login
       browser to the voice app instead of the dashboard, so it is ignored.
    3. ``https://<sub>.<npm_domain>`` — the canonical Control Center host.
    4. ``<scheme>://<dashboard_host>`` — direct/LAN run, no reverse proxy.

    """
    if explicit:
        return explicit
    if legacy and legacy.split("?")[0].split("#")[0].rstrip("/").endswith(CALLBACK_PATH):
        return legacy
    domain = (npm_domain or "").strip().lower().lstrip(".")
    if domain:
        return f"https://{DASHBOARD_SUBDOMAIN}.{domain}{CALLBACK_PATH}"
    host = _bare_host(dashboard_host)
    if host:
        scheme = "https" if (dashboard_host or "").strip().lower().startswith("https") else "http"
        return f"{scheme}://{host}{CALLBACK_PATH}"
    return ""


def wss_endpoint(host: str, npm_domain: str, subdomain: str = "voice") -> str:
    """WSS signaling endpoint to advertise to the softphone.

    ``host`` is the browser's own host and must only be set for an HTTPS page:
    the dashboard's nginx serves ``/ws`` on its origin (forwarding to the PBX's
    WSS listener), so the browser then only ever sees the certificate the outer
    proxy issued for that host. Without a usable HTTPS host we fall back to the
    configured ``<subdomain>.<npm_domain>`` proxy host, then to "" (the client
    keeps its own page-origin / direct-PBX defaults).
    """
    if host:
        return f"wss://{host}/ws"
    if npm_domain:
        return f"wss://{subdomain}.{npm_domain}/ws"
    return ""
