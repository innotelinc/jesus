#!/usr/bin/env python3
"""check-dograh-image-drift.py — prove the running dograh images came from this tree.

dograh/upstream is a gitignored clone of innotelinc/dograh, which carries our
customizations as commits. Nothing stops the stack from running
something else, and the incident this guards against is exactly that: a stack
serving the registry's ghcr.io images — which carry none of those commits —
while every file in the repo says otherwise. The configuration reads the same
either way, so the images themselves are the only thing that can answer.

What is compared, and why it is not uniform:

  • api/** and pipecat/** are plain files in dograh-api (the API image copies
    the tree to /app and pip-installs pipecat from the submodule), so their
    sha256 in the running container must equal the sha256 of the fork's tree in
    dograh/upstream — an exact comparison.

  • ui/** is compiled into .next/, so there is no source to hash. The UI image
    is asked instead for the two things the OIDC fix changes in its *compiled*
    output: the home page carries the new OIDC branch, and the workflow page no
    longer renders the pre-fix dead end. (The build-only cache cap leaves no
    runtime artifact to look for.)

Exit codes, matching scripts/ci/sso-smoke.py: 0 = the images carry our tree,
1 = drift, 2 = cannot run (no clone, no docker, or the containers are not
running here) — which is a SKIP, not a pass.

    python3 scripts/ci/check-dograh-image-drift.py

What is inspected is a compose *service* name, and which container that became
depends on the layout: `dograh-api` where the compose file sets container_name,
`dograh-api-1` where the voice platform runs as its own project. The name is
resolved here (see locate()) so a split-project host does not SKIP a check that
could have run. Override with DOGRAH_API_CONTAINER / DOGRAH_UI_CONTAINER, which
are taken as given.
"""

from __future__ import annotations

import hashlib
import os
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
UPSTREAM = REPO / "dograh" / "upstream"

# The compose service names this check wants. main() resolves each to the
# container it became, so these are not what should be inspected.
API_SERVICE = os.environ.get("DOGRAH_API_CONTAINER", "dograh-api")
UI_SERVICE = os.environ.get("DOGRAH_UI_CONTAINER", "dograh-ui")
API_CONTAINER = API_SERVICE  # replaced by the resolved name in main()
UI_CONTAINER = UI_SERVICE

# The API image's WORKDIR; the repo is copied in whole, so a path our delta
# touches is /app/<path>. pipecat is installed as a package instead, so its root
# is asked of the interpreter that actually holds it rather than assumed.
API_APP_ROOT = "/app"
PIPECAT_TOP = "pipecat/"
PIPECAT_PACKAGE = "pipecat"
# Inside the pipecat submodule the importable package is ``src/pipecat``, which
# the API image installs as the ``pipecat`` package — so that subpath is dropped
# when mapping one of our paths onto the installed one.
PIPECAT_PACKAGE_SUBPATH = "src/pipecat/"

# The OIDC fix (patch 0001 in the old series, a fork commit now), as it survives
# into the compiled UI the image serves. The markers are the compiled form of
# its own lines: the home page's new branch (ui/src/app/page.tsx) and the
# workflow page's removed dead end (ui/src/app/workflow/page.tsx). A source hash
# cannot reach either — .next/ holds a build, not the sources — so the image is
# asked about its output.
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


def resolve_container(service: str) -> str:
    """The running container `service` became, or "" when there is none.

    Standalone compose sets container_name, so the container is `dograh-api`;
    this deployment runs the voice platform as its own project, where compose
    appends the replica suffix and it is `dograh-api-1`. The compose service
    label cannot answer this: upstream names its services `api` and `ui`, so the
    label reads the same in both layouts while the container name is what
    changes (scripts/doctor-signin.sh makes the same note). Last resort is the
    image a service builds, which is named after the service.
    """
    for candidate in (service, f"{service}-1"):
        if container_running(candidate):
            return candidate
    out = docker(["ps", "--format", "{{.Names}}\t{{.Image}}"])
    if out is None or out.returncode != 0:
        return ""
    for line in out.stdout.splitlines():
        name, _, image = line.strip().partition("\t")
        if image.rsplit("/", 1)[-1].split(":", 1)[0] == service and container_running(name):
            return name
    return ""


