#!/usr/bin/env python3
"""Unit tests for dashboard-backend/app/stack_access.py — the Authentik
per-stack SSO/access inventory behind the Control Center's Health page.

Why it matters: the panel is what tells an operator whether a stack is actually
gated by a group binding, and which identity can still reach it. Getting
"enforced" wrong means the page reports protection that isn't there.

The tests run against a stubbed HTTP layer, so there is no network, no FastAPI
and no real token involved.

Run:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import contextlib
import json
import os
import sys
import unittest
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import stack_access  # noqa: E402


def _payload(users, groups, apps, bindings, reachable_by_user):
    """Build the stub response for a (path, query) pair."""
    def page(results):
        return {"pagination": {"count": len(results), "next": None}, "results": results}

    def handler(url):
        parsed = urllib.parse.urlparse(url)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if path == "/api/v3/core/users/":
            return 200, page(users)
        if path == "/api/v3/core/groups/":
            return 200, page(groups)
        if path == "/api/v3/core/applications/":
            if "for_user" in query:
                wanted = reachable_by_user.get(int(query["for_user"][0]), [])
                return 200, page([a for a in apps if a["slug"] in wanted])
            # The real endpoint filters by the caller's own access unless
            # superuser_full_list is passed — assert the module does that.
            if query.get("superuser_full_list") != ["true"]:
                return 200, page([])
            return 200, page(apps)
        if path == "/api/v3/policies/bindings/":
            return 200, page(bindings)
        return 404, None

    return handler


@contextlib.contextmanager
def stubbed(handler):
    previous = stack_access._get

    def fake_get(url, token, timeout=stack_access.DEFAULT_TIMEOUT):
        return handler(url)

    stack_access._get = fake_get
    stack_access.clear_cache()
    try:
        yield
    finally:
        stack_access._get = previous
        stack_access.clear_cache()


@contextlib.contextmanager
def credentials():
    previous = {k: os.environ.get(k) for k in ("AUTHENTIK_PUBLIC_URL", "AUTHENTIK_API_URL", "AUTHENTIK_TOKEN")}
    os.environ["AUTHENTIK_PUBLIC_URL"] = "https://auth.example.test"
    os.environ.pop("AUTHENTIK_API_URL", None)
    os.environ["AUTHENTIK_TOKEN"] = "test-token"
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


USERS = [
    {"pk": 1, "username": "akadmin", "type": "internal", "is_superuser": True, "is_active": True},
    {"pk": 2, "username": "justin", "type": "external", "is_superuser": False, "is_active": True},
    {"pk": 3, "username": "svc-outpost", "type": "internal_service_account", "is_superuser": False, "is_active": True},
]

GROUPS = [
    {"name": "Capstone", "pk": "g-capstone", "users": [1, 3]},
    {"name": "Cerulean", "pk": "g-cerulean", "users": [1, 3]},
    {"name": "Zeus", "pk": "g-zeus", "users": [1, 3]},
]

APPS = [
    {"pk": "a1", "slug": "capstone-dashboard", "name": "Control Center", "provider": 8, "group": "Capstone"},
    {"pk": "a2", "slug": "capstone-npm-forward-auth", "name": "Forward Auth", "provider": 24, "group": "Capstone"},
    {"pk": "a3", "slug": "cerulean", "name": "Cerulean", "provider": 1, "group": "Cerulean"},
    {"pk": "a4", "slug": "zeus", "name": "Zeus", "provider": None, "group": "Zeus"},
]

BINDINGS = [
    {"pk": "b1", "target": "a1", "group": "g-capstone"},
    {"pk": "b2", "target": "a2", "group": "g-capstone"},
    {"pk": "b3", "target": "a3", "group": "g-cerulean"},
]

REACHABLE = {1: ["capstone-dashboard", "capstone-npm-forward-auth", "cerulean", "zeus"],
             2: ["capstone-dashboard", "capstone-npm-forward-auth"],
             3: ["capstone-dashboard", "capstone-npm-forward-auth", "cerulean"]}


class AccessStatusTest(unittest.TestCase):
    def test_reports_enforced_and_open_applications(self):
        with credentials(), stubbed(_payload(USERS, GROUPS, APPS, BINDINGS, REACHABLE)):
            status = stack_access.build_access_status()
        self.assertTrue(status["ok"], status.get("error"))
        self.assertEqual(status["summary"]["stacks"], 3)
        self.assertEqual(status["summary"]["applications"], 3)  # the tile has no provider
        self.assertEqual(status["summary"]["enforced"], 3)
        self.assertEqual(status["summary"]["ungated"], 0)
        self.assertEqual(status["tilesOnly"], ["zeus"])

    def test_ungated_application_is_flagged(self):
        bindings = [b for b in BINDINGS if b["target"] != "a3"]
        with credentials(), stubbed(_payload(USERS, GROUPS, APPS, bindings, REACHABLE)):
            status = stack_access.build_access_status()
        self.assertEqual(status["summary"]["ungated"], 1)
        self.assertEqual(status["ungated"][0]["slug"], "cerulean")
        cerulean = next(s for s in status["stacks"] if s["name"] == "Cerulean")
        self.assertEqual((cerulean["applications"], cerulean["enforced"]), (1, 0))

    def test_reachability_excludes_tiles_only_applications(self):
        with credentials(), stubbed(_payload(USERS, GROUPS, APPS, BINDINGS, REACHABLE)):
            status = stack_access.build_access_status()
        by_name = {u["username"]: u for u in status["users"]}
        # akadmin reaches the zeus TILE, but Zeus is not a gated stack.
        self.assertEqual(by_name["akadmin"]["stacks"], ["Capstone", "Cerulean"])
        self.assertEqual(by_name["akadmin"]["applications"], 3)
        self.assertEqual(by_name["justin"]["stacks"], ["Capstone"])
        self.assertTrue(by_name["akadmin"]["superuser"])
        self.assertTrue(by_name["svc-outpost"]["machine"])
        self.assertFalse(by_name["justin"]["machine"])

    def test_stack_members_are_usernames_not_pks(self):
        with credentials(), stubbed(_payload(USERS, GROUPS, APPS, BINDINGS, REACHABLE)):
            status = stack_access.build_access_status()
        capstone = next(s for s in status["stacks"] if s["name"] == "Capstone")
        self.assertEqual(capstone["members"], ["akadmin", "svc-outpost"])

    def test_missing_token_is_reported_not_raised(self):
        previous = os.environ.pop("AUTHENTIK_TOKEN", None)
        os.environ["AUTHENTIK_PUBLIC_URL"] = "https://auth.example.test"
        try:
            status = stack_access.build_access_status()
        finally:
            if previous is not None:
                os.environ["AUTHENTIK_TOKEN"] = previous
        self.assertFalse(status["ok"])
        self.assertFalse(status["configured"])
        self.assertIn("AUTHENTIK_TOKEN", status["error"])

    def test_unreachable_idp_is_reported_not_raised(self):
        def dead(url):
            return 0, None

        with credentials(), stubbed(dead):
            status = stack_access.build_access_status()
        self.assertFalse(status["ok"])
        self.assertTrue(status["configured"])
        self.assertIn("unreachable", status["error"])

    def test_base_url_falls_back_to_npm_domain(self):
        previous = {k: os.environ.pop(k, None) for k in ("AUTHENTIK_PUBLIC_URL", "AUTHENTIK_API_URL")}
        os.environ["NPM_BASE_DOMAIN"] = "capstone.example.test"
        try:
            self.assertEqual(stack_access.base_url(), "https://auth.capstone.example.test")
        finally:
            os.environ.pop("NPM_BASE_DOMAIN", None)
            for key, value in previous.items():
                if value is not None:
                    os.environ[key] = value

    def test_api_url_wins_over_public_url(self):
        with credentials():
            os.environ["AUTHENTIK_API_URL"] = "http://10.0.0.5:9000"
            try:
                self.assertEqual(stack_access.base_url(), "http://10.0.0.5:9000")
            finally:
                os.environ.pop("AUTHENTIK_API_URL", None)

    def test_requires_superuser_full_list_for_the_app_listing(self):
        """Without superuser_full_list the stub returns nothing, so a passing
        summary proves the module sends it."""
        calls = []
        inner = _payload(USERS, GROUPS, APPS, BINDINGS, REACHABLE)

        def recording(url):
            if "/api/v3/core/applications/" in url and "for_user" not in url:
                calls.append(url)
            return inner(url)

        with credentials(), stubbed(recording):
            status = stack_access.build_access_status()
        self.assertTrue(status["ok"])
        self.assertTrue(calls)
        self.assertTrue(all("superuser_full_list=true" in url for url in calls), calls)

    def test_result_is_cached_between_calls(self):
        hits = {"n": 0}
        inner = _payload(USERS, GROUPS, APPS, BINDINGS, REACHABLE)

        def counting(url):
            hits["n"] += 1
            return inner(url)

        with credentials(), stubbed(counting):
            first = stack_access.build_access_status()
            after_first = hits["n"]
            second = stack_access.build_access_status()
        self.assertEqual(first["ok"], second["ok"])
        self.assertEqual(hits["n"], after_first)

    def test_json_serialisable(self):
        with credentials(), stubbed(_payload(USERS, GROUPS, APPS, BINDINGS, REACHABLE)):
            status = stack_access.build_access_status()
        json.dumps(status)  # the FastAPI endpoint returns it directly


class IsGatedTest(unittest.TestCase):
    def test_ignores_bindings_without_a_group(self):
        self.assertEqual(
            stack_access._is_gated([
                {"target": "a1", "group": "g1"},
                {"target": "a2", "group": None},   # user/expression binding
                {"target": None, "group": "g3"},   # not an application target
            ]),
            {"a1"},
        )


if __name__ == "__main__":
    unittest.main()
