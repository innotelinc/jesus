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
