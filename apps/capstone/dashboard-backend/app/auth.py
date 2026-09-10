"""Cerulean (Authentik) OIDC session auth for the dashboard API.

Every data endpoint requires a valid dashboard session. Sessions are minted
by the authorization-code + PKCE flow against Cerulean's Authentik (the auth
& trust stack); the callback validates the user against an allowlist and sets
a short-lived httpOnly cookie (HMAC-signed, so no server-side store needed).

When OIDC is not configured (no AUTHENTIK_ISSUER_URL in env — e.g. local dev),
auth is a no-op and the API stays open, matching the previous behavior.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from fastapi import Cookie, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from .tenant_gate import cerulean_tenant, user_groups

COOKIE_NAME = "capstone_session"
SESSION_TTL = 8 * 60 * 60  # 8 hours


def oidc_enabled() -> bool:
    return bool(
        os.environ.get("AUTHENTIK_ISSUER_URL")
        and os.environ.get("AUTHENTIK_CLIENT_ID")
        and os.environ.get("AUTHENTIK_CLIENT_SECRET")
    )


def issuer_base() -> str:
    return (os.environ.get("AUTHENTIK_ISSUER_URL") or "").rstrip("/")


def redirect_uri() -> str:
    explicit = (os.environ.get("AUTHENTIK_REDIRECT_URI") or "").strip()
    if explicit:
        return explicit
    return "https://dashboard.capstone.innotel.us/api/auth/callback"


def _discovery() -> dict[str, Any]:
    url = f"{issuer_base()}/.well-known/openid-configuration"
    with urllib.request.urlopen(url, timeout=15) as resp:  # noqa: S310 - trusted issuer
        return json.loads(resp.read().decode())


def _admin_emails() -> set[str]:
    raw = os.environ.get("AUTHENTIK_ADMIN_EMAILS", "") or os.environ.get("GRIST_ADMIN_EMAIL", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


# ── session cookie (HMAC-signed) ─────────────────────────────────────────────
def _sign(data: str) -> str:
    key = (os.environ.get("AUTHENTIK_CLIENT_SECRET") or "dev-only-key").encode()
    return hmac.new(key, data.encode(), hashlib.sha256).hexdigest()


def issue_session(user: dict[str, Any]) -> str:
    payload = {
        "sub": user.get("sub", ""),
        "email": (user.get("email") or "").lower(),
        "name": user.get("name") or user.get("preferred_username") or "",
        "groups": sorted(user_groups(user)),
        "tenant": cerulean_tenant() or None,
        "exp": int(time.time()) + SESSION_TTL,
    }
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{body}.{_sign(body)}"


def read_session(cookie: str | None) -> dict[str, Any] | None:
    if not cookie or "." not in cookie:
        return None
    body, sig = cookie.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(body)):
        return None
    try:
        padded = body + "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode())
    except Exception:
        return None
    if int(payload.get("exp", 0)) < time.time():
        return None
    return payload


def require_session(session: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> dict[str, Any]:
    """FastAPI dependency: 401 unless a valid dashboard session cookie exists."""
    if not oidc_enabled():
        return {"sub": "local-dev", "email": "", "name": "Local Dev"}
    user = read_session(session)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


@dataclass
class OidcChallenge:
    state: str
    verifier: str


def authorize_url(next_path: str = "/") -> tuple[str, OidcChallenge]:
    """Build the Authentik authorize URL + PKCE challenge (state in cookie)."""
    disc = _discovery()
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    state = secrets.token_urlsafe(24)
    # `groups` scope is required so Authentik's userinfo includes the
    # user's group memberships (needed for the Cerulean tenant gate).
    params = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": os.environ["AUTHENTIK_CLIENT_ID"],
        "redirect_uri": redirect_uri(),
        "scope": "openid profile email groups",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    url = f"{disc['authorization_endpoint']}?{params}"
    return url, OidcChallenge(state=state, verifier=verifier)


def _decode_jwt_claims(token: str) -> dict[str, Any]:
    """Decode JWT payload without verification (for group fallback)."""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        padded = payload + "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(padded).decode())
    except Exception:
        return {}


def exchange_and_user(code: str, verifier: str) -> dict[str, Any]:
    """Exchange the auth code for tokens, then fetch userinfo.

    Merges `groups` from both userinfo and the id_token/access_token
    claims, because Authentik only includes groups when the `groups` scope
    is requested AND a property mapping exposes it — the JWT fallback keeps
    the tenant gate working even when userinfo is minimal.
    """
    disc = _discovery()
    token_body = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(),
        "client_id": os.environ["AUTHENTIK_CLIENT_ID"],
        "client_secret": os.environ["AUTHENTIK_CLIENT_SECRET"],
        "code_verifier": verifier,
    }).encode()
    req = urllib.request.Request(disc["token_endpoint"], data=token_body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310
            tokens = json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        raise HTTPException(status_code=502, detail=f"Token exchange failed (HTTP {err.code})") from err

    access = tokens.get("access_token")
    if not access:
        raise HTTPException(status_code=502, detail="Token exchange returned no access token")

    ureq = urllib.request.Request(disc["userinfo_endpoint"])
    ureq.add_header("Authorization", f"Bearer {access}")
    try:
        with urllib.request.urlopen(ureq, timeout=15) as resp:  # noqa: S310
            userinfo: dict[str, Any] = json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        raise HTTPException(status_code=502, detail=f"Userinfo failed (HTTP {err.code})") from err

    # Fallback: extract groups from the JWTs when userinfo omits them.
    if not userinfo.get("groups") and not userinfo.get("group"):
        for tok in (tokens.get("id_token"), access):
            if tok:
                claims = _decode_jwt_claims(tok)
                if claims.get("groups"):
                    userinfo["groups"] = claims["groups"]
                    break
                if claims.get("group"):
                    userinfo["groups"] = claims["group"]
                    break
    return userinfo


def is_admin_user(user: dict[str, Any]) -> bool:
    email = (user.get("email") or "").lower()
    allowlist = _admin_emails()
    if allowlist:
        return bool(email) and email in allowlist
    # No explicit allowlist: Authentik superusers can always get in.
    return bool(user.get("is_superuser")) or bool(email)


def login_redirect() -> RedirectResponse:
    url, _ = authorize_url()
    resp = RedirectResponse(url, status_code=302)
    return resp