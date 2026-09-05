"""Capstone → Magnate entitlement checks (stub).

Capstone does not own billing — Magnate (RevenueOps) does. Agents are
monetized as a Magnate add-on SKU on a Zeus number/plan; Capstone only
consumes the entitlement decision (see docs/zeus-integration.md §6/§7
step 8). Stripe keys and checkout live in Magnate, never here.

The live check lands when Magnate's v2.1 entitlement API ships. Until then
this module is a permissive stub: it always grants, so agent routing is
never blocked by an entitlement lookup that does not exist yet.

Contract (once the API ships):
    GET {MAGNATE_PUBLIC_URL}/api/entitlements?phone=<e164>&plan=<id>
    → 200 {"entitled": true|false, "plan": "...", "expires_at": "..."}

Env:
    MAGNATE_PUBLIC_URL — shared Magnate storefront base URL
                         (e.g. https://app.magnate.innotel.us); empty when
                         running standalone (no billing).
"""

from __future__ import annotations

import os
from typing import Any


def magnate_public_url() -> str:
    """Base URL of the shared Magnate instance, without a trailing slash."""
    return os.environ.get("MAGNATE_PUBLIC_URL", "").rstrip("/")


def check_entitlement(
    phone_number: str | None = None,
    plan: str | None = None,
) -> dict[str, Any]:
    """Return the Magnate entitlement decision for a number/plan.

    STUB: always entitled until Magnate's v2.1 entitlement API ships.
    Replace the body with a real call to the Magnate entitlement endpoint
    and honor the returned decision instead of always granting.
    """
    return {
        "entitled": True,
        "source": "stub",
        "phone_number": phone_number,
        "plan": plan,
        "magnate_url": magnate_public_url(),
        # TODO(magnate-v2.1): GET {MAGNATE_PUBLIC_URL}/api/entitlements
        # and return the live decision (see module docstring for the contract).
    }