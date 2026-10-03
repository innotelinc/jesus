#!/usr/bin/env python3
"""Tests for the workflow-scope guards in scripts/sync-dograh-fork.sh.

The fork sync pushes a tree that carries ``.github/workflows/*``, and GitHub
rejects such a push from a token without the ``workflow`` scope. That rejection
arrives as a plain ``failed to push some refs``, so the script guards it in two
places and has to name the scope whenever it fires:

  * up front, from the token's ``X-OAuth-Scopes`` header, which is how a classic
    PAT is caught before a push is spent on it
  * after the push, by matching the rejection itself, which is the only signal a
    fine-grained PAT gives (it sends no scope header at all)

The contract under test:

  * a classic PAT holding ``workflow`` is left alone, with or without a space
    after the comma — the header is comma-AND-space separated
  * a classic PAT without it fails before pushing anything, naming the remedy
  * an EMPTY scope header means "no scopes granted", which is a missing scope,
    not an unreadable one — distinct from the header being absent entirely
  * a fine-grained PAT (no header) passes the preflight silently rather than
    being guessed at, and is caught at the push instead
  * the post-push guard replays the raw git rejection, so the git-level evidence
    is never swallowed
  * an unrelated push failure is NOT mislabelled as a scope problem, and its
    real cause still reaches the log
  * with no ``.github/workflows`` change to push, neither guard arms

The conflict classifier is covered too. A 3-way conflict keeps the fork's
version, which is correct for files the fork owns outright but silently drops
upstream's work for anything shared, so:

  * conflicts confined to fork-owned files are informational, not fatal
  * a conflict on shared code fails a real sync and names the files
  * a dry run only warns, so the merge can still be inspected

The guarded regions are cut out of the real script and sourced, so these cases
run the shipped code rather than a restatement of it.
"""

import os
import re
import shlex
import subprocess
import tempfile
import unittest

_SCRIPT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sync-dograh-fork.sh")
)

_REMEDY = "missing the 'workflow' scope"
_GENERIC = "failed to push the rebuilt fork"
_PUSHED = "pushed rebuilt fork"


