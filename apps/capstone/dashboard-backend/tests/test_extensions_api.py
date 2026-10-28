#!/usr/bin/env python3
"""Self-repair on load — route tests for the Extensions page (app/main.py).

One WebRTC extension is three sections in three files, written in that order by
`extensions_create`: the endpoint (pjsip.endpoint_custom.conf), its auth
(pjsip.auth_custom.conf) and its AOR (pjsip.aor_custom.conf). A run that failed
part-way leaves the earlier sections in place and a later one missing — an
endpoint whose `aors =` points at a section that does not exist, or one that
cannot authenticate at all.

These tests drive the real FastAPI app against an in-memory conf store at the
`_pbx_exec` seam (the same `cat` / `echo <b64> | base64 -d >` shapes the real
helpers use), so what is exercised is the actual read/repair path.

What matters: the AOR is restored and published by ONE pjsip reload, a complete
extension is not touched, and the gap that cannot be closed — a missing auth
section, whose password is not recoverable — is reported for the operator
instead of being "fixed" with a secret nobody knows.

Run with:  python3 -m unittest discover -s dashboard-backend/tests -v
"""

import base64
import os
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:  # pragma: no cover - depends on the environment
    from fastapi.testclient import TestClient

    from app import main

    _HAVE_DEPS = True
except Exception:  # noqa: BLE001 - any import failure means the deps are absent
    _HAVE_DEPS = False

ENDPOINT = "/etc/asterisk/pjsip.endpoint_custom.conf"
AUTH = "/etc/asterisk/pjsip.auth_custom.conf"
AOR = "/etc/asterisk/pjsip.aor_custom.conf"


def endpoint_section(ext: str, caller_id: str = "Desk") -> str:
    return (
        f"\n; Extension {ext} — provisioned via Capstone control center\n"
        f"[{ext}](webrtc-template)\n"
        f"type = endpoint\n"
        f"auth = {ext}-auth\n"
        f"aors = {ext}\n"
        f"callerid = {caller_id} <{ext}>\n"
    )


def auth_section(ext: str, password: str = "hunter2") -> str:
    return (
        f"\n; Extension {ext} auth — provisioned via Capstone control center\n"
        f"[{ext}-auth]\n"
        f"type = auth\n"
        f"auth_type = userpass\n"
        f"username = {ext}\n"
        f"password = {password}\n"
    )


def aor_section(ext: str) -> str:
    return (
        f"\n; Extension {ext} AOR (single WSS contact)\n"
        f"[{ext}]\n"
        f"type = aor\n"
        f"max_contacts = 1\n"
        f"remove_existing = yes\n"
    )


class FakeConfPbx:
    """In-memory PBX: the pjsip conf files the page reads, plus the CLI."""

    def __init__(self, endpoint="", auth="", aor=""):
        self.confs = {ENDPOINT: endpoint, AUTH: auth, AOR: aor}
        self.execs: list[list[str]] = []
        self.fail_write = False

    def exec_(self, cmd):
        self.execs.append(list(cmd))
        if cmd[0] == "cat":
            return 0, self.confs.get(cmd[1], "")
        if cmd[0] == "sh" and "base64 -d >" in cmd[2]:
            if self.fail_write:
                return 1, "write failed"
            path = re.search(r"> '([^']+)'", cmd[2]).group(1)
            self.confs[path] = base64.b64decode(cmd[2].split()[1]).decode()
            return 0, ""
        return 0, ""

    def pjsip_reloads(self):
        return [c for c in self.execs
                if c[:2] == ["asterisk", "-rx"] and "res_pjsip.so" in c[2]]

    def writes(self):
        return [c for c in self.execs if c[0] == "sh" and "base64 -d >" in c[2]]


@unittest.skipUnless(_HAVE_DEPS, "fastapi/httpx not installed — skipping route tests")
class ExtensionsAutoRepairTest(unittest.TestCase):
    def setUp(self):
        self.deps = mock.patch.dict(
            main.app.dependency_overrides,
            {main.require_session: lambda: {"email": "ops@test", "role": "admin"}},
        )
        self.deps.start()
        main._repair_claims.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.deps.stop()

    def pbx(self, **confs):
        fake = FakeConfPbx(**confs)
        patcher = mock.patch.object(main, "_pbx_exec", side_effect=fake.exec_)
        patcher.start()
        self.addCleanup(patcher.stop)
        return fake

    def only(self, res):
        self.assertEqual(res.status_code, 200)
        rows = res.json()
        self.assertEqual(len(rows), 1)
        return rows[0]

    def test_a_complete_extension_reports_provisioned_and_is_not_touched(self):
        pbx = self.pbx(
            endpoint=endpoint_section("201"),
            auth=auth_section("201"),
            aor=aor_section("201"),
        )

        ext = self.only(self.client.get("/extensions"))

        self.assertEqual(ext["pbx"]["status"], "provisioned")
        self.assertEqual(pbx.writes(), [], "a complete extension must not be re-written")
        self.assertEqual(pbx.pjsip_reloads(), [])

    def test_a_missing_aor_is_restored_on_load(self):
        # The failure the create path leaves behind: endpoint and auth written,
        # the AOR never reached, so `aors = 201` points at nothing.
        pbx = self.pbx(
            endpoint=endpoint_section("201"),
            auth=auth_section("201"),
        )

        ext = self.only(self.client.get("/extensions"))

        self.assertEqual(ext["pbx"]["status"], "provisioned")
        self.assertIn("[201]", pbx.confs[AOR])
        self.assertIn("type = aor", pbx.confs[AOR])
        self.assertEqual(len(pbx.pjsip_reloads()), 1, "the batch needs exactly one reload")

    def test_a_missing_auth_section_is_reported_not_invented(self):
        """The password lives in the auth section and nowhere else, so it cannot
        be reconstructed — the page has to name it and hand over to rotate."""
        pbx = self.pbx(
            endpoint=endpoint_section("201"),
            aor=aor_section("201"),
        )

        ext = self.only(self.client.get("/extensions"))

        self.assertEqual(ext["pbx"]["status"], "partial")
        self.assertFalse(ext["pbx"]["auth"])
        self.assertIn("rotate", ext["pbx"]["detail"])
        self.assertEqual(pbx.confs[AUTH], "", "no password may be invented")

    def test_a_repair_attempt_is_bounded_by_the_cooldown(self):
        pbx = self.pbx(
            endpoint=endpoint_section("201"),
            auth=auth_section("201"),
        )
        pbx.fail_write = True  # unrepairable: the PBX refuses the write

        for _ in range(3):
            self.only(self.client.get("/extensions"))

        self.assertEqual(len(pbx.writes()), 1, "the cooldown did not bound the attempts")


if __name__ == "__main__":
    unittest.main()
