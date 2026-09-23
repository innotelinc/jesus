#!/usr/bin/env python3
"""Tests for scripts/secret-scan.py — the estate's credential scan.

The contract under test:

  * a literal string assigned to a sensitive-looking name is a finding
  * placeholders, interpolations and templates are not
  * the Fetch API's RequestCredentials modes (``omit``, ``same-origin``,
    ``include``) are modes, not credentials. The dashboard's dist chunk carries
    them verbatim, and because the whole chunk is re-added whenever its hash
    changes, that false positive blocked every rebuild of the bundle
  * the exemption needs BOTH halves: a value under any other sensitive name, or
    a value that is not exactly a mode, is still a finding
  * a name Next.js inlines into the client bundle (``NEXT_PUBLIC_``) is
    published on purpose, so its value is not a finding — while the same name
    without the prefix still is
  * provider-key shapes still fire wherever they appear
  * a finding is masked, so a report never re-prints the value

The scan text is passed straight to ``scan_text``, so these cases run the real
rules rather than a copy of them. The shape-rule fixtures are assembled at run
time: shape rules run on the raw line and are deliberately NOT relaxed for test
paths, so a fake key or key header written whole in this file would be flagged by
the scan of the file itself.
"""

import importlib.util
import os
import unittest

_SCANNER_PATH = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "secret-scan.py")
)
_spec = importlib.util.spec_from_file_location("secret_scan", _SCANNER_PATH)
secret_scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(secret_scan)

# Assembled, never written whole — see the module docstring.
FAKE_GITHUB_TOKEN = "ghp_" + "a" * 30
FAKE_PRIVATE_KEY_HEADER = "-----BEGIN RSA " + "PRIVATE KEY-----"


def findings(text: str, label: str = "some/file.py"):
    return secret_scan.scan_text(label, text)


class FetchCredentialsTests(unittest.TestCase):
    """The exemption added for the minified bundle's fetch wrapper."""

    def test_fetch_credentials_mode_is_not_a_credential(self):
        for mode_name in ("omit", "same-origin", "include"):
            with self.subTest(mode=mode_name):
                line = f'p.crossOrigin==="anonymous"?p.credentials="{mode_name}":p.credentials="omit",p'
                self.assertEqual(findings(line), [], f'{mode_name} must not be a finding')

    def test_real_value_under_the_credentials_name_is_still_a_finding(self):
        hits = findings('credentials="user:hunter2"')
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][2], "literal-secret (credentials)")

    def test_a_mode_under_another_sensitive_name_is_still_a_finding(self):
        # The name half of the exemption is required, not decorative: a fetch
        # mode assigned to a password-shaped name is still that name's value.
        hits = findings('ADMIN_PASSWORD="same-origin"')
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][2], "literal-secret (ADMIN_PASSWORD)")

    def test_a_longer_value_that_merely_starts_with_a_mode_is_a_finding(self):
        hits = findings('credentials="same-origin-then-some"')
        self.assertEqual(len(hits), 1)


class NextPublicTests(unittest.TestCase):
    """The exemption for values Next.js inlines into the client bundle.

    The dograh upstream patch carried in this repository sets its Chatwoot
    website token under ``NEXT_PUBLIC_CHATWOOT_TOKEN``; a widget token ships in
    the browser by design.
    """

    def test_next_public_name_is_not_a_credential(self):
        self.assertEqual(
            findings('ENV NEXT_PUBLIC_CHATWOOT_TOKEN="3fkFx2mCEjNHjM9gaNc4A82X"'),
            [],
        )

    def test_the_same_name_without_the_prefix_is_still_a_finding(self):
        hits = findings('CHATWOOT_TOKEN="3fkFx2mCEjNHjM9gaNc4A82X"')
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][2], "literal-secret (CHATWOOT_TOKEN)")

    def test_the_exemption_does_not_disable_the_shape_rules(self):
        # A provider key is a finding wherever it sits, including under a name
        # Next.js would inline: the exemption covers the assignment rule only.
        hits = findings(f'NEXT_PUBLIC_KEY="{FAKE_GITHUB_TOKEN}"')
        self.assertEqual([h[2] for h in hits], ["github-token"])


class LiteralAssignmentTests(unittest.TestCase):
    def test_literal_assignment_is_a_finding(self):
        hits = findings('ADMIN_PASS = "hunter2long"')
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][2], "literal-secret (ADMIN_PASS)")

    def test_placeholder_is_not_a_finding(self):
        self.assertEqual(findings('ADMIN_PASS = "change-me-please"'), [])

    def test_interpolation_is_not_a_finding(self):
        self.assertEqual(findings('ADMIN_PASS = "${ADMIN_PASS}"'), [])

    def test_a_name_quoted_in_a_literal_is_not_an_assignment(self):
        self.assertEqual(findings('line.startswith("VAULT_TOKEN_FILE=somepath")'), [])


class ProviderShapeTests(unittest.TestCase):
    def test_provider_key_shape_fires(self):
        # Deliberately under a name that carries no sensitive word: the shape
        # rules run on the raw line, so a provider key is a finding wherever it
        # sits, with or without an assignment-shaped neighbour.
        hits = findings(f'HANDLE = "{FAKE_GITHUB_TOKEN}"')
        self.assertEqual([h[2] for h in hits], ["github-token"])

    def test_private_key_block_fires(self):
        hits = findings(FAKE_PRIVATE_KEY_HEADER)
        self.assertEqual([h[2] for h in hits], ["private-key-block"])


class MaskingTests(unittest.TestCase):
    def test_a_finding_never_reprints_the_value(self):
        secret = "hunter2long"
        hits = findings(f'ADMIN_PASS = "{secret}"')
        self.assertEqual(len(hits), 1)
        masked = hits[0][3]
        self.assertNotIn(secret, masked)
        self.assertNotIn("unter2lon", masked)

    def test_mask_keeps_the_edges_and_hides_the_middle(self):
        self.assertEqual(secret_scan.mask("hunter2long"), "hu*******ng")

    def test_mask_hides_a_short_value_entirely(self):
        self.assertEqual(secret_scan.mask("abcd"), "****")


if __name__ == "__main__":
    unittest.main()
