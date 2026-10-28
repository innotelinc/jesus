"""Cerulean tenant gate — which Authentik groups may use this dashboard.

Kept dependency-free (no FastAPI, no OIDC client, no network) so the matching
rules can be unit-tested in isolation. ``auth.py`` layers the OIDC/session
plumbing on top and feeds the decoded userinfo (or session payload) in here.
"""

from __future__ import annotations

import os
import re
from typing import Any


def cerulean_tenant() -> str:
    """Slug of the tenant this dashboard serves ('' disables the gate)."""
    return (os.environ.get("CERULEAN_TENANT") or "").strip().lower()


def slugify(value: str) -> str:
    """Normalize a tenant slug or Authentik group name for comparison.

    Authentik dropped group slugs in 2025.x — the OIDC ``groups`` claim carries
    the group *name* — so the Cerulean tenant slug is matched against the
    slugified group name ("Acme Corp" → "acme-corp").
    """
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")


def user_groups(user: dict[str, Any]) -> set[str]:
    """Group names carried by an Authentik userinfo or session payload.

    Handles ``groups`` (and the singular ``group``) as either a list of strings
    or Authentik's group objects; unknown shapes yield no groups.
    """
    raw = user.get("groups") or user.get("group") or []
    if isinstance(raw, str):
        raw = [raw]
    groups: set[str] = set()
    for g in raw if isinstance(raw, list) else []:
        if isinstance(g, str):
            groups.add(g.strip().lower())
        elif isinstance(g, dict):
            # Authentik can return groups as objects {pk, name, ...}
            name = g.get("name") or g.get("slug") or g.get("pk") or ""
            if name:
                groups.add(str(name).strip().lower())
    return groups


def has_tenant_access(user: dict[str, Any]) -> bool:
    """True when the Cerulean tenant gate is open for this user.

    When ``CERULEAN_TENANT`` is unset/empty there is no gate (standalone or
    local dev — everyone who passes the email allowlist gets in). When it is
    set, the user's Authentik groups must contain a group whose *name*
    slugifies to the tenant (case- and punctuation-insensitive) — Authentik
    stopped exposing group slugs, and Cerulean matches tenant slugs against
    group names. This mirrors Cerulean's own portal error: 'Your account has no
    tenant here — join an Authentik group whose slug matches a Cerulean
    tenant.'
    """
    tenant = slugify(cerulean_tenant())
    if not tenant:
        return True
    return tenant in {slugify(g) for g in user_groups(user)}
