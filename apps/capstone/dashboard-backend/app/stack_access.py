"""Per-stack SSO / access inventory from the Cerulean Authentik instance.

Answers the operator question the Control Center's Health page asks: **which
stack can which user reach, and is that actually enforced?**

Authentik semantics this leans on (all verified live against 2025.6.3):

* ``Application.group`` is Authentik's own "which product does this app belong
  to" field. ``scripts/authentik_bootstrap.py`` sets it to the stack name, so
  the stack list here is derived from the live data rather than a second
  hard-coded registry that could drift.
* An application with **no policy binding** is reachable by every authenticated
  user. So "enforced" = has a provider (there is a login flow to gate) AND
  carries a group policy binding.
* ``/api/v3/core/applications/?for_user=<pk>`` returns exactly the applications
  a user can reach, which is one call per user instead of one per
  (user, application) pair.
* ``superuser_full_list=true`` is required when *listing* applications: the
  search endpoint filters by the calling token's own access, so even an admin
  token otherwise sees only its own apps.

Dependency-free apart from the stdlib (like ``app/hosts.py``), so it unit-tests
without FastAPI or the network.
"""

from __future__ import annotations

import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# Human-facing user types. Everything else is a machine identity, and those are
# the ones that must keep access even when a stack is locked down.
MACHINE_USER_TYPES = {"internal", "service_account", "internal_service_account"}

DEFAULT_TIMEOUT = 12
CACHE_TTL_SECONDS = 60


def _env(name: str, explicit: str | None = None) -> str:
    return (explicit if explicit is not None else os.environ.get(name, "") or "").strip()


def base_url(explicit: str | None = None) -> str:
    """Authentik base URL: explicit → ``AUTHENTIK_API_URL`` → ``AUTHENTIK_PUBLIC_URL``.

    ``AUTHENTIK_API_URL`` exists so a host can point the API at a direct
    internal address (``http://<idp-host>:9000``) while browsers use the public
    ``auth.<domain>`` vhost.
    """
    for candidate in (explicit, _env("AUTHENTIK_API_URL"), _env("AUTHENTIK_PUBLIC_URL")):
        if candidate:
            return candidate.rstrip("/")
    domain = _env("NPM_BASE_DOMAIN")
    return f"https://auth.{domain}" if domain else ""


def token(explicit: str | None = None) -> str:
    return _env("AUTHENTIK_TOKEN", explicit)


def configured(explicit_base: str | None = None, explicit_token: str | None = None) -> bool:
    return bool(base_url(explicit_base) and token(explicit_token))


def _ssl_context() -> ssl.SSLContext:
    insecure = _env("AUTHENTIK_API_INSECURE").lower() in {"1", "true", "yes", "on"}
    if not insecure:
        return ssl.create_default_context()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _get(url: str, api_token: str, timeout: int = DEFAULT_TIMEOUT) -> tuple[int, object]:
    """GET a JSON document. Never raises — returns ``(status, None)`` on failure."""
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {api_token}", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, OSError, ValueError):
        return 0, None


def _list_all(root: str, api_token: str, path: str, **extra: str) -> list[dict]:
    """Every page of a list endpoint (Authentik caps page_size at 100)."""
    out: list[dict] = []
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        query = "".join(f"&{k}={urllib.parse.quote(str(v))}" for k, v in extra.items())
        status, data = _get(f"{root}{path}{sep}page_size=100&page={page}{query}", api_token)
        if not isinstance(data, dict):
            break
        out.extend(data.get("results") or [])
        if not (data.get("pagination") or {}).get("next"):
            break
        page += 1
    return out


def _is_gated(bindings: list[dict]) -> set:
    """Application pks that carry a group policy binding (i.e. are restricted)."""
    return {b.get("target") for b in bindings if b.get("target") and b.get("group")}


