#!/usr/bin/env python3
"""Tests for scripts/dograh_wire.py — detecting a config dograh parked.

Upstream parks a telephony configuration in ``inactive`` when its ARI
connection cannot be established for long enough, and never retries it on its
own. While it is parked the Stasis app is unregistered and every call the
dialplan routes into it hangs up, so ``parked_reason`` is the decision the wire
script keys its reactivation off. It is a pure function over the API's own
fields, which is what makes it worth testing without a server.
"""

import importlib.util
import os
import unittest

_WIRE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dograh_wire.py")
)
_spec = importlib.util.spec_from_file_location("dograh_wire", _WIRE_PATH)
dograh_wire = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dograh_wire)


class AriPasswordProblemTest(unittest.TestCase):
    """A password dograh cannot put in its ARI URL must never be written.

    dograh interpolates it into ``ws://…/ari/events?api_key=user:pw&app=…``, so
    a ``#`` truncates the query string and the WebSocket client rejects the URL
    outright. The failure that produces is remote from its cause: the Stasis app
    simply never registers and calls hang up.
    """

    def test_a_generated_password_is_fine(self):
        # scripts/setup.sh uses `openssl rand -base64 24`: base64 has no '#'.
        self.assertEqual(dograh_wire.ari_password_problem("c349273fca0d6cffd1812b05ec3f2cfe"), "")
        self.assertEqual(dograh_wire.ari_password_problem("aB3+/xY=zZ9q"), "")

    def test_a_hash_in_the_password_is_refused(self):
        problem = dograh_wire.ari_password_problem("good#bad")
        self.assertIn("fragment", problem)

    def test_whitespace_is_refused(self):
        self.assertIn("whitespace", dograh_wire.ari_password_problem("two words"))
        self.assertIn("whitespace", dograh_wire.ari_password_problem("tab\there"))

    def test_no_password_is_not_a_problem_by_itself(self):
        # An empty value is handled elsewhere (the script refuses to reconcile
        # a config with it); this function only judges a password that exists.
        self.assertEqual(dograh_wire.ari_password_problem(""), "")


class ParkedReasonTest(unittest.TestCase):
    def test_an_active_config_is_not_parked(self):
        self.assertEqual(dograh_wire.parked_reason({"inactive": False}), "")

    def test_a_config_with_no_flag_at_all_is_not_parked(self):
        # Pre-split rows and older responses carry no `inactive` key.
        self.assertEqual(dograh_wire.parked_reason({}), "")

    def test_a_parked_config_reports_dograhs_own_reason(self):
        reason = dograh_wire.parked_reason(
            {"inactive": True, "inactive_reason": "ari-timeout: ARI unreachable"}
        )
        self.assertEqual(reason, "ari-timeout: ARI unreachable")

    def test_a_parked_config_with_no_reason_still_reads_as_parked(self):
        """The flag, not the reason, is what decides — an operator still needs
        to see that the config is parked even if dograh didn't say why."""
        self.assertEqual(
            dograh_wire.parked_reason({"inactive": True}), "reason not reported"
        )

    def test_the_reason_is_always_a_string(self):
        self.assertIsInstance(
            dograh_wire.parked_reason({"inactive": True, "inactive_reason": None}), str
        )


if __name__ == "__main__":
    unittest.main()
