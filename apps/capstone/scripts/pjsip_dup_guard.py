#!/usr/bin/env python3
"""Disable pjsip custom sections that duplicate a generated object.

Why this exists: `pbx/entrypoint-dograh.sh` appends its WebRTC AOR/endpoint
block to `pjsip.aor_custom.conf` and `pjsip.endpoint_custom.conf` on every
boot, and `pjsip.aor.conf` / `pjsip.endpoint.conf` already `#include` those
files and define the same `[101]` object.  Asterisk then refuses the whole
`pjsip.conf` — "configuration contains a duplicate object" — which silently
drops *every* pjsip object: no endpoints, no auth object, and a trunk that
answers 401 to its own REGISTER.

The generated files are rebuilt by `fwconsole reload`, so the duplicate is
removed here from the custom (hand-editable) side and pjsip is reloaded.  The
run is idempotent: a second pass finds nothing to do and stays quiet.

Usage: pjsip_dup_guard.py [--dry-run] [--volume DIR] [--container NAME]
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_CONTAINER = "freepbx-qvifit87vftfxd9ejsch2vxy"
PAIRS = ("aor", "endpoint", "auth")

SECTION = re.compile(r"^\[([^\]]+)\]")


def ids_in(path: Path) -> set[str]:
    """Section ids defined by a parrot file, ignoring commented-out ones."""
    if not path.is_file():
        return set()
    out: set[str] = set()
    for line in path.read_text(errors="replace").splitlines():
        match = SECTION.match(line.strip())
        if match:
            out.add(match.group(1))
    return out


def disable(path: Path, duplicates: set[str]) -> int:
    """Comment out whole sections whose id is in `duplicates`. Returns count."""
    lines = path.read_text(errors="replace").split("\n")
    out: list[str] = []
    skip = False
    disabled = 0
    for line in lines:
        stripped = line.strip()
        match = SECTION.match(stripped)
        if match:
            # A re-definition also carries an inheritance suffix, e.g. [101](x).
            name = match.group(1)
            skip = name in duplicates
            if skip:
                disabled += 1
                out.append(f"; pjsip-dup-guard: duplicate of generated [{name}]: {line}")
                continue
        if skip:
            out.append(f"; {line}" if stripped else line)
            continue
        out.append(line)
    if disabled:
        path.write_text("\n".join(out))
    return disabled


def resolve_volume(container: str) -> Path | None:
    """Host path behind the container's /etc/asterisk.

    Coolify names service volumes `<service>_<service>-asterisk-config`, and the
    prefix has changed shape before, so the path is looked up rather than
    hardcoded — a stale path means the guard silently guards nothing.
    """
    try:
        done = subprocess.run(
            ["docker", "inspect", container, "--format",
             "{{range .Mounts}}{{.Destination}}={{.Source}}{{\"\\n\"}}{{end}}"],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in done.stdout.splitlines():
        dest, _, source = line.partition("=")
        if dest == "/etc/asterisk" and source:
            return Path(source)
    return None


def reload_pjsip(container: str) -> tuple[bool, str]:
    try:
        done = subprocess.run(
            ["docker", "exec", container, "asterisk", "-rx",
             "module reload res_pjsip.so"],
            capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover
        return False, str(exc)
    text = (done.stdout + done.stderr).strip().splitlines()
    return done.returncode == 0, text[-1] if text else "no output"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--volume", type=Path)
    parser.add_argument("--container", default=DEFAULT_CONTAINER)
    args = parser.parse_args()

    if args.volume is None:
        args.volume = resolve_volume(args.container)
        if args.volume is None:
            print(f"no /etc/asterisk mount found on {args.container}", file=sys.stderr)
            return 2

    total = 0
    for kind in PAIRS:
        generated = args.volume / f"pjsip.{kind}.conf"
        custom = args.volume / f"pjsip.{kind}_custom.conf"
        duplicates = ids_in(generated) & ids_in(custom)
        if not duplicates:
            continue
        names = ", ".join(sorted(duplicates))
        if args.dry_run:
            print(f"would disable {custom.name}: {names}")
            total += len(duplicates)
            continue
        disabled = disable(custom, duplicates)
        if disabled:
            print(f"disabled {disabled} duplicate section(s) in {custom.name}: {names}")
            total += disabled

    if not total:
        return 0
    if args.dry_run:
        return 0
    ok, detail = reload_pjsip(args.container)
    print(f"pjsip reload: {'ok' if ok else 'FAILED'} — {detail}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
