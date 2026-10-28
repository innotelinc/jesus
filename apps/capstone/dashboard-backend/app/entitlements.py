"""Capstone → Magnate entitlement checks.

Capstone does not own billing — Magnate (RevenueOps) does. Agents are
monetized as a Magnate add-on SKU on a Zeus number/plan; Capstone only
consumes the entitlement decision (see docs/zeus-integration.md §6/§7
step 8). Stripe keys and checkout live in Magnate, never here.

Live contract (Magnate v2.1):
    GET {MAGNATE_PUBLIC_URL}/api/entitlements?plan=<slug|id>&phone=<e164>&user=<username|email>
    → 200 {"entitled": true|false|null, "reason": "ok"|"...", "plan": name,
           "slug": ..., "phone": ..., "user": ..., "status": ...,
           "expires_at": epoch|null}
    → 400 invalid params · 401 bad/missing token · 404 plan not found

Failure policy: when Magnate is configured but unreachable we fail open
(entitled=True, source="unreachable") so agent routing is never blocked by
a billing outage; the source field keeps the fallback observable. A 404
(plan_not_found) is an authoritative "not entitled". With no Magnate
configured, the deployment runs standalone and everything is entitled.

Env:
    MAGNATE_PUBLIC_URL — shared Magnate storefront base URL
                         (e.g. https://app.magnate.innotel.us); empty when
                         running standalone (no billing).
    ENTITLEMENTS_API_TOKEN — optional bearer token matching Magnate's
                             ENTITLEMENTS_API_TOKEN; empty when unset.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("capstone.entitlements")

TIMEOUT_SECONDS = 5.0


def magnate_public_url() -> str:
    """Base URL of the shared Magnate instance, without a trailing slash."""
    return os.environ.get("MAGNATE_PUBLIC_URL", "").rstrip("/")


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    token = os.environ.get("ENTITLEMENTS_API_TOKEN", "")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def check_entitlement(
    phone_number: str | None = None,
    plan: str | None = None,
    user: str | None = None,
) -> dict[str, Any]:
    """Return the Magnate entitlement decision for a number/plan.

    With `plan` omitted this is a connectivity probe: `entitled` is None
    and the response reports whether Magnate is configured and reachable.
    """
    base = magnate_public_url()
    if not base:
        # No Magnate configured — standalone deployment, nothing to gate on.
        return {
            "entitled": True,
            "source": "standalone",
            "magnate_url": "",
            "reason": "standalone_no_billing",
            "message": "MAGNATE_PUBLIC_URL is not set — running standalone (no billing).",
        }

    params: dict[str, str] = {}
    if plan:
        params["plan"] = plan
    if phone_number:
        params["phone"] = phone_number
    if user:
        params["user"] = user

    try:
        resp = httpx.get(
            f"{base}/api/entitlements",
            params=params,
            headers=_headers(),
            timeout=TIMEOUT_SECONDS,
        )
        if resp.status_code == 404:
            data = resp.json()
            return {
                "entitled": False,
                "source": "magnate",
                "magnate_url": base,
                "reason": data.get("reason", "plan_not_found"),
                "plan": data.get("plan"),
                "slug": data.get("slug"),
                "phone_number": phone_number,
                "user": user,
                "message": "Magnate reports the plan is not found.",
            }
        if resp.status_code == 401:
            return {
                "entitled": None,
                "source": "unauthorized",
                "magnate_url": base,
                "reason": "unauthorized",
                "phone_number": phone_number,
                "user": user,
                "message": "Magnate rejected the entitlements token (401).",
            }
        resp.raise_for_status()
        data = resp.json()
        return {
            "entitled": data.get("entitled"),
            "source": "magnate",
            "magnate_url": base,
            "reason": data.get("reason"),
            "plan": data.get("plan"),
            "slug": data.get("slug"),
            "status": data.get("status"),
            "expires_at": data.get("expires_at"),
            "phone_number": phone_number,
            "user": user,
            "message": None if data.get("reason") == "ok" else data.get("reason"),
        }
    except Exception as exc:  # noqa: BLE001 — any failure fails open
        logger.warning("Magnate entitlement check failed, failing open: %s", exc)
        return {
            "entitled": True,
            "source": "unreachable",
            "magnate_url": base,
            "reason": "magnate_unreachable",
            "phone_number": phone_number,
            "plan": plan,
            "user": user,
            "message": f"Magnate unreachable ({exc.__class__.__name__}); failing open.",
        }