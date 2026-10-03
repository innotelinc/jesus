#!/usr/bin/env python3
"""check-dograh-image-drift.py — prove the running dograh images came from this tree.

dograh/upstream is a gitignored clone of innotelinc/dograh, which carries our
customizations as commits. Nothing stops the stack from running
something else, and the incident this guards against is exactly that: a stack
serving the registry's ghcr.io images — which carry none of the patches — while
every file in the repo says otherwise. The configuration reads the same either
way, so the images themselves are the only thing that can answer.

What is compared, and why it is not uniform:

  • api/** and pipecat/** are plain files in dograh-api (the API image copies
    the tree to /app and pip-installs pipecat from the submodule), so their
    sha256 in the running container must equal the sha256 of the patched
    upstream tree — an exact comparison.

  • ui/** is compiled into .next/, so there is no source to hash. The UI image
    is asked instead for the two things patch 0001 changes in its *compiled*
    output: the home page carries the new OIDC branch, and the workflow page no
    longer renders the pre-patch dead end. (0007 is a build-only change — a cap
    on webpack's in-memory cache — with no runtime artifact to look for.)

Exit codes, matching scripts/ci/sso-smoke.py: 0 = the images carry our tree,
1 = drift, 2 = cannot run (no clone, no docker, or the containers are not
running here) — which is a SKIP, not a pass.

    python3 scripts/ci/check-dograh-image-drift.py

The container names are the compose service names; override them with
DOGRAH_API_CONTAINER / DOGRAH_UI_CONTAINER when the stack is named otherwise.
"""

from __future__ import annotations

import hashlib
import os
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
UPSTREAM = REPO / "dograh" / "upstream"
PATCH_DIR = REPO / "dograh" / "patches"
PATCH_SCRIPT = REPO / "scripts" / "apply-dograh-patches.sh"

API_CONTAINER = os.environ.get("DOGRAH_API_CONTAINER", "dograh-api")
UI_CONTAINER = os.environ.get("DOGRAH_UI_CONTAINER", "dograh-ui")

# The API image's WORKDIR; the repo is copied in whole, so a patch path is
# /app/<path>. pipecat is installed as a package instead, so its root is asked
# of the interpreter that actually holds it rather than assumed.
API_APP_ROOT = "/app"
PIPECAT_TOP = "pipecat/"
PIPECAT_PACKAGE = "pipecat"
# Inside the pipecat submodule the importable package is ``src/pipecat``, which
# the API image installs as the ``pipecat`` package — so that subpath is dropped
# when mapping a patch path onto the installed one.
PIPECAT_PACKAGE_SUBPATH = "src/pipecat/"

# Patch 0001, as it survives into the compiled UI the image serves. The markers
# are the compiled form of the patch's own lines: the home page's new branch
# (ui/src/app/page.tsx) and the workflow page's removed dead end
# (ui/src/app/workflow/page.tsx). A source hash cannot reach either — .next/
# holds a build, not the sources — so the image is asked about its output.
UI_HOME_ARTIFACT = "/app/.next/server/app/page.js"
UI_HOME_MARKER = "[HomePage] Local/OIDC provider detected"
UI_WORKFLOW_ARTIFACT = "/app/.next/server/app/workflow/page.js"
UI_WORKFLOW_DEAD_END = "Authentication required"


def docker(args: list[str]) -> subprocess.CompletedProcess[str] | None:
    """Run a docker command, or None when docker itself is unavailable."""
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True)
    except OSError:
        return None


def container_running(name: str) -> bool:
    """True only when `name` is a running container this host can inspect."""
    out = docker(["inspect", "-f", "{{.State.Running}}", name])
    return out is not None and out.returncode == 0 and out.stdout.strip() == "true"


def resolve_pipecat_root(container: str) -> str:
    """The installed pipecat package's directory inside `container`, or "".

    The API image installs pipecat into a virtualenv that is not the default
    interpreter, so each candidate is asked to import it. The package logs its
    banner on stderr, which is why only stdout is read.
    """
    one_liner = (
        f"import {PIPECAT_PACKAGE},os;print(os.path.dirname({PIPECAT_PACKAGE}.__file__))"
    )
    script = (
        "for p in /opt/venv/bin/python /opt/venv/bin/python3 python3 python; do "
        f'd=$($p -c \'{one_liner}\' 2>/dev/null) && [ -n "$d" ] && {{ echo "$d"; break; }}; '
        "done"
    )
    out = docker(["exec", container, "sh", "-lc", script])
    if out is None or out.returncode != 0:
        return ""
    lines = [line.strip() for line in out.stdout.splitlines() if line.strip()]
    return lines[-1] if lines else ""


