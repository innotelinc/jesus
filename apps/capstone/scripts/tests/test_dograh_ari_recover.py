#!/usr/bin/env python3
"""Tests for scripts/dograh-ari-recover.sh — the Stasis app guard.

The contract under test:

  * the Stasis app being registered is the only healthy state — the script
    exits 0 and touches nothing (no repair, no writes)
  * a missing app with ARI unreachable is NOT repaired: dograh cannot register
    against a PBX that isn't answering, and this runs on a timer, so attempting
    a repair would churn for the whole outage. It exits 1 so the journal shows
    it
  * a missing app with ARI reachable IS repaired by re-running
    scripts/dograh_wire.py, and the freshly-learned Stasis app name (persisted
    into .env by that script) is picked up before re-checking registration
  * `check` never repairs, whatever the state

Everything external is a stand-in: `docker` is a script on PATH that answers
the handful of probes the recovery makes, and the "repo" is a temp directory
whose scripts/dograh_wire.py is a stub — the real one would dial the dograh API
and the tests would be describing a different program.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
RECOVER_SRC = os.path.join(REPO_ROOT, "scripts", "dograh-ari-recover.sh")

APP = "dograh_abc123"

# Answers the probes the recovery makes, and records every call so the test can
# assert what the script did (or didn't) ask of the PBX.
FAKE_DOCKER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  "ps -aq --filter label=com.docker.compose.service=freepbx")
    if [ -s "$MISSING_CONTAINER" ]; then exit 0; fi
    echo "fake123" ;;
  "inspect -f {{.State.Status}} fake123") echo running ;;
  "ps --format {{.Names}}") echo fake123 ;;
  *"ari show apps"*) cat "$APPS_FILE" ;;
  *"-c"*)  # the /dev/tcp ARI reachability probe
    if [ -s "$ARI_CLOSED" ]; then exit 1; fi
    exit 0 ;;
  *) exit 0 ;;
esac
"""

# Stands in for scripts/dograh_wire.py: records that it ran, learns the Stasis
# app name the way the real one does (persisting it into .env), and flips the
# PBX into the recovered state.
FAKE_WIRE = """#!/usr/bin/env python3
import sys, pathlib
marker = pathlib.Path(sys.argv[0]).parent / "wire-ran"
marker.write_text(" ".join(sys.argv[1:]), encoding="utf-8")
env_file = None
args = sys.argv[1:]
if "--env-file" in args:
    env_file = pathlib.Path(args[args.index("--env-file") + 1])
if env_file is not None:
    with env_file.open("a", encoding="utf-8") as fh:
        fh.write("DOGRAH_STASIS_APP_NAME=%s\\n" % "APP_PLACEHOLDER")
(pathlib.Path(__file__).resolve().parent.parent / "state" / "apps").write_text(
    "Application Name         \\n=========================\\n%s\\n" % "APP_PLACEHOLDER",
    encoding="utf-8",
)
print("PASS ARI telephony config reactivated — dograh reconnects on its next poll")
"""

APPS_HEADER = "Application Name         \n=========================\n"


class RecoverScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dograh-ari-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        sandbox = os.path.join(self.tmp, "repo")
        scripts = os.path.join(sandbox, "scripts")
        state = os.path.join(sandbox, "state")
        os.makedirs(scripts)
        os.makedirs(state)
        os.makedirs(os.path.join(self.tmp, "bin"))

        shutil.copy(RECOVER_SRC, os.path.join(scripts, "dograh-ari-recover.sh"))
        self.apps_file = os.path.join(state, "apps")
        self.ari_closed = os.path.join(state, "ari-closed")
        self.missing_container = os.path.join(state, "missing-container")
        self.call_log = os.path.join(state, "calls.log")
        self.wire_marker = os.path.join(scripts, "wire-ran")

        self.write(os.path.join(self.tmp, "bin", "docker"), FAKE_DOCKER, mode=0o755)
        self.write(
            os.path.join(scripts, "dograh_wire.py"),
            FAKE_WIRE.replace("APP_PLACEHOLDER", APP),
            mode=0o755,
        )
        self.env_file = os.path.join(sandbox, ".env")
        self.write(self.env_file, "DOGRAH_CONFIG_NAME='Asterisk ARI (dograh)'\n")

        self.script = os.path.join(scripts, "dograh-ari-recover.sh")

    def write(self, path, text, mode=0o644):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(path, mode)

    def set_apps(self, *names):
        self.write(self.apps_file, APPS_HEADER + "".join(f"{n}\n" for n in names))

    def run_script(self, *args):
        env = dict(os.environ)
        env["PATH"] = os.path.join(self.tmp, "bin") + os.pathsep + env["PATH"]
        env["APPS_FILE"] = self.apps_file
        env["ARI_CLOSED"] = self.ari_closed
        env["MISSING_CONTAINER"] = self.missing_container
        env["CALL_LOG"] = self.call_log
        env.pop("DOGRAH_STASIS_APP_NAME", None)  # the script must read .env itself
        env.pop("FREEPBX_CONTAINER", None)  # ...and resolve the container itself
        return subprocess.run(
            ["bash", self.script, *args],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )

    def wire_ran(self):
        if not os.path.exists(self.wire_marker):
            return ""
        with open(self.wire_marker, encoding="utf-8") as fh:
            return fh.read()

    # ── the healthy state ───────────────────────────────────────────────────
    def learn_name(self):
        with open(self.env_file, "a", encoding="utf-8") as fh:
            fh.write(f"DOGRAH_STASIS_APP_NAME={APP}\n")

    def test_registered_app_is_healthy_and_untouched(self):
        """The name comes from .env, the app is registered: nothing happens."""
        self.learn_name()
        self.set_apps(APP)
        result = self.run_script("recover", "--wait", "3")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK — Stasis app", result.stdout)
        self.assertEqual(self.wire_ran(), "", "healthy state must not run the repair")
        self.assertNotIn("dograh_wire.py", self.log())

    def test_a_different_app_registered_is_not_this_app(self):
        """Another deployment's Stasis app must not read as ours."""
        self.learn_name()
        self.set_apps("dograh_someone_else")
        self.write(self.ari_closed, "1")  # ARI down → no repair attempted
        result = self.run_script("recover")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.wire_ran(), "")

    # ── the outage the script exists for ────────────────────────────────────
    def test_missing_app_with_ari_down_is_reported_not_repaired(self):
        """The PBX is the problem: repairing dograh on a timer would churn."""
        self.set_apps()  # nothing registered
        self.write(self.ari_closed, "1")
        result = self.run_script("recover")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not listening", result.stdout)
        self.assertEqual(self.wire_ran(), "", "a closed ARI port must not trigger a repair")

    def test_missing_app_with_ari_up_is_repaired_and_learns_the_name(self):
        """The parked-config case: ARI answers, but dograh isn't connected."""
        self.set_apps()  # nothing registered
        result = self.run_script("recover", "--wait", "5")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("repairing:", result.stdout)
        self.assertIn("--env-file", self.wire_ran())
        # the name the repair persisted is what the re-check uses
        with open(self.env_file, encoding="utf-8") as fh:
            self.assertIn(f"DOGRAH_STASIS_APP_NAME={APP}", fh.read())
        self.assertIn("OK — recovered", result.stdout)

    def test_a_failed_repair_is_reported_and_not_papered_over(self):
        self.set_apps()
        self.write(os.path.join(os.path.dirname(self.script), "dograh_wire.py"), "#!/bin/sh\nexit 3\n", 0o755)
        result = self.run_script("recover", "--wait", "5")
        self.assertEqual(result.returncode, 1)
        self.assertIn("dograh_wire.py failed", result.stdout)

    def test_check_never_repairs(self):
        self.set_apps()
        result = self.run_script("check")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.wire_ran(), "")
        self.assertIn("registered apps:", result.stdout)

    # ── environment edge cases ──────────────────────────────────────────────
    def test_missing_pbx_container_is_an_error(self):
        self.write(self.missing_container, "1")
        result = self.run_script("recover")
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not running", result.stdout)

    def test_unknown_argument_is_a_usage_error(self):
        result = self.run_script("--nope")
        self.assertEqual(result.returncode, 2)

    def log(self):
        if not os.path.exists(self.call_log):
            return ""
        with open(self.call_log, encoding="utf-8") as fh:
            return fh.read()


if __name__ == "__main__":
    unittest.main()
