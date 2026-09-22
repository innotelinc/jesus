#!/usr/bin/env python3
"""Tests for the reconcile decision table.

The script itself needs a live IdP and a live database, so what is pinned here
is the part that decides whether an account may be re-pointed — which is the
part that could hand one person's account to another if it were wrong.

Run: python3 -m unittest discover -s scripts/tests -v
"""
import importlib.util
import pathlib
import unittest

_HERE = pathlib.Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location(
    "reconcile_oidc_subjects", _HERE.parent / "reconcile-oidc-subjects.py"
)
r = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(r)


def local(row_id, email, provider_id):
    return {"id": row_id, "email": email, "provider_id": provider_id}


def idp(uid, email):
    return {"uid": uid, "email": email}


CURRENT = "a" * 64
STALE = "b" * 64


class PlanTest(unittest.TestCase):
    def test_a_current_subject_is_left_alone(self):
        out = r.plan([local(1, "a@x.us", "oidc_" + CURRENT)],
                     [idp(CURRENT, "a@x.us")])
        self.assertEqual(out[0]["action"], r.KEEP)
        self.assertEqual(out[0]["current"], "oidc_" + CURRENT)

    def test_a_stale_subject_is_repointed(self):
        out = r.plan([local(1, "a@x.us", "oidc_" + STALE)],
                     [idp(CURRENT, "a@x.us")])
        self.assertEqual(out[0]["action"], r.REPOINT)
        self.assertEqual(out[0]["current"], "oidc_" + CURRENT)

    def test_local_auth_rows_are_not_this_scripts_business(self):
        out = r.plan([local(1, "a@x.us", "oss_1799683200_admin_innotel")],
                     [idp(CURRENT, "a@x.us")])
        self.assertEqual(out[0]["action"], r.KEEP)
        self.assertIn("not an OIDC subject", out[0]["reason"])

    def test_a_row_with_no_subject_is_left_alone(self):
        out = r.plan([local(1, "a@x.us", "")], [idp(CURRENT, "a@x.us")])
        self.assertEqual(out[0]["action"], r.KEEP)

    def test_a_blank_address_cannot_be_matched(self):
        out = r.plan([local(1, "", "oidc_" + STALE)], [idp(CURRENT, "")])
        self.assertEqual(out[0]["action"], r.KEEP)
        self.assertIn("no address", out[0]["reason"])

    def test_an_address_no_identity_has_needs_a_human(self):
        out = r.plan([local(1, "gone@x.us", "oidc_" + STALE)],
                     [idp(CURRENT, "other@x.us")])
        self.assertEqual(out[0]["action"], r.NO_MATCH)

    def test_two_identities_with_one_address_is_not_guessed(self):
        out = r.plan([local(1, "a@x.us", "oidc_" + STALE)],
                     [idp(CURRENT, "a@x.us"), idp("c" * 64, "a@x.us")])
        self.assertEqual(out[0]["action"], r.AMBIGUOUS)
        self.assertIn("2 identities", out[0]["reason"])

    def test_a_subject_another_row_holds_is_a_conflict(self):
        out = r.plan(
            [local(1, "a@x.us", "oidc_" + STALE), local(2, "b@x.us", "oidc_" + CURRENT)],
            [idp(CURRENT, "a@x.us")],
        )
        self.assertEqual(out[0]["action"], r.CONFLICT)
        self.assertIn("row 2", out[0]["reason"])

    def test_the_address_match_is_case_insensitive(self):
        out = r.plan([local(1, "A@X.US", "oidc_" + STALE)],
                     [idp(CURRENT, "a@x.us")])
        self.assertEqual(out[0]["action"], r.REPOINT)

    def test_a_row_may_hold_its_own_subject(self):
        """Not a conflict: the row already carrying the current subject is fine."""
        out = r.plan([local(1, "a@x.us", "oidc_" + CURRENT)],
                     [idp(CURRENT, "a@x.us")])
        self.assertEqual(out[0]["action"], r.KEEP)

    def test_an_identity_with_no_address_matches_nothing(self):
        out = r.plan([local(1, "a@x.us", "oidc_" + STALE)],
                     [idp(CURRENT, ""), idp("d" * 64, None)])
        self.assertEqual(out[0]["action"], r.NO_MATCH)

    def test_the_rebuild_scenario_end_to_end(self):
        """Every subject changes at once, as after an Authentik rebuild."""
        rows = [local(1, "ops@capstone.example", "oss_1788983189_local"),
                local(3, "admin@x.us", "oidc_" + STALE),
                local(4, "dhunter@x.us", "oidc_" + STALE)]
        users = [idp(CURRENT, "admin@x.us"), idp("c" * 64, "dhunter@x.us")]
        out = r.plan(rows, users)
        self.assertEqual([d["action"] for d in out], [r.KEEP, r.REPOINT, r.REPOINT])
        self.assertEqual(out[1]["current"], "oidc_" + CURRENT)
        self.assertEqual(out[2]["current"], "oidc_" + "c" * 64)

    def test_every_row_gets_exactly_one_decision(self):
        rows = [local(i, f"u{i}@x.us", "oidc_" + STALE) for i in range(1, 6)]
        out = r.plan(rows, [idp(CURRENT, "u1@x.us")])
        self.assertEqual(len(out), len(rows))
        self.assertEqual({d["id"] for d in out}, {r_["id"] for r_ in rows})


if __name__ == "__main__":
    unittest.main()