# The fork carries our customizations as commits on main, not as patches. The
# files to compare are whatever those commits changed relative to the upstream
# they sit on top of, which is the same question the patches used to answer by
# reading `+++ b/` lines.
#
#   dograh/upstream            <- the fork's clone
#   dograh/patches/            <- gone; the delta is in git history now
#   upstream/main              <- the author's tree we rebase onto
#
# Comparing against `upstream/main` rather than the merge-base keeps this correct
# after a sync: a file upstream changed AND we changed is ours to compare, and a
# file only upstream changed is not part of our delta at all.
SYNC_BASE = "upstream/main"

# The customizations are one commit. Diffing against upstream/main also picks up
# the fork's deployment/docs layer (deploy/**, ABOUT.md, workflows), which lives
# in the repo and not in either image, so scoping to the commits that touch code
# is what keeps this comparing files the images actually carry.
CODE_PREFIXES = ("api/", "ui/", "pipecat/")


def touched_paths() -> dict[str, list[str]]:
    """{repo-relative path: [commit subject, ...]} for every file our delta touches."""
    if not (UPSTREAM / ".git").is_dir():
        return {}

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(UPSTREAM), *args],
            capture_output=True, text=True, check=False,
        )

    base = ""
    if git("rev-parse", "--verify", SYNC_BASE).returncode == 0:
        base = SYNC_BASE
    else:
        # No upstream remote fetched (setup.sh clones with --depth 1 and does not
        # add one). Fall back to the merge-base with origin/main, which is where
        # our delta starts either way.
        base = git("merge-base", "origin/main", "HEAD").stdout.strip()
    if not base:
        # Without a base there is no delta to compare, and returning {} here made
        # the caller report PASS while hashing nothing -- a false pass on the one
        # check whose whole job is to notice a mismatch.
        return {}

    revs = [f"{base}..HEAD"]
    if base == SYNC_BASE:
        # Also catch customizations that landed on origin/main but are not in
        # this clone yet, so a stale clone cannot pass.
        revs.append(f"{SYNC_BASE}..origin/main")

    touched: dict[str, list[str]] = {}
    for rev in revs:
        out = git("diff", "--name-only", rev).stdout
        for line in out.splitlines():
            path = line.strip()
            if path.startswith(CODE_PREFIXES):
                touched.setdefault(path, []).append("our delta")
    return touched


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exec_sha256(container: str, paths: list[str]) -> dict[str, str]:
    """{container path: sha256} for the paths that exist; missing ones are absent.

    A path the image does not have makes sha256sum warn on stderr and exit
    non-zero while still printing the rest, so a missing file is simply a path
    that is not in the result — which is drift, not an error to raise.
    """
    out = docker(["exec", container, "sha256sum", *sorted(paths)])
    if out is None:
        return {}
    hashes: dict[str, str] = {}
    for line in out.stdout.splitlines():
        digest, _, path = line.partition("  ")
        if digest and path:
            hashes[path.strip()] = digest.strip()
    return hashes


def exec_read(container: str, path: str) -> str | None:
    """The file's bytes as text, or None when the image does not have it."""
    out = docker(["exec", container, "cat", path])
    if out is None or out.returncode != 0:
        return None
    return out.stdout


def patch_labels(names: list[str]) -> str:
    """The patch numbers that touch a file, for the report: [0004, 0006] → `0004, 0006`."""
    return ", ".join(name.split("-", 1)[0] for name in sorted(set(names)))


