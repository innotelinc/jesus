"""Tests for resolve_container() — which FreePBX container the sync talks to.

The shared-box hand-off leaves two PBX containers on the host at once: the one
that just took the voice plane over and the one it replaced, stopped rather
than deleted so a rollback is a container start. Picking the stopped one makes
every `docker exec` fail, so the timer reports a healthy PBX as unreachable.
These tests pin the running-container rule and the Zeus/add-on ordering.

Pure stdlib (unittest) and no docker: the module's `sh` seam is stubbed, like
the other pbx tests do.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bootstrap_dograh_route as bdr  # noqa: E402


class FakeSh:
    """Stub for the module's shell seam.

    ``existing`` maps container name -> running?, and ``ps`` is the list
    `docker ps --format {{.Names}}` returns.
    """

    def __init__(self, existing: dict[str, bool], ps: list[str] | None = None):
        self.existing = existing
        self.ps = ps if ps is not None else [n for n, up in existing.items() if up]
        self.calls: list[tuple] = []

    def __call__(self, *args: str) -> str:
        self.calls.append(args)
        if args[:2] == ("docker", "inspect") and len(args) == 5:
            name = args[4]
            if name not in self.existing:
                raise bdr.FreepbxError(f"no such container: {name}")
            return "true" if self.existing[name] else "false"
        if args[:2] == ("docker", "ps"):
            return "\n".join(self.ps) + ("\n" if self.ps else "")
        raise AssertionError(f"unexpected shell call: {args}")


class TestResolveContainer(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = bdr.sh

    def tearDown(self) -> None:
        bdr.sh = self._orig

    def use(self, existing: dict[str, bool], ps: list[str] | None = None) -> FakeSh:
        fake = FakeSh(existing, ps)
        bdr.sh = fake
        return fake

    def test_prefers_the_requested_container_when_running(self) -> None:
        self.use({"pbx-freepbx": True})
        self.assertEqual(bdr.resolve_container("pbx-freepbx"), "pbx-freepbx")

    def test_zeus_owns_the_plane_and_the_add_on_bundled_one_is_stopped(self) -> None:
        # The exact situation of the shared-box hand-off: the old container is
        # still there (so `docker inspect` succeeds) but it is not running.
        self.use({"pbx-freepbx": False, "zeus-freepbx": True})
        self.assertEqual(bdr.resolve_container("pbx-freepbx"), "zeus-freepbx")

    def test_standalone_still_resolves_to_the_bundled_pbx(self) -> None:
        self.use({"pbx-freepbx": True, "zeus-freepbx": False})
        self.assertEqual(bdr.resolve_container("pbx-freepbx"), "pbx-freepbx")

    def test_renamed_container_falls_back_to_any_running_freepbx(self) -> None:
        self.use({}, ps=["zeus-freepbx-2"])
        self.assertEqual(bdr.resolve_container("pbx-freepbx"), "zeus-freepbx-2")

    def test_nothing_running_returns_the_default(self) -> None:
        # Callers then get the normal connection error, naming what they tried.
        self.use({"pbx-freepbx": False})
        self.assertEqual(bdr.resolve_container("pbx-freepbx"), "pbx-freepbx")

    def test_a_stopped_container_is_not_taken_from_docker_ps(self) -> None:
        # `docker ps` only lists running containers; make sure a stopped name
        # leaking into the list is still the last resort, not the answer.
        self.use({"pbx-freepbx": False, "zeus-freepbx": True}, ps=["zeus-freepbx"])
        self.assertEqual(bdr.resolve_container("pbx-freepbx"), "zeus-freepbx")


if __name__ == "__main__":
    unittest.main()
