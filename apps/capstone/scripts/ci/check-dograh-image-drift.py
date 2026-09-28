#!/usr/bin/env python3
"""check-dograh-image-drift.py — prove the running dograh images came from this tree.

dograh/upstream is gitignored and this repo's fixes to it live in
dograh/patches/, applied at build time. Nothing stops the stack from running
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

Exit codes, matching scripts/ci/sso-smoke.py: 0 = the images carry the patched
tree, 1 = drift, 2 = cannot run (no clone, no docker, or the containers are not
running here) — which is a SKIP, not a pass.

    ./scripts/apply-dograh-patches.sh              # make upstream the patched tree
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


def touched_paths() -> dict[str, list[str]]:
    """{repo-relative path: [patch name, ...]} for every file the patch set touches."""
    touched: dict[str, list[str]] = {}
    for patch in sorted(PATCH_DIR.glob("*.patch")):
        for line in patch.read_text().splitlines():
            if line.startswith("+++ b/"):
                touched.setdefault(line[6:].strip(), []).append(patch.name)
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
    print("dograh image drift — the running images against dograh/upstream + dograh/patches/\n")

    if not (UPSTREAM / ".git").is_dir():
        print("SKIP: dograh/upstream is not cloned, so there is no patched tree to compare "
              "against (scripts/setup.sh clones it)", file=sys.stderr)
        return 2

    check = subprocess.run([str(PATCH_SCRIPT), "--check"], capture_output=True, text=True)
    if check.returncode != 0:
        print("SKIP: dograh/upstream is not the patched tree — run "
              "./scripts/apply-dograh-patches.sh first, then this check", file=sys.stderr)
        sys.stderr.write(check.stdout)
        return 2

    touched = touched_paths()
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
