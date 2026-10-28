#!/usr/bin/env python3
"""Unit tests for the Zeus portal origin and the two voice-plane link rows.

WHY THIS EXISTS
---------------
The Control Center's Links page and its sidebar are one payload: the sidebar
resolves an external entry's href from the link `build_links` publishes, keyed by
id, so the two surfaces cannot disagree. What they *can* disagree about is the
portal itself, and that is the bug this pins.

The PBX customer portal used to be a row in `NPM_SUBDOMAINS` (`portal` →
`portal.<NPM_BASE_DOMAIN>`). Capstone's bundled portal runs behind a compose
profile, so with it off that name answered nothing while Zeus's portal — the real
one, one Next.js app answered under every `*.zeus.<zone>` name — was up. The dead
link read as a live service with a broken URL.

So the subdomain map deliberately has **no** `portal` entry now, and every row
that needs the portal resolves through `portal_origin()`: `ZEUS_PORTAL_URL`,
else `ZEUS_API_URL` (the same app), else the portal's own declared public name.
Two things are asserted here that a hand-check of one link would miss:

  * **The resolution order, including the empty string.** A blank
    `ZEUS_PORTAL_URL` is what `.env.example` ships, so falling through it is the
    normal path, not an edge case; treating "" as an origin would point every
    portal link at nothing.
  * **Both rows come from the same function.** The portal service row and the
    voice-plane screen row are published together and must share one origin — a
    second literal is how one row silently keeps the retired name.

Skipped in a bare interpreter (no fastapi); runs wherever
`pip install -r dashboard-backend/requirements.txt` has been done.

Run with:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:  # pragma: no cover - depends on the environment
    from app import main

    _HAVE_DEPS = True
except Exception:  # noqa: BLE001 - any import failure means the deps are absent
    _HAVE_DEPS = False


@unittest.skipUnless(_HAVE_DEPS, "dashboard-api dependencies are not installed")
class PortalOrigin(unittest.TestCase):
    """One origin per portal, resolved in the documented order."""

    def test_an_explicit_portal_url_wins(self) -> None:
        with mock.patch.dict(os.environ, {"ZEUS_PORTAL_URL": "https://portal.example/",
                                          "ZEUS_API_URL": "https://api.example"}):
            self.assertEqual(main.portal_origin(), "https://portal.example")

    def test_the_api_url_is_the_fallback(self) -> None:
        # Same app, different name: api.<zone> serves the portal's routes.
        with mock.patch.dict(os.environ, {"ZEUS_PORTAL_URL": "https://api.example/"}):
            self.assertEqual(main.portal_origin(), "https://api.example")

    def test_a_blank_value_falls_through_rather_than_resolving_to_nothing(self) -> None:
        # .env.example ships `ZEUS_PORTAL_URL=` — the empty default is the
        # normal path here, not a misconfiguration.
        with mock.patch.dict(os.environ, {"ZEUS_PORTAL_URL": "   ",
                                          "ZEUS_API_URL": ""}):
            self.assertEqual(main.portal_origin(), "https://app.zeus.innotel.us")

    def test_the_default_is_the_portals_own_declared_name(self) -> None:
        with mock.patch.dict(os.environ, {"ZEUS_PORTAL_URL": "", "ZEUS_API_URL": ""}):
            self.assertEqual(main.portal_origin(), "https://app.zeus.innotel.us")


@unittest.skipUnless(_HAVE_DEPS, "dashboard-api dependencies are not installed")
class TheVoicePlaneRows(unittest.TestCase):
    """Both ways into the voice plane, published from one origin."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.links = {link["id"]: link for link in main.build_links()}

    def test_the_subdomain_map_no_longer_claims_the_portal(self) -> None:
        # Keeping the row would let a dead name come back as a live-looking link.
        self.assertNotIn("portal", main.NPM_SUBDOMAINS)

    def test_the_portal_service_row_uses_the_zeus_origin(self) -> None:
        self.assertEqual(self.links["ln-portal"]["url"], main.portal_origin())

    def test_the_voice_plane_row_is_the_portal_plus_the_voice_screen(self) -> None:
        self.assertEqual(main.VOICE_PLANE_PATH, "/dashboard/voice")
        self.assertEqual(self.links["ln-voice-plane"]["url"],
                         f"{main.portal_origin()}{main.VOICE_PLANE_PATH}")

    def test_the_pbx_sign_in_row_is_published_beside_it(self) -> None:
        # The module-free door from the PBX side: the pbx-sso gateway's sign-in
        # banner carries the Voice Plane link, and this row opens the same route.
        row = self.links[main.PBX_SIGNIN_LINK_ID]
        self.assertEqual(row["category"], "services")
        self.assertTrue(row["url"])
        self.assertNotEqual(row["url"], self.links["ln-voice-plane"]["url"])

    def test_link_ids_are_unique(self) -> None:
        # The sidebar resolves an entry by id; a duplicate makes the wrong row
        # win depending on order, and only one of the two has the right URL.
        ids = [link["id"] for link in main.build_links()]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