def main() -> int:
    print("dograh image drift — the running images against the fork tree in dograh/upstream\n")

    if not (UPSTREAM / ".git").is_dir():
        print("SKIP: dograh/upstream is not cloned, so there is no tree to compare "
              "against (scripts/setup.sh clones it)", file=sys.stderr)
        return 2

    # Nothing to pre-apply any more: the clone IS the fork's tree, customizations
    # included. A clone that predates the sync would simply have fewer files to
    # compare, so report that as a skip rather than a false pass.
    head = subprocess.run(
        ["git", "-C", str(UPSTREAM), "log", "--format=%h %s", "-1"],
        capture_output=True, text=True, check=False,
    ).stdout.strip()
    print(f"comparing against dograh/upstream @ {head or 'unknown'}")

    touched = touched_paths()
    if not touched:
        # An empty delta means we could not work out what our customizations are,
        # so there is nothing to compare. Reporting PASS here would be the exact
        # false pass this check exists to prevent.
        print("SKIP: no baseline to diff our customizations against, so there is "
              "nothing to compare — fetch the upstream remote in dograh/upstream "
              "(git remote add upstream https://github.com/dograh-hq/dograh.git && "
              "git fetch upstream) or re-clone it", file=sys.stderr)
        return 2
    api_files = {p: n for p, n in touched.items()
                 if p.split("/", 1)[0] in ("api", PIPECAT_PACKAGE)}
    ui_files = {p: n for p, n in touched.items() if p.split("/", 1)[0] == "ui"}
    unknown = {p: n for p, n in touched.items() if p not in api_files and p not in ui_files}
    if unknown:
        print("SKIP: the patch set touches files this check has no image mapping for: "
              + ", ".join(sorted(unknown))
              + " — teach scripts/ci/check-dograh-image-drift.py where the image carries them",
              file=sys.stderr)
        return 2

    if not (container_running(API_CONTAINER) and container_running(UI_CONTAINER)):
        print(f"SKIP: cannot inspect the running images ({API_CONTAINER} / {UI_CONTAINER} are "
              "not running here, or there is no docker) — a runner with a route to the stack "
              "is what turns this into a gate", file=sys.stderr)
        return 2

    drift = 0

    # ── dograh-api: exact file hashes ────────────────────────────────────────
    pipecat_root = ""
    if any(path.startswith(PIPECAT_TOP) for path in api_files):
        pipecat_root = resolve_pipecat_root(API_CONTAINER)
    destinations: dict[str, str] = {}  # container path -> repo path
    for path in sorted(api_files):
        if path.startswith(PIPECAT_TOP):
            if not pipecat_root:
                print(f"DRIFT pipecat is not installed as a module in {API_CONTAINER}, so the "
                      f"patched file {path} cannot be there", file=sys.stderr)
                drift += 1
                continue
            relative = path[len(PIPECAT_TOP):]
            if relative.startswith(PIPECAT_PACKAGE_SUBPATH):
                relative = relative[len(PIPECAT_PACKAGE_SUBPATH):]
            destinations[f"{pipecat_root}/{relative}"] = path
        else:
            destinations[f"{API_APP_ROOT}/{path}"] = path

    # Only ask for a digest when there is a file to ask about: `sha256sum` with
    # no operand reads stdin and would hang the check.
    in_image = exec_sha256(API_CONTAINER, list(destinations)) if destinations else {}
    for dest, path in sorted(destinations.items(), key=lambda kv: kv[1]):
        want = sha256_file(UPSTREAM / path)
        got = in_image.get(dest)
        labels = patch_labels(api_files[path])
        if got == want:
            print(f"  ok    {API_CONTAINER}:{dest}  ({labels})")
        else:
            why = ("not in the image" if got is None
                   else f"{got[:12]}… != {want[:12]}…")
            print(f"  DRIFT {API_CONTAINER}:{dest}  ({labels}) — {why}", file=sys.stderr)
            drift += 1

    # ── dograh-ui: the compiled artifacts patch 0001 changes ─────────────────
    home = exec_read(UI_CONTAINER, UI_HOME_ARTIFACT)
    if home is None:
        print(f"  DRIFT {UI_CONTAINER}:{UI_HOME_ARTIFACT} — not in the image (the compiled "
              "home page patch 0001 changes)", file=sys.stderr)
        drift += 1
    elif UI_HOME_MARKER in home:
        print(f"  ok    {UI_CONTAINER}:{UI_HOME_ARTIFACT}  (0001)")
    else:
        print(f"  DRIFT {UI_CONTAINER}:{UI_HOME_ARTIFACT} — the pre-0001 home page: this image "
              "predates dograh/patches/0001 (a registry tag cannot carry it)", file=sys.stderr)
        drift += 1

    workflow = exec_read(UI_CONTAINER, UI_WORKFLOW_ARTIFACT)
    if workflow is None:
        print(f"  DRIFT {UI_CONTAINER}:{UI_WORKFLOW_ARTIFACT} — not in the image (the compiled "
              "page the smoke test probes)", file=sys.stderr)
        drift += 1
    elif UI_WORKFLOW_DEAD_END in workflow:
        print(f"  DRIFT {UI_CONTAINER}:{UI_WORKFLOW_ARTIFACT} — still renders the pre-0001 dead "
              f"end ({UI_WORKFLOW_DEAD_END!r})", file=sys.stderr)
        drift += 1
    else:
        print(f"  ok    {UI_CONTAINER}:{UI_WORKFLOW_ARTIFACT}  (0001)")

    print()
    if drift:
        print(f"FAIL: {drift} patched artifact(s) in the running images do not match the tree "
              "they were built from — rebuild and re-ship (docker-compose.dograh-build.yml)",
              file=sys.stderr)
        return 1
    print(f"PASS the running dograh images carry the patched tree "
          f"({len(destinations)} file(s) hashed + the compiled UI patch-0001 markers)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
