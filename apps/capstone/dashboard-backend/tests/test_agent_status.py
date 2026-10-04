#!/usr/bin/env python3
"""Unit tests for the Agents page's PBX self-healing.

The bundled FreePBX sits behind a compose profile and can be stopped while
dashboard-api keeps running, so the first PBX action has to bring it back
(`_ensure_pbx_running`), a crash loop has to name its exit code, and the
recovery history has to reach the Health page. The provisioning-status rule
itself lives with the row-count tests in `test_agents_api.py`.

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
class PbxAutoStartTest(unittest.TestCase):
    """The PBX container is profile-gated and can be stopped while dashboard-api
    stays up; the first PBX action must bring it back rather than surfacing
    Docker's raw 409 "container is not running" as a PBX error on every row."""

    def _fake(self, *, running=False, start_error=None, running_after_start=True):
        class FakeContainer:
            def __init__(self):
                self.attrs = {"State": {"Running": running}}
                self.start_calls = 0
                self.reload_calls = 0
                self.exec_error = None

            def reload(self):
                self.reload_calls += 1

            def start(self):
                self.start_calls += 1
                if running_after_start:
                    self.attrs["State"]["Running"] = True
                if start_error is not None:
                    raise start_error

            def exec_run(self, *args, **kwargs):  # noqa: ANN002, ANN003
                if self.exec_error is not None:
                    raise self.exec_error
                return (0, (b"ok", b""))

            def logs(self, tail=15, timestamps=False):  # noqa: ANN001, ANN003
                return b"entrypoint: boom\n"

        return FakeContainer()

    def test_running_container_is_left_alone(self):
        c = self._fake(running=True)
        self.assertIs(main._ensure_pbx_running(c), c)
        self.assertEqual(c.start_calls, 0)

    def test_stopped_container_is_started_and_waited_for(self):
        c = self._fake(running=False)
        main._pbx_autostart_reset()
        with mock.patch.dict(os.environ, {"PBX_START_WAIT_S": "0.05"}), \
                mock.patch.object(main, "invalidate_all"):
            self.assertIs(main._ensure_pbx_running(c), c)
        self.assertEqual(c.start_calls, 1)
        self.assertTrue(main._container_running(c))
        # The auto-start is recorded for the Agents page to surface.
        info = main._pbx_autostart_take()
        self.assertIsNotNone(info)
        self.assertIn("waitedSeconds", info)
        self.assertIsNone(main._pbx_autostart_take())  # one-shot

    def test_start_raises_but_container_is_running_counts_as_success(self):
        # A daemon can answer start() with 304 Not Modified when another
        # request just started the same container; the reload right after shows
        # it running — success, not an error.
        c = self._fake(running=False, start_error=RuntimeError("304 Not Modified"),
                       running_after_start=True)
        with mock.patch.object(main, "invalidate_all"):
            self.assertIs(main._ensure_pbx_running(c), c)
        self.assertEqual(c.start_calls, 1)

    def test_start_failure_raises_clear_error(self):
        c = self._fake(running=False, start_error=RuntimeError("boom"),
                       running_after_start=False)
        with self.assertRaises(main.HTTPException) as ctx:
            main._ensure_pbx_running(c)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("failed to start", ctx.exception.detail)

    def test_wait_timeout_raises_starting_error(self):
        c = self._fake(running=False, running_after_start=False)
        with mock.patch.dict(os.environ, {"PBX_START_WAIT_S": "0"}), \
                mock.patch.object(main, "invalidate_all"):
            with self.assertRaises(main.HTTPException) as ctx:
                main._ensure_pbx_running(c)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn("still starting", ctx.exception.detail)

    def test_crash_loop_is_reported_with_exit_code_and_logs(self):
        # start() succeeds but the container exits again — the opaque "not
        # running" would repeat forever, so name the crash instead.
        c = self._fake(running=False, running_after_start=False)
        c.attrs["State"]["Status"] = "exited"
        c.attrs["State"]["ExitCode"] = 2
        with mock.patch.dict(os.environ, {"PBX_START_WAIT_S": "0.05"}), \
                mock.patch.object(main, "invalidate_all"):
            with self.assertRaises(main.HTTPException) as ctx:
                main._ensure_pbx_running(c)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("exited", ctx.exception.detail)
        self.assertIn("exit code 2", ctx.exception.detail)
        self.assertIn("entrypoint: boom", ctx.exception.detail)

    def test_exec_stopped_container_is_reported_as_state_not_transport(self):
        c = self._fake(running=True)
        c.exec_error = RuntimeError(
            "409 Client Error for http+docker://localhost/v1.56/containers/abc/exec: "
            "Conflict ('Container abc is not running')")
        with mock.patch.object(main, "container_for_service", return_value=c):
            with self.assertRaises(main.HTTPException) as ctx:
                main._pbx_exec(["cat", "/etc/asterisk/extensions_custom.conf"])
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn("is not running", ctx.exception.detail)


