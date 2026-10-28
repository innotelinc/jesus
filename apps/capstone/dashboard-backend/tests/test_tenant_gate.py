#!/usr/bin/env python3
"""Unit tests for the Cerulean tenant gate (dashboard-backend/app/tenant_gate).

Run:  python3 -m unittest discover -s dashboard-backend/tests -v

The gate decides whether an authenticated Authentik user may use the control
center, by matching the dashboard's CERULEAN_TENANT slug against the user's
group *names*. Pure stdlib — no FastAPI, no OIDC, no network, no .env.
"""

import contextlib
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.tenant_gate import (  # noqa: E402
    cerulean_tenant,
    has_tenant_access,
    slugify,
    user_groups,
)


@contextlib.contextmanager
def tenant_env(value=None):
    """Run with CERULEAN_TENANT set to `value` (or absent when None)."""
    previous = os.environ.pop("CERULEAN_TENANT", None)
    try:
        if value is not None:
            os.environ["CERULEAN_TENANT"] = value
        yield
    finally:
        os.environ.pop("CERULEAN_TENANT", None)
        if previous is not None:
            os.environ["CERULEAN_TENANT"] = previous


class SlugifyTest(unittest.TestCase):
    def test_groups_names_become_slugs(self):
        self.assertEqual(slugify("Acme Corp"), "acme-corp")
        self.assertEqual(slugify("  ACME_CORP  "), "acme-corp")
        self.assertEqual(slugify("acme-corp"), "acme-corp")
        self.assertEqual(slugify("Acme  Corp"), "acme-corp")
        self.assertEqual(slugify("Acme & Co."), "acme-co")

    def test_empty_and_punctuation_only(self):
        self.assertEqual(slugify(""), "")
        self.assertEqual(slugify("   "), "")
        self.assertEqual(slugify("---"), "")


class UserGroupsTest(unittest.TestCase):
    def test_list_of_names(self):
        self.assertEqual(
            user_groups({"groups": ["Acme Corp", "Zeus"]}),
            {"acme corp", "zeus"},
        )

    def test_singular_claim_and_bare_string(self):
        self.assertEqual(user_groups({"group": "Acme"}), {"acme"})
        self.assertEqual(user_groups({"groups": "Acme"}), {"acme"})

    def test_group_objects_use_name_then_slug_then_pk(self):
        # `pk` is the last resort: a group object with no usable name (and an
        # empty name is unusable) contributes its opaque pk, which simply
        # never matches a tenant slug.
        groups = user_groups(
            {
                "groups": [
                    {"pk": 1, "name": "Acme Corp"},
                    {"pk": 2, "slug": "globex"},
                    {"pk": 3},
                    {"pk": 4, "name": ""},
                ]
            }
        )
        self.assertEqual(groups, {"acme corp", "globex", "3", "4"})

    def test_missing_or_unsupported_shapes_are_empty(self):
        self.assertEqual(user_groups({}), set())
        self.assertEqual(user_groups({"groups": None}), set())
        self.assertEqual(user_groups({"groups": 7}), set())
        self.assertEqual(user_groups({"groups": [None, 3.5]}), set())


class HasTenantAccessTest(unittest.TestCase):
    def test_no_gate_when_tenant_unset_or_blank(self):
        for value in (None, "", "   "):
            with self.subTest(value=value), tenant_env(value):
                self.assertEqual(cerulean_tenant(), "")
                self.assertTrue(has_tenant_access({}))
                self.assertTrue(has_tenant_access({"groups": ["anything"]}))

    def test_matches_group_name_against_tenant_slug(self):
        cases = [
            (["Acme Corp"], True, "display name versus slug"),
            (["acme-corp"], True, "name already a slug"),
            (["ACME_CORP"], True, "case and separator differences"),
            (["Zeus", "  Acme   Corp  "], True, "matches among several groups"),
            (["elsewhere"], False, "no matching group"),
            ([], False, "no groups at all"),
            (["acme"], False, "partial names do not match"),
        ]
        with tenant_env("acme-corp"):
            for groups, expected, label in cases:
                with self.subTest(label=label):
                    self.assertEqual(has_tenant_access({"groups": groups}), expected)

    def test_missing_or_malformed_claims_deny(self):
        with tenant_env("acme-corp"):
            self.assertFalse(has_tenant_access({}))
            self.assertFalse(has_tenant_access({"groups": None}))
            self.assertFalse(has_tenant_access({"groups": {"name": "Acme Corp"}}))

    def test_group_objects_match_by_name(self):
        with tenant_env("Acme Corp"):
            self.assertTrue(has_tenant_access({"groups": [{"pk": 7, "name": "acme corp"}]}))

    def test_tenant_is_normalised_too(self):
        with tenant_env("  Acme_Corp  "):
            self.assertTrue(has_tenant_access({"groups": ["Acme Corp"]}))


if __name__ == "__main__":
    unittest.main()