def locate(service: str, override: str | None) -> str:
    """What this check should inspect for `service`.

    An explicit override is taken as given: a typo then SKIPs loudly rather than
    quietly inspecting a container the operator did not ask about.
    """
    if override:
        return override
    return resolve_container(service) or service


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


# The fork carries our customizations as commits on main. The files to compare
# are whatever those commits changed relative to the upstream they sit on top
# of, which is the same question the old patch files answered by reading
# `+++ b/` lines.
#
#   dograh/upstream            <- the fork's clone
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


def delta_paths() -> tuple[dict[str, list[str]], list[str], list[str]]:
    """Our delta against upstream/main, split by what can actually be compared.

    Returns (files to compare, paths our commits removed, paths upstream added
    since our clone's base).

    Deletions are not candidate files: the tree does not have them, so there is
    nothing to hash — and hashing one anyway is what CRASHED this check on
    `api/alembic/versions/c82d4f6a9b10_…` (a file upstream added a week after
    our clone's base, which `upstream/main..HEAD` therefore reports as a
    deletion of ours; 31 such paths, measured on 16 Oct 2026). The merge-base
    separates the two cases: a removed path that existed at the base is ours and
    the images must NOT carry it, one that did not exist was upstream's.
    """
    if not (UPSTREAM / ".git").is_dir():
        return {}, [], []

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
        return {}, [], []

    revs = [f"{base}..HEAD"]
    if base == SYNC_BASE:
        # Also catch customizations that landed on origin/main but are not in
        # this clone yet, so a stale clone cannot pass.
        revs.append(f"{SYNC_BASE}..origin/main")

    touched: dict[str, list[str]] = {}
    removed: set[str] = set()
    for rev in revs:
        out = git("diff", "--name-status", rev).stdout
        for line in out.splitlines():
            status, _, path = line.partition("\t")
            path = path.strip()
            if not path.startswith(CODE_PREFIXES):
                continue
            if status.strip().startswith("D"):
                removed.add(path)
            else:
                touched.setdefault(path, []).append("our delta")

    # A removed path has to be judged against where the two lines DIVERGED, not
    # against the moving ref: `upstream/main` keeps gaining files, and every one
    # of them is a deletion in `upstream/main..HEAD` that our tree never held.
    # (Measured 16 Oct 2026: 21 of the 31, all added by upstream's #883/#886
    # after the merge-base — the reason this check crashed instead of answering.)
    divergence = git("merge-base", base, "HEAD").stdout.strip() or base
    ours_removed = sorted(
        p for p in removed if git("cat-file", "-e", f"{divergence}:{p}").returncode == 0
    )
    upstream_new = sorted(p for p in removed if p not in set(ours_removed))
    return touched, ours_removed, upstream_new


def exec_missing(container: str, paths: list[str]) -> set[str]:
    """The subset of `paths` the image does NOT have (they were removed)."""
    if not paths:
        return set()
    script = "for p in " + " ".join(f"'{p}'" for p in paths) + "; do [ -e \"$p\" ] || echo \"$p\"; done"
    out = docker(["exec", container, "sh", "-lc", script])
    if out is None:
        return set()
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


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