@unittest.skipUnless(_HAVE_DEPS, "dashboard-api dependencies are not installed")
class ServiceStartTest(unittest.TestCase):
    """The Control Center's Start action: the offline-row counterpart to Restart."""

    class FakeContainer:
        def __init__(self, running=False, start_error=None):
            self.attrs = {"State": {"Running": running}}
            self.start_calls = 0
            self.start_error = start_error

        def reload(self):
            pass

        def start(self):
            self.start_calls += 1
            if self.start_error is not None:
                raise self.start_error
            self.attrs["State"]["Running"] = True

    def test_start_brings_a_stopped_container_up(self):
        c = self.FakeContainer(running=False)
        with mock.patch.object(main, "container_for_service", return_value=c), \
                mock.patch.object(main, "invalidate_all"):
            res = main.service_start("freepbx", user={})
        self.assertEqual(res, {"status": "started", "service": "freepbx"})
        self.assertEqual(c.start_calls, 1)

    def test_start_is_idempotent_when_running(self):
        c = self.FakeContainer(running=True)
        with mock.patch.object(main, "container_for_service", return_value=c):
            res = main.service_start("freepbx", user={})
        self.assertEqual(res["status"], "running")
        self.assertEqual(c.start_calls, 0)

    def test_start_refuses_the_aggregator_itself(self):
        with self.assertRaises(main.HTTPException) as ctx:
            main.service_start(main.SELF_ID, user={})
        self.assertEqual(ctx.exception.status_code, 403)

    def test_start_reports_a_clear_failure(self):
        c = self.FakeContainer(running=False, start_error=RuntimeError("boom"))
        with mock.patch.object(main, "container_for_service", return_value=c):
            with self.assertRaises(main.HTTPException) as ctx:
                main.service_start("freepbx", user={})
        self.assertEqual(ctx.exception.status_code, 500)
        self.assertIn("Start failed", ctx.exception.detail)


@unittest.skipUnless(_HAVE_DEPS, "dashboard-api dependencies are not installed")
class PbxRecoveryStatusTest(unittest.TestCase):
    """The watchdog/recovery history surfaced on the Health page."""

    def setUp(self):
        with main._pbx_events_lock:
            main._pbx_events.clear()

    def tearDown(self):
        with main._pbx_events_lock:
            main._pbx_events.clear()

    def test_status_summarises_recoveries_and_failures(self):
        main._record_pbx_event("recovered", source="watchdog", waited_seconds=0.4)
        main._record_pbx_event("failed", source="request", detail="boom")
        status = main.pbx_recovery_status(running=True)
        self.assertTrue(status["running"])
        self.assertEqual(status["recoveries"], 1)
        self.assertEqual(status["failures"], 1)
        self.assertEqual(status["lastSource"], "watchdog")
        # Newest first.
        self.assertEqual(status["events"][0]["outcome"], "failed")

    def test_autostart_success_is_recorded_as_a_recovery(self):
        main._pbx_autostart_reset()
        main._record_pbx_autostart(0.0, source="request")
        status = main.pbx_recovery_status(running=True)
        self.assertEqual(status["recoveries"], 1)
        self.assertEqual(status["lastSource"], "request")
        self.assertIsNotNone(status["lastRecoveryAt"])

    def test_build_health_attaches_recovery_to_the_pbx_row(self):
        svcs = [
            {"id": "freepbx", "name": "FreePBX", "status": "offline",
             "healthScore": 0, "health": {"availability": 0.0, "latencyMs": 0,
                                          "errorRate": 0.0, "checkedAt": "2026-01-01T00:00:00Z",
                                          "dependencies": []}},
            {"id": "dograh-api", "name": "Dograh API", "status": "healthy",
             "healthScore": 99, "health": {"availability": 99.9, "latencyMs": 5,
                                            "errorRate": 0.1, "checkedAt": "2026-01-01T00:00:00Z",
                                            "dependencies": []}},
        ]
        with mock.patch.object(main, "build_services", return_value=svcs):
            matrix, _ = main.build_health()
        pbx = next(e for e in matrix if e["service"] == "FreePBX")
        other = next(e for e in matrix if e["service"] == "Dograh API")
        self.assertIn("pbxRecovery", pbx)
        self.assertFalse(pbx["pbxRecovery"]["running"])  # offline → running False
        self.assertNotIn("pbxRecovery", other)


if __name__ == "__main__":
    unittest.main()