def _between(start: str, stop: str) -> str:
    """Cut the lines from ``start`` up to, but not including, ``stop``."""
    with open(_SCRIPT, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    begin = next(i for i, ln in enumerate(lines) if re.search(start, ln))
    end = next(i for i, ln in enumerate(lines) if i > begin and re.search(stop, ln))
    return "\n".join(lines[begin:end]) + "\n"


# The guard/preflight block, and the push block it backs up. Both are cut whole
# up to the next top-level statement, so the success path is included too and a
# regression that made every push fail loudly would be visible here.
_GUARD_BLOCK = _between(r"^# The fork carries workflow files", r"Verifying rebuilt tree")
_PUSH_BLOCK = _between(r"^  push_log=", r"^else$")

# The conflict classifier, from the CONFLICTS assignment through the block that
# decides whether the conflict list is fatal.
_CONFLICT_BLOCK = _between(r'^CONFLICTS="\$\(sort', r"^echo \"── 3\.")

# A scope-header value means "this classic PAT reported its scopes"; None means
# the response carried no header at all, which is what a fine-grained PAT does.
_HEADERS = {
    "repo, workflow": "X-OAuth-Scopes: repo, workflow",
    "repo,workflow": "X-OAuth-Scopes: repo,workflow",
    "repo, gist": "X-OAuth-Scopes: repo, gist",
    "none": "X-OAuth-Scopes: ",
    None: "X-RateLimit-Limit: 5000",
}

# What the stubbed `git push` does. Only the failures matter: a healthy push is
# the baseline every other case is measured against.
_SCOPE_REJECTION = (
    " ! [remote rejected]   rebuilt -> main (refusing to allow a Personal Access"
    " Token to create or update workflow `.github/workflows/build-api-image.yml`"
    " without `workflow` scope)",
    "error: failed to push some refs to 'https://github.com/innotelinc/dograh.git'",
)
_OTHER_REJECTION = (
    " ! [rejected]   rebuilt -> main (fetch first)",
    "error: failed to push some refs",
)

_DRIVER = """\
set -uo pipefail
WORK="$(mktemp -d)"
PUSH=1
GH_TOKEN=stub-token
PUSH_URL=https://x-access-token:stub@github.com/innotelinc/dograh.git
FORK_REPO=innotelinc/dograh
UPSTREAM_HEAD=base
FORK_HEAD=forkhead

git() {{
  case "$1" in
    diff)
{files}      ;;
    rev-parse) echo abc1234 ;;
    push)
{push}      ;;
  esac
  return 0
}}

curl() {{
  printf 'HTTP/1.1 200 OK\\r\\n{headers}\\r\\n\\r\\n'
  return 0
}}

# --- guard/preflight block, straight from the script under test ---
{guard}
# --- push block, straight from the script under test ---
{push_block}
echo "__DONE__"
"""


class WorkflowScopeGuardTests(unittest.TestCase):
    """The guards must fire for a token that cannot push workflows, name the
    scope when they do, and stay out of the way otherwise."""

    def run_guard(self, header, push, workflows=".github/workflows/release.yml"):
        """Run the shipped guard and push blocks; return (returncode, output)."""
        files = f'      echo "{workflows}"; return 0' if workflows else "      return 0"
        if push is None:
            push_body = "      echo 'everything up-to-date'; return 0"
        else:
            # The real rejection text, backticks and all, so the guard matches on
            # exactly what git prints rather than a paraphrase of it.
            push_body = "\n".join(f"      echo {shlex.quote(line)}" for line in push)
            push_body += "\n      return 1"
        driver = _DRIVER.format(
            files=files,
            push=push_body,
            headers=_HEADERS[header],
            guard=_GUARD_BLOCK,
            push_block=_PUSH_BLOCK,
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "driver.sh")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(driver)
            proc = subprocess.run(
                ["bash", path], capture_output=True, text=True, timeout=60
            )
        return proc.returncode, proc.stdout + proc.stderr

    # ---- a token that is allowed to push workflows is left alone ----

    def test_classic_pat_with_workflow_scope_pushes(self):
        rc, out = self.run_guard("repo, workflow", None)
        self.assertEqual(rc, 0, out)
        self.assertNotIn(_REMEDY, out)
        self.assertIn(_PUSHED, out)

    def test_scope_list_without_a_space_is_still_a_match(self):
        # "repo,workflow" — a comma-space-blind split reads this as missing.
        rc, out = self.run_guard("repo,workflow", None)
        self.assertEqual(rc, 0, out)
        self.assertNotIn(_REMEDY, out)

    # ---- a classic PAT that cannot push workflows fails before pushing ----

    def test_classic_pat_without_workflow_scope_fails_before_pushing(self):
        rc, out = self.run_guard("repo, gist", None)
        self.assertEqual(rc, 1, out)
        self.assertIn(_REMEDY, out)
        self.assertNotIn(_PUSHED, out, "the sync must not spend a doomed push")
        self.assertIn("repo, gist", out, "the reported scopes should be echoed")

    def test_empty_scope_header_is_missing_not_unreadable(self):
        # Header present but empty == a classic PAT with no scopes at all.
        rc, out = self.run_guard("none", None)
        self.assertEqual(rc, 1, out)
        self.assertIn(_REMEDY, out)
        self.assertNotIn(_PUSHED, out)

    # ---- a fine-grained PAT is silent up front and caught at the push ----

    def test_fine_grained_pat_is_not_guessed_at_up_front(self):
        rc, out = self.run_guard(None, None)
        self.assertEqual(rc, 0, out)
        self.assertNotIn(_REMEDY, out, "no header is no evidence, not a missing scope")
        self.assertIn(_PUSHED, out)

    def test_fine_grained_pat_is_caught_by_the_push_rejection(self):
        rc, out = self.run_guard(None, _SCOPE_REJECTION)
        self.assertEqual(rc, 1, out)
        self.assertIn(_REMEDY, out)
        self.assertIn("refusing to allow a Personal Access Token", out)
        self.assertIn("build-api-image.yml", out, "the offending workflow should be named")

    # ---- and nothing else gets mistaken for it ----

    def test_unrelated_push_failure_stays_generic(self):
        rc, out = self.run_guard(None, _OTHER_REJECTION)
        self.assertEqual(rc, 1, out)
        self.assertIn(_GENERIC, out)
        self.assertIn("fetch first", out, "the real cause must reach the log")
        self.assertNotIn(_REMEDY, out, "a non-scope failure must not name the scope")

    def test_guards_stay_disarmed_without_a_workflow_change(self):
        # Nothing under .github/workflows differs, so the preflight must not
        # claim a missing scope — even for a token that has none.
        rc, out = self.run_guard("repo, gist", None, workflows="")
        self.assertEqual(rc, 0, out)
        self.assertNotIn(_REMEDY, out)
        self.assertIn(_PUSHED, out)

    # ---- conflict classification ----

    def run_conflicts(self, files, push=1):
        """Run the shipped conflict classifier with a fixed conflict list."""
        driver = "\n".join(
            [
                "set -uo pipefail",
                f"CONFLICTS_FILE=$(mktemp)",
                f"PUSH={push}",
            ]
            + [f"echo {shlex.quote(f)} >> \"$CONFLICTS_FILE\"" for f in files]
            + [_CONFLICT_BLOCK, 'echo "__DONE__"']
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "conflicts.sh")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(driver)
            proc = subprocess.run(
                ["bash", path], capture_output=True, text=True, timeout=60
            )
        return proc.returncode, proc.stdout + proc.stderr

    def test_fork_owned_conflicts_are_not_fatal(self):
        # The exact list the last real sync produced, minus the dead file that
        # has since been deleted from the fork. Keeping the fork's copy of all
        # of these IS the sync, so a real run must still succeed.
        rc, out = self.run_conflicts(
            [
                ".release-please-manifest.json",
                "CHANGELOG.md",
                "README.md",
                "api/pyproject.toml",
                "ui/package.json",
            ]
        )
        self.assertEqual(rc, 0, out)
        self.assertIn("__DONE__", out)
        self.assertNotIn("FATAL", out)

    def test_shared_code_conflict_fails_a_real_sync(self):
        rc, out = self.run_conflicts(
            ["README.md", "api/services/pipecat/recording_router_processor.py"]
        )
        self.assertEqual(rc, 1, out)
        self.assertIn("FATAL", out)
        self.assertIn("recording_router_processor.py", out, "the file must be named")
        self.assertIn("merge them by hand", out.lower(), "the remedy must be stated")

    def test_shared_code_conflict_only_warns_on_a_dry_run(self):
        rc, out = self.run_conflicts(["src/shared.py"], push=0)
        self.assertEqual(rc, 0, msg=f"a dry run must not fail; it is for inspecting\n{out}")
        self.assertIn("WARNING", out)
        self.assertNotIn("FATAL", out)

    def test_a_fork_owned_name_is_not_matched_by_prefix(self):
        # The pattern is anchored, so a path that merely contains a fork-owned
        # name is still treated as shared code.
        rc, out = self.run_conflicts(["docs/CHANGELOG.md"])
        self.assertEqual(rc, 1, out)
        self.assertIn("FATAL", out)

    def test_script_still_carries_both_guards(self):
        # Cheap regression on the extraction itself: if either guard is dropped
        # from the script, these cases would otherwise pass on a stale block.
        with open(_SCRIPT, encoding="utf-8") as fh:
            body = fh.read()
        self.assertIn("workflow_scope_fatal()", body)
        self.assertIn("refusing to allow a Personal Access Token", body)


if __name__ == "__main__":
    unittest.main()