def delta_labels(names: list[str]) -> str:
    """Where a file's change comes from, for the report — currently always our delta."""
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

    touched, ours_removed, upstream_new = delta_paths()
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
        print("SKIP: our delta touches files this check has no image mapping for: "
              + ", ".join(sorted(unknown))
              + " — teach scripts/ci/check-dograh-image-drift.py where the image carries them",
              file=sys.stderr)
        return 2

    # Resolve the service names before anything is inspected: on a split-project
    # host the containers are `-1` replicas, and SKIPping there is what made this
    # check look like a pass that never ran.
    global API_CONTAINER, UI_CONTAINER
    API_CONTAINER = locate(API_SERVICE, os.environ.get("DOGRAH_API_CONTAINER"))
    UI_CONTAINER = locate(UI_SERVICE, os.environ.get("DOGRAH_UI_CONTAINER"))
    for service, container in ((API_SERVICE, API_CONTAINER), (UI_SERVICE, UI_CONTAINER)):
        if container != service:
            print(f"  note  {service} resolved to the container '{container}'")

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
        labels = delta_labels(api_files[path])
        if got == want:
            print(f"  ok    {API_CONTAINER}:{dest}  ({labels})")
        else:
            why = ("not in the image" if got is None
                   else f"{got[:12]}… != {want[:12]}…")
            print(f"  DRIFT {API_CONTAINER}:{dest}  ({labels}) — {why}", file=sys.stderr)
            drift += 1

    # ── files our delta REMOVED: the images must not carry them ──────────────
    # api/** only: those map onto /app/<path> one-for-one. pipecat is installed
    # as a package (a removed source file would be absent from the installed
    # one too) and ui/** has no source mapping at all, so both are reported
    # rather than asserted.
    removed_api = [f"{API_APP_ROOT}/{p}" for p in ours_removed if p.startswith("api/")]
    still_present = exec_missing(API_CONTAINER, removed_api) if removed_api else set()
    for dest in removed_api:
        path = dest[len(API_APP_ROOT) + 1:]
        if dest in still_present:
            print(f"  DRIFT {API_CONTAINER}:{dest} — our delta removes this file and the image "
                  "still carries it (a build from a tree that predates the removal)", file=sys.stderr)
            drift += 1
        else:
            print(f"  ok    {API_CONTAINER}:{dest}  (removed by our delta, absent as built)")
    for path in [p for p in ours_removed if not p.startswith("api/")]:
        print(f"  note  {path} is removed by our delta; not asserted (no image mapping)")
    if upstream_new:
        print(f"  note  {len(upstream_new)} file(s) upstream added after our clone's base "
              f"({upstream_new[0]}…) are not part of our delta — not compared")

    # ── dograh-ui: the compiled artifacts the OIDC fix changes ───────────────
    home = exec_read(UI_CONTAINER, UI_HOME_ARTIFACT)
    if home is None:
        print(f"  DRIFT {UI_CONTAINER}:{UI_HOME_ARTIFACT} — not in the image (the compiled "
              "home page, which the OIDC fix changes)", file=sys.stderr)
        drift += 1
    elif UI_HOME_MARKER in home:
        print(f"  ok    {UI_CONTAINER}:{UI_HOME_ARTIFACT}  (the OIDC fix)")
    else:
        print(f"  DRIFT {UI_CONTAINER}:{UI_HOME_ARTIFACT} — the pre-fix home page: this image "
              "was built from a tree without the fork's OIDC commit (a registry tag cannot "
              "carry it)", file=sys.stderr)
        drift += 1

    workflow = exec_read(UI_CONTAINER, UI_WORKFLOW_ARTIFACT)
    if workflow is None:
        print(f"  DRIFT {UI_CONTAINER}:{UI_WORKFLOW_ARTIFACT} — not in the image (the compiled "
              "page the smoke test probes)", file=sys.stderr)
        drift += 1
    elif UI_WORKFLOW_DEAD_END in workflow:
        print(f"  DRIFT {UI_CONTAINER}:{UI_WORKFLOW_ARTIFACT} — still renders the pre-fix dead "
              f"end ({UI_WORKFLOW_DEAD_END!r})", file=sys.stderr)
        drift += 1
    else:
        print(f"  ok    {UI_CONTAINER}:{UI_WORKFLOW_ARTIFACT}  (the OIDC fix)")

    print()
    if drift:
        print(f"FAIL: {drift} artifact(s) in the running images do not match the tree they "
              "were built from — rebuild and re-ship (docker-compose.dograh-build.yml)",
              file=sys.stderr)
        return 1
    print(f"PASS the running dograh images carry the fork's tree "
          f"({len(destinations)} file(s) hashed + the compiled UI markers)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