def build_access_status(
    explicit_base: str | None = None,
    explicit_token: str | None = None,
    *,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict:
    """Return the stack/user access inventory. Never raises.

    ``ok`` is False (with ``error``) when the IdP is unreachable so the Health
    page degrades to a message instead of a 500.
    """
    root = base_url(explicit_base)
    api_token = token(explicit_token)
    result: dict = {
        "configured": bool(root and api_token),
        "ok": False,
        "baseUrl": root,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "error": None,
        "summary": {"stacks": 0, "users": 0, "applications": 0, "enforced": 0, "ungated": 0},
        "stacks": [],
        "users": [],
        "ungated": [],
        "tilesOnly": [],
    }
    if not root:
        result["error"] = "AUTHENTIK_API_URL / AUTHENTIK_PUBLIC_URL not set"
        return result
    if not api_token:
        result["error"] = "AUTHENTIK_TOKEN not set"
        return result

    cached = _cache_get(root)
    if cached is not None:
        return cached

    users = _list_all(root, api_token, "/api/v3/core/users/", include_groups="true")
    state, _probe = _get(
        f"{root}/api/v3/core/users/?page_size=1", api_token, timeout=timeout
    )
    if not users:
        result["error"] = f"Authentik did not return a user list (HTTP {state or 'unreachable'})"
        return result

    groups = _list_all(root, api_token, "/api/v3/core/groups/")
    apps = _list_all(root, api_token, "/api/v3/core/applications/", superuser_full_list="true")
    bindings = _list_all(root, api_token, "/api/v3/policies/bindings/")

    usernames = {u["pk"]: u.get("username", "") for u in users}
    gated_pks = _is_gated(bindings)

    # Stack membership comes from the stack group itself (Application.group
    # carries the stack name, the group object is what enforcement binds).
    group_members = {g.get("name", ""): list(g.get("users") or []) for g in groups}

    stacks: dict[str, dict] = {}
    tiles_only: list[str] = []
    ungated: list[dict] = []
    for app in apps:
        stack_name = app.get("group") or "Ungrouped"
        entry = stacks.setdefault(
            stack_name, {"name": stack_name, "applications": 0, "enforced": 0, "members": []}
        )
        has_provider = bool(app.get("provider"))
        is_gated = app["pk"] in gated_pks
        if not has_provider:
            # A plain portal tile has no login flow to gate.
            tiles_only.append(app.get("slug", ""))
            continue
        entry["applications"] += 1
        if is_gated:
            entry["enforced"] += 1
        else:
            ungated.append(
                {"slug": app.get("slug", ""), "name": app.get("name", ""), "stack": stack_name}
            )

    # Reachability: one call per user, not one per (user, application).
    # Tiles-only apps are skipped — they have no provider, so everyone can
    # "reach" them and counting them would claim access that is not really
    # granted (it is the absence of a gate, surfaced in ``tilesOnly``).
    gated_slugs = {a.get("slug") for a in apps if a.get("provider")}
    users_out: list[dict] = []
    for user in sorted(users, key=lambda u: u.get("username", "")):
        pk = user["pk"]
        reachable = _list_all(root, api_token, "/api/v3/core/applications/", for_user=str(pk))
        reachable = [a for a in reachable if a.get("slug") in gated_slugs]
        reachable_stacks = sorted({a.get("group") or "Ungrouped" for a in reachable})
        users_out.append(
            {
                "username": user.get("username", ""),
                "type": user.get("type", ""),
                "superuser": bool(user.get("is_superuser")),
                "active": bool(user.get("is_active")),
                "machine": (user.get("type") or "") in MACHINE_USER_TYPES,
                "stacks": reachable_stacks,
                "applications": len(reachable),
            }
        )

    for entry in stacks.values():
        entry["members"] = sorted(
            usernames.get(pk, str(pk)) for pk in group_members.get(entry["name"], [])
        )

    result.update(
        ok=True,
        stacks=sorted(stacks.values(), key=lambda s: s["name"].lower()),
        users=users_out,
        ungated=sorted(ungated, key=lambda a: a["slug"]),
        tilesOnly=sorted(s for s in tiles_only if s),
        summary={
            "stacks": len(stacks),
            "users": len(users_out),
            "applications": sum(1 for a in apps if a.get("provider")),
            "enforced": sum(e["enforced"] for e in stacks.values()),
            "ungated": len(ungated),
        },
    )
    _cache_put(root, result)
    return result


# ---------------------------------------------------------------- tiny cache
# The Health page polls; 60s of TTL keeps the IdP from being hit on every
# refresh while still reflecting an enforcement run within a minute.
_CACHE: dict[str, tuple[float, dict]] = {}


def _cache_get(root: str) -> dict | None:
    hit = _CACHE.get(root)
    if hit and (time.monotonic() - hit[0]) < CACHE_TTL_SECONDS:
        return hit[1]
    return None


def _cache_put(root: str, value: dict) -> None:
    _CACHE[root] = (time.monotonic(), value)


def clear_cache() -> None:
    _CACHE.clear()
