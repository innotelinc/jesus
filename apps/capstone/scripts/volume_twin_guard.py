#!/usr/bin/env python3
"""Fail loudly when the live copy of a stateful volume came up empty.

Coolify names every service volume twice — `<uuid>_<name>` and
`<uuid>_<uuid>-<name>` — and a re-render can move a service from one twin to the
other between deploys. The empty twin does not announce itself: the container
starts, the healthcheck passes, and the only symptom is missing data (zero
devices in FreePBX, no model configuration in dograh, a TTS cache that silently
re-synthesises every greeting).

This compares each pair by apparent size and shouts when the live twin (the
dash form, the one the running stack mounts) is a fraction of its sibling. It
only reads: the repair is a copy, documented in docs/operations.md.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_UUID = "qvifit87vftfxd9ejsch2vxy"
DEFAULT_ROOT = "/var/lib/docker/volumes"
# A twin under 1 MiB is "empty" for our purposes; below that the comparison is
# noise (an 8 KiB redis volume next to a 4 KiB one is not a lost database).
MIN_INTERESTING = 1024 * 1024
# Volumes whose size says nothing about state: rotated logs, and the git
# checkout (the live one is a --depth 1 clone, so it is legitimately smaller
# than a full-history sibling — flagging that would teach everyone to ignore
# this check).
CHURN = ("-logs", "-repo")
# Volumes where a difference is worth printing but not worth failing on: the
# spool (voicemail) legitimately drains, and the question "did we lose mail?"
# is answered by listening to it, not by a byte count.
SOFT = ("-spool",)


def tree_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                st = os.lstat(os.path.join(root, name))
            except OSError:
                continue
            total += st.st_size
    return total


def pairs(root: str, uuid: str) -> dict[str, dict[str, str]]:
    """Group volume directories by base name: {"mariadb-data": {"live": …, "old": …}}."""
    grouped: dict[str, dict[str, str]] = {}
    try:
        names = os.listdir(root)
    except OSError as e:
        raise SystemExit(f"cannot read {root}: {e}")
    for entry in names:
        if not entry.startswith(uuid + "_"):
            continue
        rest = entry[len(uuid) + 1 :]
        if rest.startswith(uuid + "-"):
            base, kind = rest[len(uuid) + 1 :], "live"
        else:
            base, kind = rest, "old"
        grouped.setdefault(base, {})[kind] = os.path.join(root, entry, "_data")
    return grouped


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--uuid", default=DEFAULT_UUID, help="Coolify service uuid")
    p.add_argument("--volumes-root", default=DEFAULT_ROOT, help="docker volumes dir")
    p.add_argument(
        "--ratio",
        type=float,
        default=0.5,
        help="shout when the live twin is below this fraction of its sibling",
    )
    p.add_argument(
        "--min-bytes",
        type=int,
        default=MIN_INTERESTING,
        help="ignore pairs where neither twin reaches this size",
    )
    p.add_argument("--json", action="store_true", help="machine-readable output")
    args = p.parse_args()

    grouped = pairs(args.volumes_root, args.uuid)
    if not grouped:
        raise SystemExit(f"no volumes for {args.uuid} under {args.volumes_root}")

    findings = []
    for base in sorted(grouped):
        twins = grouped[base]
        live, old = twins.get("live"), twins.get("old")
        live_size = tree_size(live) if live else 0
        old_size = tree_size(old) if old else 0
        if any(base.endswith(suffix) for suffix in CHURN):
            continue
        state = "pair"
        if live is None or old is None:
            state = "unpaired"
        elif max(live_size, old_size) < args.min_bytes:
            state = "empty-both"
        elif old_size >= args.min_bytes and live_size < old_size * args.ratio:
            state = "LIVE-LOOKS-EMPTY"
        elif live_size >= args.min_bytes and old_size < live_size * args.ratio:
            state = "old-looks-stale"
        findings.append(
            {
                "volume": base,
                "live_bytes": live_size,
                "old_bytes": old_size,
                "state": state,
            }
        )

    bad = [
        f
        for f in findings
        if f["state"] == "LIVE-LOOKS-EMPTY"
        and not any(f["volume"].endswith(suffix) for suffix in SOFT)
    ]
    if args.json:
        print(json.dumps({"uuid": args.uuid, "findings": findings}, indent=1))
    else:
        for f in findings:
            live_mb = f["live_bytes"] / 1048576
            old_mb = f["old_bytes"] / 1048576
            soft = any(f["volume"].endswith(suffix) for suffix in SOFT)
            mark = "CRITICAL" if f["state"] == "LIVE-LOOKS-EMPTY" and not soft else "ok"
            if soft and f["state"] == "LIVE-LOOKS-EMPTY":
                mark = "warn"
            print(
                f"{mark:9} {f['volume']:<16} live={live_mb:8.1f}M "
                f"sibling={old_mb:8.1f}M  {f['state']}"
            )
    if bad:
        print(
            f"CRITICAL: {len(bad)} live volume(s) look empty next to their sibling — "
            "the stack is probably running on the wrong twin; see "
            "docs/operations.md → Repairing a stateful volume from its twin",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
